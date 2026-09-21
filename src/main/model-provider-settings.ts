import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import type { ModelProviderStatus } from '../shared/contracts'

const apiKeySchema = z.string().trim().min(8, 'API Key 至少需要 8 个字符').max(4096)
const storedSettingsSchema = z.object({ deepseekApiKey: z.string().min(1) })

export class ModelProviderSettings {
  constructor(private readonly path: string) {}

  status(): ModelProviderStatus {
    const source = this.readSavedApiKey() ? 'saved' : process.env.DEEPSEEK_API_KEY ? 'environment' : null
    return { id: 'deepseek-official', name: 'DeepSeek', configured: source !== null, source }
  }

  getApiKey(): string | undefined {
    return this.readSavedApiKey() ?? process.env.DEEPSEEK_API_KEY
  }

  saveApiKey(value: string): ModelProviderStatus {
    const apiKey = apiKeySchema.parse(value)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存 API Key')
    mkdirSync(dirname(this.path), { recursive: true })
    const encrypted = safeStorage.encryptString(apiKey).toString('base64')
    writeFileSync(this.path, JSON.stringify({ deepseekApiKey: encrypted }), { mode: 0o600 })
    return this.status()
  }

  removeApiKey(): ModelProviderStatus {
    rmSync(this.path, { force: true })
    return this.status()
  }

  private readSavedApiKey(): string | undefined {
    try {
      const stored = storedSettingsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      return safeStorage.decryptString(Buffer.from(stored.deepseekApiKey, 'base64'))
    } catch {
      return undefined
    }
  }
}
