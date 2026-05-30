export function readReportPath(report: unknown, expression: string): unknown {
  const parts = expression.split(".").filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error("--path must not be empty");
  let current = report;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) throw new Error(`report path segment is not an array index: ${part}`);
      const index = Number(part);
      if (index >= current.length) throw new Error(`report path not found: ${expression}`);
      current = current[index];
    } else if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new Error(`report path not found: ${expression}`);
    }
  }
  return current;
}
