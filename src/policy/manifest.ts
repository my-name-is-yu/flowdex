import ts from "typescript";
import type { ParsedWorkflow, WorkflowManifest } from "../types.js";
import { canonicalClone } from "../util/canonical.js";
import { hashCanonical, sha256Bytes, stableStringify } from "../util/hash.js";
import { validateWorkflowBody } from "./bodyPolicy.js";

const BODY_POLICY_VERSION = "flowdex-body-policy-v0.4.4";
const SNAPSHOT_POLICY_VERSION = "flowdex-snapshot-policy-v0.4.1";
const EVIDENCE_POLICY_VERSION = "flowdex-evidence-policy-v0.4";
const BUILT_IN_ADAPTERS = new Set(["codex-native"]);

export class ManifestError extends Error {
  constructor(message: string, readonly node?: ts.Node) {
    super(message);
    this.name = "ManifestError";
  }
}

export function parseWorkflowSource(sourceText: string, fileName = "workflow.ts"): ParsedWorkflow {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = source.statements.filter((statement) => statement.kind !== ts.SyntaxKind.NotEmittedStatement);
  if (statements.length !== 2) {
    throw new ManifestError("workflow source must contain exactly one import and one export default workflow call", source);
  }
  const [importStatement, exportStatement] = statements;
  if (!importStatement || !ts.isImportDeclaration(importStatement)) {
    throw new ManifestError("first statement must be the @flowdex/runtime import", importStatement);
  }
  validateRuntimeImport(importStatement);

  if (!exportStatement || !ts.isExportAssignment(exportStatement) || exportStatement.isExportEquals) {
    throw new ManifestError("second statement must be export default workflow(...)", exportStatement);
  }
  if (!ts.isCallExpression(exportStatement.expression)) {
    throw new ManifestError("export default expression must call workflow(...)", exportStatement.expression);
  }
  const call = exportStatement.expression;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "workflow") {
    throw new ManifestError("export default must call workflow(...)", call.expression);
  }
  if (call.arguments.length !== 2) {
    throw new ManifestError("workflow(...) must receive manifest and callback", call);
  }
  const [manifestNode, callbackNode] = call.arguments;
  if (!manifestNode || !ts.isObjectLiteralExpression(manifestNode)) {
    throw new ManifestError("workflow manifest must be a static object literal", manifestNode);
  }
  if (!callbackNode || !(ts.isArrowFunction(callbackNode) || ts.isFunctionExpression(callbackNode))) {
    throw new ManifestError("workflow callback must be an async function", callbackNode);
  }

  const manifest = canonicalClone(readStaticLiteral(manifestNode, source)) as unknown as WorkflowManifest;
  validateManifestShape(manifest);
  validateWorkflowBody(source, callbackNode);

  const sourceHash = sha256Bytes(sourceText);
  const manifestHash = hashCanonical(manifest);
  const approvalHash = sha256Bytes(
    stableStringify({
      sourceHash,
      manifestHash,
      bodyPolicyVersion: BODY_POLICY_VERSION,
      parserVersion: ts.version,
      transformVersion: ts.version,
      harnessVersion: "flowdex-harness-v0.4.4",
      runtimeVersion: "flowdex-runtime-v0.1.0",
      snapshotPolicyVersion: SNAPSHOT_POLICY_VERSION,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      permissionCapabilityPolicyHash: hashCanonical(manifest.permissions ?? {}),
      adapterPolicyHash: hashCanonical(manifest.adapters ?? {})
    })
  );

  const expressionText = exportStatement.expression.getText(source);
  const harnessInput = `function workflow(manifest, callback) { return { manifest, callback }; }\nconst __flowdexWorkflow = ${expressionText};\n`;
  const transformedJavaScript = ts.transpileModule(harnessInput, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
    }
  }).outputText;

  return { manifest, sourceHash, manifestHash, approvalHash, transformedJavaScript };
}

function validateRuntimeImport(node: ts.ImportDeclaration): void {
  if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "@flowdex/runtime") {
    throw new ManifestError("only @flowdex/runtime may be imported", node.moduleSpecifier);
  }
  const clause = node.importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    throw new ManifestError("runtime import must be named import { workflow }", node);
  }
  const imports = clause.namedBindings.elements;
  if (imports.length !== 1 || imports[0]?.name.text !== "workflow" || imports[0].propertyName) {
    throw new ManifestError("runtime import must be exactly { workflow }", node);
  }
}

function readStaticLiteral(node: ts.Expression, source: ts.SourceFile): unknown {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => {
      if (ts.isSpreadElement(element)) throw new ManifestError("manifest spread is rejected", element);
      return readStaticLiteral(element, source);
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    const output: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) throw new ManifestError("manifest supports only property assignments", property);
      const name = property.name;
      let key: string;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        key = name.text;
      } else {
        throw new ManifestError("manifest computed keys are rejected", name);
      }
      output[key] = readStaticLiteral(property.initializer, source);
    }
    return output;
  }
  throw new ManifestError(`manifest value is not a static JSON literal: ${node.getText(source)}`, node);
}

function validateManifestShape(manifest: WorkflowManifest): void {
  if (!manifest || typeof manifest !== "object") throw new ManifestError("manifest must be an object");
  if (typeof manifest.name !== "string" || manifest.name.length === 0) throw new ManifestError("manifest.name must be a non-empty string");
  if (!Number.isInteger(manifest.maxAgents) || manifest.maxAgents < 1) throw new ManifestError("manifest.maxAgents must be a positive integer");
  if (manifest.maxAgents > 1000) throw new ManifestError("manifest.maxAgents must be <= 1000");
  if (!Number.isInteger(manifest.maxConcurrency) || manifest.maxConcurrency < 1) throw new ManifestError("manifest.maxConcurrency must be a positive integer");
  if (manifest.maxConcurrency > 16) throw new ManifestError("manifest.maxConcurrency must be <= 16");
  validatePermissions(manifest);
  validateAdapters(manifest);
  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) throw new ManifestError("manifest.phases must be a non-empty array");
  const seen = new Set<string>();
  for (const phase of manifest.phases) {
    if (!phase || typeof phase.id !== "string" || !Number.isInteger(phase.maxAgents) || phase.maxAgents < 1) {
      throw new ManifestError("each manifest phase needs id and maxAgents");
    }
    if (seen.has(phase.id)) throw new ManifestError(`duplicate phase id: ${phase.id}`);
    seen.add(phase.id);
  }
}

function validatePermissions(manifest: WorkflowManifest): void {
  const permissions = manifest.permissions;
  if (!permissions || !Array.isArray(permissions.read) || !Array.isArray(permissions.write)) {
    throw new ManifestError("manifest.permissions.read/write arrays are required");
  }
  if (!permissions.read.every((item) => typeof item === "string") || !permissions.write.every((item) => typeof item === "string")) {
    throw new ManifestError("manifest.permissions.read/write entries must be strings");
  }
  if (
    permissions.network !== undefined &&
    permissions.network !== "none" &&
    permissions.network !== "web"
  ) {
    throw new ManifestError("manifest.permissions.network must be none or web");
  }
  if (permissions.env !== undefined) {
    if (!permissions.env || !Array.isArray(permissions.env.inherit) || !permissions.env.inherit.every((item) => typeof item === "string")) {
      throw new ManifestError("manifest.permissions.env.inherit must be a string array");
    }
  }
  if (permissions.hostCommands !== undefined) {
    if (!Array.isArray(permissions.hostCommands)) throw new ManifestError("manifest.permissions.hostCommands must be an array");
    const seen = new Set<string>();
    for (const command of permissions.hostCommands) validateHostCommand(command, seen);
  }
}

function validateHostCommand(command: unknown, seen: Set<string>): void {
  const spec = command as Partial<import("../types.js").HostCommandSpec>;
  if (!spec || typeof spec !== "object") throw new ManifestError("host command spec must be an object");
  if (!isSafeId(spec.id)) throw new ManifestError("host command id must be safe");
  if (seen.has(spec.id)) throw new ManifestError(`duplicate host command id: ${spec.id}`);
  seen.add(spec.id);
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv.every((item) => typeof item === "string" && item.length > 0)) {
    throw new ManifestError(`host command argv must be a non-empty string array: ${spec.id}`);
  }
  if (spec.cwd !== "project") throw new ManifestError(`host command cwd must be project: ${spec.id}`);
  if (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)) {
    throw new ManifestError(`host command timeoutMs must be a positive integer: ${spec.id}`);
  }
  if (spec.maxOutputBytes !== undefined && (!Number.isInteger(spec.maxOutputBytes) || spec.maxOutputBytes <= 0)) {
    throw new ManifestError(`host command maxOutputBytes must be a positive integer: ${spec.id}`);
  }
}

function validateAdapters(manifest: WorkflowManifest): void {
  if (manifest.defaultAdapter !== undefined && typeof manifest.defaultAdapter !== "string") {
    throw new ManifestError("manifest.defaultAdapter must be a string");
  }
  const adapters = manifest.adapters ?? {};
  for (const [name, adapter] of Object.entries(adapters)) {
    if (!name || typeof name !== "string") throw new ManifestError("adapter names must be non-empty strings");
    if (!adapter || typeof adapter !== "object") throw new ManifestError(`adapter config must be an object: ${name}`);
    if (!BUILT_IN_ADAPTERS.has(adapter.type)) throw new ManifestError(`unknown adapter type for ${name}: ${String(adapter.type)}`);
    if (adapter.model !== undefined && typeof adapter.model !== "string") throw new ManifestError(`adapter.model must be a string: ${name}`);
    if (adapter.reasoningEffort !== undefined && typeof adapter.reasoningEffort !== "string") {
      throw new ManifestError(`adapter.reasoningEffort must be a string: ${name}`);
    }
  }
  if (manifest.defaultAdapter && !BUILT_IN_ADAPTERS.has(manifest.defaultAdapter) && !(manifest.defaultAdapter in adapters)) {
    throw new ManifestError(`manifest.defaultAdapter references unknown adapter: ${manifest.defaultAdapter}`);
  }
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(value);
}
