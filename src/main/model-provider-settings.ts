import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import type { ModelProviderId, ModelProviderStatus, SaveModelProviderInput } from '../shared/contracts'
import {
  getModelProviderApiKeyError, getModelProviderDefinition, MODEL_PROVIDER_DEFINITIONS,
} from '../shared/model-providers'

const providerIdSchema = z.enum([
  'deepseek-official', 'moonshotai-cn', 'openai', 'anthropic', 'minimax', 'zhipu', 'qwen', 'stepfun', 'custom',
])
const savedProviderSchema = z.object({
  apiKey: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().trim().min(1).optional(),
})
const storedSettingsSchema = z.object({
  version: z.literal(2),
  providers: z.record(providerIdSchema, savedProviderSchema),
})
const legacySettingsSchema = z.object({ deepseekApiKey: z.string().min(1) })

type SavedProvider = z.infer<typeof savedProviderSchema>
type StoredSettings = z.infer<typeof storedSettingsSchema>

export type ModelProviderRuntimeConfig = {
  id: ModelProviderId
  apiKey: string
  name: string
  baseUrl?: string
  model?: string
}

export class ModelProviderSettings {
  constructor(private readonly path: string) {}

  statuses(): ModelProviderStatus[] {
    const stored = this.readStoredSettings()
    const standard = MODEL_PROVIDER_DEFINITIONS.map((provider) => {
      const source = this.canDecrypt(stored.providers[provider.id]?.apiKey)
        ? 'saved' as const
        : process.env[provider.environmentKey]
          ? 'environment' as const
          : null
      return {
        id: provider.id,
        name: provider.name,
        description: provider.description,
        configured: source !== null,
        source,
      }
    })
    const custom = this.canDecrypt(stored.providers.custom?.apiKey) ? stored.providers.custom : undefined
    const statuses: ModelProviderStatus[] = custom
      ? [...standard, {
          id: 'custom' as const,
          name: custom.name ?? '自定义服务',
          description: custom.baseUrl ?? 'OpenAI 兼容接口',
          configured: true,
          source: 'saved' as const,
          baseUrl: custom.baseUrl,
          model: custom.model,
        }]
      : standard
    const savedOrder = new Map(Object.keys(stored.providers).map((id, index) => [id, index]))
    return statuses.sort((left, right) => {
      if (left.configured !== right.configured) return left.configured ? -1 : 1
      if (!left.configured) return 0
      return (savedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (savedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    })
  }

  getProvider(id: string): ModelProviderRuntimeConfig | undefined {
    const parsedId = providerIdSchema.safeParse(id)
    if (!parsedId.success) return undefined
    const stored = this.readStoredSettings().providers[parsedId.data]
    if (stored) {
      try {
        return {
          id: parsedId.data,
          apiKey: this.decrypt(stored.apiKey),
          name: stored.name ?? getModelProviderDefinition(parsedId.data)?.name ?? '自定义服务',
          baseUrl: stored.baseUrl,
          model: stored.model,
        }
      } catch {
        // A damaged saved secret should not prevent an environment key from working.
      }
    }
    const definition = getModelProviderDefinition(parsedId.data)
    const apiKey = definition ? process.env[definition.environmentKey] : undefined
    return apiKey ? { id: parsedId.data, apiKey, name: definition?.name ?? parsedId.data } : undefined
  }

  configuredProviders(): ModelProviderRuntimeConfig[] {
    return this.statuses().flatMap((status) => {
      const provider = this.getProvider(status.id)
      return provider ? [provider] : []
    })
  }

  save(input: SaveModelProviderInput): ModelProviderStatus[] {
    const id = providerIdSchema.parse(input.id)
    const apiKey = input.apiKey.trim()
    const error = getModelProviderApiKeyError(id, apiKey)
    if (error) throw new Error(error)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存 API Key')

    let metadata: Omit<SavedProvider, 'apiKey'> = {}
    if (id === 'custom') {
      metadata = z.object({
        name: z.string().trim().min(1, '请输入服务名称').max(50, '服务名称不能超过 50 个字符'),
        baseUrl: z.string().trim().url('请输入完整有效的 API Base URL')
          .refine((value) => /^https?:\/\//.test(value), 'API Base URL 必须以 http:// 或 https:// 开头'),
        model: z.string().trim().min(1, '请输入模型 ID').max(100, '模型 ID 不能超过 100 个字符'),
      }).parse(input)
    }

    const current = this.readStoredSettings()
    current.providers[id] = {
      ...metadata,
      apiKey: safeStorage.encryptString(apiKey).toString('base64'),
    }
    this.writeStoredSettings(current)
    return this.statuses()
  }

  remove(id: ModelProviderId): ModelProviderStatus[] {
    const parsedId = providerIdSchema.parse(id)
    const current = this.readStoredSettings()
    delete current.providers[parsedId]
    if (Object.keys(current.providers).length === 0) rmSync(this.path, { force: true })
    else this.writeStoredSettings(current)
    return this.statuses()
  }

  private writeStoredSettings(settings: StoredSettings): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(settings), { mode: 0o600 })
  }

  private readStoredSettings(): StoredSettings {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      const current = storedSettingsSchema.safeParse(value)
      if (current.success) return current.data
      const legacy = legacySettingsSchema.safeParse(value)
      if (legacy.success) {
        return {
          version: 2,
          providers: { 'deepseek-official': { apiKey: legacy.data.deepseekApiKey } },
        }
      }
    } catch {
      // Missing or malformed settings are treated as an empty local configuration.
    }
    return { version: 2, providers: {} }
  }

  private decrypt(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private canDecrypt(value?: string): boolean {
    if (!value) return false
    try {
      return this.decrypt(value).length > 0
    } catch {
      return false
    }
  }
}
