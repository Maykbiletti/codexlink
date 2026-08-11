function normalizedField(entry, ...names) {
  for (const name of names) {
    const value = String(entry?.[name] || "").trim().toLowerCase();
    if (value) {
      return value;
    }
  }
  return "";
}

export function diagnosticSmokeKind(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const scope = normalizedField(entry, "scope", "testScope", "test_scope");
  if (["health-smoke", "health_smoke", "transport-smoke", "transport_smoke", "manualtest", "manual-test"].includes(scope)) {
    return scope.replace(/_/g, "-");
  }

  const text = normalizedField(entry, "sourceText", "source_text", "text");
  if (/^\s*\[(?:health[\s_-]*smoke|botdoctor[\s_-]*smoke|manual[\s_-]*test|manualtest)\]/i.test(text)) {
    return text.includes("health") ? "health-smoke" : (text.includes("botdoctor") ? "botdoctor-smoke" : "manualtest");
  }
  if (/^\s*(?:health[\s_-]*smoke|manual[\s_-]*test|manualtest)(?:\b|\s*[:#-])/i.test(text)) {
    return text.startsWith("health") ? "health-smoke" : "manualtest";
  }
  if (text.includes("transport-smoke") && (
    text.includes("keine antwort")
    || text.includes("no reply")
    || text.includes("stiller inject-test")
    || text.includes("stiller transporttest")
  )) {
    return "transport-smoke";
  }
  return "";
}

export function isDiagnosticSmokeEntry(entry) {
  return Boolean(diagnosticSmokeKind(entry));
}
