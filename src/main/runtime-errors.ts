import { appendFileSync } from 'node:fs'

export function appendRuntimeError(path: string, scope: 'private' | 'space', agentId: string, error: unknown): void {
  const details = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const name = error instanceof Error ? error.name : 'UnknownError'
  const safeNames = ['Error', 'TypeError', 'AbortError', 'AggregateError', 'JsonRpcResponseError', 'TransportClosedError']
  const code = details.code
  const status = details.status
  const safeCodes = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPROTO', 'ECONNABORTED']
  const record = {
    at: new Date().toISOString(),
    scope,
    agentId,
    errorType: safeNames.includes(name) ? name : 'UnknownError',
    ...(typeof code === 'number' || typeof code === 'string' && safeCodes.includes(code) ? { code } : {}),
    ...(typeof status === 'number' && status >= 100 && status <= 599 ? { status } : {}),
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}
