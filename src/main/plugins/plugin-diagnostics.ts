/** Diagnostic text only: never sanitize protocol/configuration data returned to callers. */
export function redactPluginDiagnostic(value: unknown, secrets: readonly string[] = []): string {
  let text = String(value)
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, '[REDACTED]')
  }
  return text
    .replace(/(\bbearer\s+)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(
      /((?:["']?)(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      '$1"[REDACTED]"'
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
}
