import type { ModelProviderId } from './contracts'

export type ModelProviderDefinition = {
  id: Exclude<ModelProviderId, 'custom'>
  name: string
  description: string
  environmentKey: string
  apiKeyExample: string
  apiKeyHint: string
  minLength: number
  maxLength: number
  prefix: string
}

export const MODEL_PROVIDER_DEFINITIONS: ModelProviderDefinition[] = [
  {
    id: 'deepseek-official', name: 'DeepSeek', description: 'DeepSeek 官方 API',
    environmentKey: 'DEEPSEEK_API_KEY', apiKeyExample: 'sk-0123456789abcdefghijklmnopqrstuv',
    apiKeyHint: '以 sk- 开头，完整长度 27-67 位', minLength: 27, maxLength: 67, prefix: 'sk-',
  },
  {
    id: 'moonshotai-cn', name: 'Kimi', description: 'Moonshot AI 开放平台',
    environmentKey: 'MOONSHOT_API_KEY', apiKeyExample: 'sk-0123456789abcdef0123456789abcdef',
    apiKeyHint: '通常以 sk- 开头，请粘贴开放平台生成的完整密钥', minLength: 20, maxLength: 200, prefix: 'sk-',
  },
  {
    id: 'openai', name: 'OpenAI', description: 'ChatGPT 模型 API',
    environmentKey: 'OPENAI_API_KEY', apiKeyExample: 'sk-proj-0123456789abcdef0123456789abcdef',
    apiKeyHint: '通常以 sk- 或 sk-proj- 开头', minLength: 20, maxLength: 200, prefix: 'sk-',
  },
  {
    id: 'anthropic', name: 'Anthropic', description: 'Claude / Claude Code 模型 API',
    environmentKey: 'ANTHROPIC_API_KEY', apiKeyExample: 'sk-ant-api03-0123456789abcdef0123456789abcdef',
    apiKeyHint: '以 sk-ant- 开头，请粘贴 Anthropic Console 生成的完整密钥', minLength: 30, maxLength: 200, prefix: 'sk-ant-',
  },
]

export const MODEL_CATALOG = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'deepseek-official', id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
  { provider: 'moonshotai-cn', id: 'kimi-k2.5', name: 'Kimi K2.5' },
  { provider: 'moonshotai-cn', id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
  { provider: 'openai', id: 'gpt-5.2', name: 'GPT-5.2' },
  { provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1' },
  { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
]

export function getModelProviderDefinition(id: string): ModelProviderDefinition | undefined {
  return MODEL_PROVIDER_DEFINITIONS.find((provider) => provider.id === id)
}

export function getModelProviderApiKeyError(id: ModelProviderId, value: string): string | null {
  const apiKey = value.trim()
  if (!apiKey) return '请输入 API Key'
  if (id === 'custom') {
    if (apiKey.length < 8 || apiKey.length > 300) return 'API Key 长度应为 8-300 个字符'
    if (/\s/.test(apiKey)) return 'API Key 中不能包含空格'
    return null
  }

  const provider = getModelProviderDefinition(id)
  if (!provider) return '不支持的模型服务商'
  if (!apiKey.startsWith(provider.prefix)) return `${provider.name} API Key 必须以 ${provider.prefix} 开头`
  if (apiKey.length < provider.minLength || apiKey.length > provider.maxLength) {
    return `完整长度应为 ${provider.minLength}-${provider.maxLength} 个字符，当前 ${apiKey.length} 个`
  }
  if (!/^[A-Za-z0-9_-]+$/.test(apiKey)) return 'API Key 仅支持字母、数字、短横线和下划线'
  return null
}
