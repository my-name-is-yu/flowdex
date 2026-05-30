import ts from "typescript";

export class BodyPolicyError extends Error {
  constructor(message: string, readonly node?: ts.Node) {
    super(message);
    this.name = "BodyPolicyError";
  }
}

interface Scope {
  parent?: Scope;
  names: Set<string>;
  helpers: Set<string>;
}

interface VisitContext {
  source: ts.SourceFile;
  outer: ts.ArrowFunction | ts.FunctionExpression;
  functionDepth: number;
  allowedCallback: boolean;
}

const allowedBuiltins = new Set(["JSON", "Object", "Array", "String", "Number", "Boolean", "Math"]);
const reservedBindings = new Set(["ctx", ...allowedBuiltins]);
const allowedCtxCalls = new Set([
  "agent",
  "fanout",
  "hostCommand",
  "integrate",
  "claim",
  "artifact",
  "report",
  "now",
  "isFlowdexPending"
]);
const durableCalls = new Set(["agent", "fanout", "hostCommand", "integrate"]);
const sideEffectCalls = new Set(["claim", "artifact", "report"]);
const allowedJsonCalls = new Set(["stringify", "parse"]);
const allowedObjectCalls = new Set(["keys", "values", "entries"]);
const allowedArrayCalls = new Set(["isArray"]);
const allowedMathCalls = new Set(["abs", "ceil", "floor", "max", "min", "round", "trunc"]);
const allowedReceiverMethods = new Set([
  "includes",
  "indexOf",
  "join",
  "slice",
  "concat",
  "at",
  "startsWith",
  "endsWith",
  "substring",
  "split",
  "trim",
  "toLowerCase",
  "toUpperCase"
]);
const callbackReceiverMethods = new Set(["map", "filter", "flatMap", "reduce", "some", "every", "find"]);
const bannedPropertyNames = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__"
]);
const forbiddenIdentifiers = new Set([
  "Promise",
  "Error",
  "Symbol",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "BigInt",
  "Reflect",
  "Proxy",
  "Intl",
  "Temporal",
  "Atomics",
  "SharedArrayBuffer",
  "Buffer",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "console",
  "globalThis",
  "Deno",
  "process",
  "require",
  "module",
  "window",
  "self",
  "document",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "navigator",
  "localStorage",
  "sessionStorage",
  "performance",
  "Date",
  "crypto",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "WebAssembly",
  "Worker",
  "SharedWorker"
]);

export function validateWorkflowBody(source: ts.SourceFile, workflowFunction: ts.ArrowFunction | ts.FunctionExpression): void {
  if (!ts.isBlock(workflowFunction.body)) {
    throw new BodyPolicyError("workflow body must be a block", workflowFunction.body);
  }
  if (!hasAsyncModifier(workflowFunction)) {
    throw new BodyPolicyError("outer workflow function must be async", workflowFunction);
  }
  if (workflowFunction.parameters.length !== 1 || workflowFunction.parameters[0]?.name.getText(source) !== "ctx") {
    throw new BodyPolicyError("workflow function must have exactly one ctx parameter", workflowFunction);
  }

  const root: Scope = {
    names: new Set(["ctx", ...allowedBuiltins]),
    helpers: new Set()
  };
  for (const statement of workflowFunction.body.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (reservedBindings.has(statement.name.text)) throw new BodyPolicyError(`reserved binding cannot be redefined: ${statement.name.text}`, statement.name);
      root.names.add(statement.name.text);
      root.helpers.add(statement.name.text);
    }
  }

  const context: VisitContext = { source, outer: workflowFunction, functionDepth: 0, allowedCallback: false };
  for (const statement of workflowFunction.body.statements) {
    visitStatement(statement, root, context);
  }
}

function hasAsyncModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function hasGeneratorAsterisk(node: ts.FunctionLikeDeclarationBase): boolean {
  return !!node.asteriskToken;
}

function childScope(scope: Scope): Scope {
  return { parent: scope, names: new Set(), helpers: scope.helpers };
}

function hasName(scope: Scope, name: string): boolean {
  if (scope.names.has(name)) return true;
  return scope.parent ? hasName(scope.parent, name) : false;
}

function addBinding(scope: Scope, name: ts.BindingName, context: VisitContext): void {
  if (ts.isIdentifier(name)) {
    if (reservedBindings.has(name.text)) throw new BodyPolicyError(`reserved binding cannot be redefined: ${name.text}`, name);
    scope.names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element)) {
      if (element.propertyName) validateBindingPropertyName(element.propertyName, scope, context);
      if (element.initializer) visitExpression(element.initializer, scope, context);
      addBinding(scope, element.name, context);
    }
  }
}

function visitStatement(node: ts.Statement, scope: Scope, context: VisitContext): void {
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (declaration.initializer) {
        visitExpression(declaration.initializer, scope, context);
      }
      addBinding(scope, declaration.name, context);
    }
    return;
  }

  if (ts.isFunctionDeclaration(node)) {
    validateHelper(node, scope, context);
    return;
  }

  if (ts.isExpressionStatement(node)) {
    visitExpression(node.expression, scope, context);
    return;
  }

  if (ts.isReturnStatement(node)) {
    if (node.expression) visitExpression(node.expression, scope, context);
    return;
  }

  if (ts.isIfStatement(node)) {
    visitExpression(node.expression, scope, context);
    visitStatement(node.thenStatement, childScope(scope), context);
    if (node.elseStatement) visitStatement(node.elseStatement, childScope(scope), context);
    return;
  }

  if (ts.isBlock(node)) {
    const blockScope = childScope(scope);
    for (const statement of node.statements) visitStatement(statement, blockScope, context);
    return;
  }

  if (ts.isForOfStatement(node)) {
    if (node.awaitModifier) throw new BodyPolicyError("for await is rejected", node);
    const loopScope = childScope(scope);
    if (ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) addBinding(loopScope, declaration.name, context);
    } else {
      visitExpression(node.initializer, scope, context);
    }
    visitExpression(node.expression, scope, context);
    visitStatement(node.statement, loopScope, context);
    return;
  }

  if (ts.isForStatement(node)) {
    const loopScope = childScope(scope);
    if (node.initializer) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          if (declaration.initializer) visitExpression(declaration.initializer, loopScope, context);
          addBinding(loopScope, declaration.name, context);
        }
      } else {
        visitExpression(node.initializer, loopScope, context);
      }
    }
    if (node.condition) visitExpression(node.condition, loopScope, context);
    if (node.incrementor) visitExpression(node.incrementor, loopScope, context);
    visitStatement(node.statement, loopScope, context);
    return;
  }

  if (ts.isTryStatement(node)) {
    if (containsDurableCall(node.tryBlock)) {
      throw new BodyPolicyError("try/catch around durable operations is rejected in MVP", node);
    }
    visitStatement(node.tryBlock, childScope(scope), context);
    if (node.catchClause) visitStatement(node.catchClause.block, childScope(scope), context);
    if (node.finallyBlock) visitStatement(node.finallyBlock, childScope(scope), context);
    return;
  }

  throw new BodyPolicyError(`unsupported statement: ${ts.SyntaxKind[node.kind]}`, node);
}

function visitExpression(node: ts.Expression, scope: Scope, context: VisitContext): void {
  if (ts.isIdentifier(node)) {
    validateIdentifierReference(node, scope);
    return;
  }

  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
    return;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) throw new BodyPolicyError("object spread is rejected", property);
      if (ts.isGetAccessor(property) || ts.isSetAccessor(property)) throw new BodyPolicyError("getters/setters are rejected", property);
      if (ts.isPropertyAssignment(property)) {
        validatePropertyName(property.name);
        visitExpression(property.initializer, scope, context);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        validateIdentifierReference(property.name, scope);
        continue;
      }
      throw new BodyPolicyError("unsupported object literal property", property);
    }
    return;
  }

  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) throw new BodyPolicyError("array spread is rejected", element);
      visitExpression(element, scope, context);
    }
    return;
  }

  if (ts.isParenthesizedExpression(node)) {
    visitExpression(node.expression, scope, context);
    return;
  }

  if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) visitExpression(span.expression, scope, context);
    }
    return;
  }

  if (ts.isPropertyAccessExpression(node)) {
    validatePropertyAccess(node, scope, context);
    return;
  }

  if (ts.isElementAccessExpression(node)) {
    validateElementAccess(node, scope, context);
    return;
  }

  if (ts.isCallExpression(node)) {
    validateCallExpression(node, scope, context);
    return;
  }

  if (ts.isAwaitExpression(node)) {
    validateAwait(node, scope, context);
    return;
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (!context.allowedCallback) {
      throw new BodyPolicyError("function values are rejected outside allowed callbacks", node);
    }
    validateCallback(node, scope, context);
    return;
  }

  if (ts.isBinaryExpression(node)) {
    if (isAssignmentOperator(node.operatorToken.kind)) {
      validateAssignmentTarget(node.left, scope, context);
      visitExpression(node.right, scope, context);
      return;
    }
    visitExpression(node.left, scope, context);
    visitExpression(node.right, scope, context);
    return;
  }

  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
      validateAssignmentTarget(node.operand, scope, context);
      return;
    }
    visitExpression(node.operand, scope, context);
    return;
  }

  if (ts.isPostfixUnaryExpression(node)) {
    validateAssignmentTarget(node.operand, scope, context);
    return;
  }

  if (ts.isDeleteExpression(node)) {
    throw new BodyPolicyError("delete expressions are rejected", node);
  }

  if (ts.isVoidExpression(node) || ts.isTypeOfExpression(node)) {
    visitExpression(node.expression, scope, context);
    return;
  }

  if (ts.isConditionalExpression(node)) {
    visitExpression(node.condition, scope, context);
    visitExpression(node.whenTrue, scope, context);
    visitExpression(node.whenFalse, scope, context);
    return;
  }

  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    visitExpression(node.expression, scope, context);
    return;
  }

  if (ts.isNewExpression(node) || ts.isClassExpression(node) || ts.isYieldExpression(node)) {
    throw new BodyPolicyError(`${ts.SyntaxKind[node.kind]} is rejected`, node);
  }

  throw new BodyPolicyError(`unsupported expression: ${ts.SyntaxKind[node.kind]}`, node);
}

function validateIdentifierReference(node: ts.Identifier, scope: Scope): void {
  const name = node.text;
  if (forbiddenIdentifiers.has(name)) throw new BodyPolicyError(`forbidden identifier: ${name}`, node);
  if (!hasName(scope, name)) throw new BodyPolicyError(`undefined or non-allowlisted identifier: ${name}`, node);
  if (scope.helpers.has(name)) throw new BodyPolicyError(`helper function value cannot escape: ${name}`, node);
}

function validatePropertyName(name: ts.PropertyName): void {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    if (bannedPropertyNames.has(name.text)) throw new BodyPolicyError(`banned property name: ${name.text}`, name);
    return;
  }
  throw new BodyPolicyError("computed property names are rejected", name);
}

function validateAssignmentTarget(node: ts.Node, scope: Scope, context: VisitContext): void {
  if (ts.isIdentifier(node)) {
    if (reservedBindings.has(node.text)) throw new BodyPolicyError(`protected binding cannot be assigned: ${node.text}`, node);
    validateIdentifierReference(node, scope);
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    validateAssignmentTarget(node.expression, scope, context);
    return;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    visitExpression(node.expression, scope, context);
    throw new BodyPolicyError("property assignment targets are rejected", node);
  }
  throw new BodyPolicyError("unsupported assignment target", node);
}

function validateBindingPropertyName(name: ts.PropertyName, scope: Scope, context: VisitContext): void {
  if (ts.isComputedPropertyName(name)) {
    visitExpression(name.expression, scope, context);
    throw new BodyPolicyError("computed binding property names are rejected", name);
  }
  validatePropertyName(name);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function validatePropertyAccess(node: ts.PropertyAccessExpression, scope: Scope, context: VisitContext): void {
  if (node.questionDotToken) throw new BodyPolicyError("optional chaining calls/access are rejected", node);
  const name = node.name.text;
  if (bannedPropertyNames.has(name)) throw new BodyPolicyError(`banned property access: ${name}`, node.name);

  if (ts.isIdentifier(node.expression) && node.expression.text === "ctx") {
    if (name === "input" || name === "pendingSignal") return;
    if (allowedCtxCalls.has(name)) throw new BodyPolicyError(`ctx method values cannot be read directly: ${name}`, node.name);
    throw new BodyPolicyError(`unsupported ctx property: ${name}`, node.name);
  }

  if (ts.isIdentifier(node.expression) && allowedBuiltins.has(node.expression.text)) {
    return;
  }

  visitExpression(node.expression, scope, context);
}

function validateElementAccess(node: ts.ElementAccessExpression, scope: Scope, context: VisitContext): void {
  if (node.questionDotToken) throw new BodyPolicyError("optional element access is rejected", node);
  if (!node.argumentExpression) throw new BodyPolicyError("computed property access is rejected", node);
  if (!ts.isNumericLiteral(node.argumentExpression)) {
    throw new BodyPolicyError("computed property access is rejected", node.argumentExpression);
  }
  visitExpression(node.expression, scope, context);
}

function validateCallExpression(node: ts.CallExpression, scope: Scope, context: VisitContext): void {
  if (node.questionDotToken) throw new BodyPolicyError("optional calls are rejected", node);

  if (ts.isPropertyAccessExpression(node.expression)) {
    const object = node.expression.expression;
    const method = node.expression.name.text;
    if (bannedPropertyNames.has(method)) throw new BodyPolicyError(`banned method: ${method}`, node.expression.name);

    if (ts.isIdentifier(object) && object.text === "ctx") {
      if (!allowedCtxCalls.has(method)) throw new BodyPolicyError(`unsupported ctx call: ${method}`, node.expression.name);
      if ((durableCalls.has(method) || sideEffectCalls.has(method)) && context.functionDepth > 0) {
        throw new BodyPolicyError("ctx side effects are rejected inside helpers/callbacks", node);
      }
      if (durableCalls.has(method) && !isDirectlyAwaited(node)) {
        throw new BodyPolicyError("durable ctx calls must be directly awaited", node);
      }
      visitArguments(node, scope, context);
      return;
    }

    if (ts.isIdentifier(object)) {
      if (object.text === "JSON" && allowedJsonCalls.has(method)) {
        visitArguments(node, scope, context);
        return;
      }
      if (object.text === "Object" && allowedObjectCalls.has(method)) {
        visitArguments(node, scope, context);
        return;
      }
      if (object.text === "Array" && allowedArrayCalls.has(method)) {
        visitArguments(node, scope, context);
        return;
      }
      if (object.text === "Math" && allowedMathCalls.has(method)) {
        visitArguments(node, scope, context);
        return;
      }
    }

    if (callbackReceiverMethods.has(method)) {
      visitExpression(object, scope, context);
      visitReceiverCallbackArguments(node, scope, context);
      return;
    }

    if (allowedReceiverMethods.has(method)) {
      visitExpression(object, scope, context);
      visitArguments(node, scope, context);
      return;
    }
  }

  if (ts.isIdentifier(node.expression)) {
    const callee = node.expression.text;
    if (callee === "String" || callee === "Number" || callee === "Boolean") {
      visitArguments(node, scope, context);
      return;
    }
    if (scope.helpers.has(callee)) {
      visitArguments(node, scope, context);
      return;
    }
    throw new BodyPolicyError(`unsupported call target: ${callee}`, node.expression);
  }

  throw new BodyPolicyError("call target is not in the closed-world allowlist", node.expression);
}

function visitArguments(node: ts.CallExpression, scope: Scope, context: VisitContext): void {
  for (const argument of node.arguments) {
    visitExpression(argument, scope, context);
  }
}

function visitReceiverCallbackArguments(node: ts.CallExpression, scope: Scope, context: VisitContext): void {
  const [callback, ...rest] = node.arguments;
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    throw new BodyPolicyError("receiver callback must be an inline function", node);
  }
  visitExpression(callback, scope, { ...context, allowedCallback: true });
  for (const argument of rest) visitExpression(argument, scope, context);
}

function validateAwait(node: ts.AwaitExpression, scope: Scope, context: VisitContext): void {
  if (context.functionDepth !== 0) throw new BodyPolicyError("await is only allowed in the top-level workflow body", node);
  if (!ts.isCallExpression(node.expression) || !ts.isPropertyAccessExpression(node.expression.expression)) {
    throw new BodyPolicyError("await expression must be a direct durable ctx call", node);
  }
  const object = node.expression.expression.expression;
  const method = node.expression.expression.name.text;
  if (!ts.isIdentifier(object) || object.text !== "ctx" || !durableCalls.has(method)) {
    throw new BodyPolicyError("await expression must be a direct durable ctx call", node);
  }
  validateCallExpression(node.expression, scope, context);
}

function isDirectlyAwaited(node: ts.CallExpression): boolean {
  return ts.isAwaitExpression(node.parent) && node.parent.expression === node;
}

function validateHelper(node: ts.FunctionDeclaration, scope: Scope, context: VisitContext): void {
  if (!node.name) throw new BodyPolicyError("anonymous helper is rejected", node);
  if (hasAsyncModifier(node)) throw new BodyPolicyError("async helpers are rejected", node);
  if (hasGeneratorAsterisk(node)) throw new BodyPolicyError("generator helpers are rejected", node);
  if (!node.body) throw new BodyPolicyError("helper body is required", node);
  const helperScope = childScope(scope);
  const helperContext = { ...context, functionDepth: context.functionDepth + 1 };
  addParameterBindings(node.parameters, helperScope, helperContext);
  for (const statement of node.body.statements) visitStatement(statement, helperScope, helperContext);
}

function validateCallback(node: ts.ArrowFunction | ts.FunctionExpression, scope: Scope, context: VisitContext): void {
  if (hasAsyncModifier(node)) throw new BodyPolicyError("async callbacks are rejected", node);
  if (hasGeneratorAsterisk(node)) throw new BodyPolicyError("generator callbacks are rejected", node);
  const callbackScope = childScope(scope);
  const callbackContext = { ...context, functionDepth: context.functionDepth + 1, allowedCallback: false };
  addParameterBindings(node.parameters, callbackScope, callbackContext);
  if (ts.isBlock(node.body)) {
    for (const statement of node.body.statements) visitStatement(statement, callbackScope, callbackContext);
  } else {
    visitExpression(node.body, callbackScope, callbackContext);
  }
}

function addParameterBindings(parameters: ts.NodeArray<ts.ParameterDeclaration>, scope: Scope, context: VisitContext): void {
  for (const parameter of parameters) {
    if (parameter.initializer) visitExpression(parameter.initializer, scope, context);
    addBinding(scope, parameter.name, context);
  }
}

function containsDurableCall(node: ts.Node): boolean {
  let found = false;
  const scan = (current: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "ctx" &&
      durableCalls.has(current.expression.name.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, scan);
  };
  scan(node);
  return found;
}
