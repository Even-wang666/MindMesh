import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))

import { ModelProviderSettings } from '../src/main/model-provider-settings'

const directories: string[] = []
const validApiKey = 'sk-0123456789abcdefghijklmnopqrstuv'

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

function createSettings(): { settings: ModelProviderSettings; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'mindmesh-settings-'))
  directories.push(directory)
  const path = join(directory, 'model-services.json')
  return { settings: new ModelProviderSettings(path), path }
}

describe('ModelProviderSettings', () => {
  it('encrypts a saved API key and never returns it in status', () => {
    const { settings, path } = createSettings()
    const status = settings.saveApiKey(validApiKey)

    expect(status).toEqual({ id: 'deepseek-official', name: 'DeepSeek', configured: true, source: 'saved' })
    expect(status).not.toHaveProperty('apiKey')
    expect(readFileSync(path, 'utf8')).not.toContain(validApiKey)
    expect(settings.getApiKey()).toBe(validApiKey)
  })

  it('removes the saved key and falls back to an environment key', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-environment-value'
    const { settings } = createSettings()
    settings.saveApiKey(validApiKey)

    expect(settings.getApiKey()).toBe(validApiKey)
    expect(settings.removeApiKey().source).toBe('environment')
    expect(settings.getApiKey()).toBe('sk-environment-value')
  })

  it('rejects keys with the wrong prefix or length', () => {
    const { settings } = createSettings()

    expect(() => settings.saveApiKey('ds-0123456789abcdefghijklmnopqrstuv')).toThrow('必须以 sk- 开头')
    expect(() => settings.saveApiKey('sk-too-short')).toThrow('完整长度应为 27-67 个字符')
  })
})
