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
    const status = settings.saveApiKey('sk-private-value')

    expect(status).toEqual({ id: 'deepseek-official', name: 'DeepSeek', configured: true, source: 'saved' })
    expect(status).not.toHaveProperty('apiKey')
    expect(readFileSync(path, 'utf8')).not.toContain('sk-private-value')
    expect(settings.getApiKey()).toBe('sk-private-value')
  })

  it('removes the saved key and falls back to an environment key', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-environment-value'
    const { settings } = createSettings()
    settings.saveApiKey('sk-saved-value')

    expect(settings.getApiKey()).toBe('sk-saved-value')
    expect(settings.removeApiKey().source).toBe('environment')
    expect(settings.getApiKey()).toBe('sk-environment-value')
  })
})
