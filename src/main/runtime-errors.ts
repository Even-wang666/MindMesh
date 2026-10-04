import { appendFileSync } from 'node:fs'

export type RuntimeFailureKind =
  | 'materialization'
  | 'startup'
  | 'transport-closed'
  | 'protocol'
  | 'request-timeout'
  | 'profile-invalid'
  | 'plugin-incompatible'
  | 'provider'
  | 'unknown'

export class RuntimeFailure extends Error {
  constructor(
    readonly kind: RuntimeFailureKind,
    cause?: unknown
  ) {
    super(`Runtime failure: ${kind}`, { cause })
    this.name = 'RuntimeFailure'
  }
}

export function classifyRuntimeFailure(error: unknown): RuntimeFailureKind {
  if (error instanceof RuntimeFailure) return error.kind
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  if (value.name === 'TransportClosedError') return 'transport-closed'
  if (value.name === 'RequestTimeoutError' || value.code === 'ETIMEDOUT') return 'request-timeout'
  if (value.name === 'SyntaxError' || value.name === 'SdkProtocolError' || value.code === 'EPROTO')
    return 'protocol'
  if (typeof value.status === 'number' && value.status >= 400 && value.status <= 599)
    return 'provider'
  if (value.name === 'JsonRpcResponseError') return 'provider'
  return 'unknown'
}

export function runtimeFailureDetail(kind: RuntimeFailureKind): string {
  const details: Record<RuntimeFailureKind, string> = {
    materialization:
      '运行配置准备失败，请检查所选技能、扩展和本地文件后重试；也可切换为仅对话或工作目录权限。',
    startup: '模型运行服务启动失败，请检查模型服务配置后重试。',
    'transport-closed': '模型连接已中断，请重试；若持续失败，请重新启动应用。',
    protocol: '模型连接返回了无效响应，请重试；若持续失败，请重新启动应用。',
    'request-timeout': '模型请求超时，请检查网络后重试。',
    'profile-invalid': '运行配置无效，请检查所选能力后重试。',
    'plugin-incompatible': '所选扩展不兼容，请检查扩展配置后重试。',
    provider: '模型服务返回错误，请检查凭据、额度或服务配置后重试。',
    unknown: '模型回复失败，请检查模型服务配置或网络后重试。',
  }
  return details[kind]
}

export function appendRuntimeError(
  path: string,
  scope: 'private' | 'space',
  agentId: string,
  error: unknown
): void {
  const details = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const name = error instanceof Error ? error.name : 'UnknownError'
  // Deliberate allowlists: unknown SDK identifiers stay redacted. Review their safety before
  // adding new error names or codes when SDK error types change.
  const safeNames = [
    'Error',
    'TypeError',
    'AbortError',
    'AggregateError',
    'JsonRpcResponseError',
    'TransportClosedError',
  ]
  const code = details.code
  const status = details.status
  const safeCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPROTO',
    'ECONNABORTED',
  ]
  const record = {
    at: new Date().toISOString(),
    scope,
    agentId,
    errorType: safeNames.includes(name) ? name : 'UnknownError',
    kind: classifyRuntimeFailure(error),
    ...(typeof code === 'number' || (typeof code === 'string' && safeCodes.includes(code))
      ? { code }
      : {}),
    ...(typeof status === 'number' && status >= 100 && status <= 599 ? { status } : {}),
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}
