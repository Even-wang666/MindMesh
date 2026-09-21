import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => {
      const stored = value.toString()
      if (!stored.startsWith('encrypted:')) throw new Error('damaged secret')
      return stored.replace(/^encrypted:/, '')
    },
  },
}))

import { ModelProviderSettings } from '../src/main/model-provider-settings'

const directories: string[] = []
const keys = {
  deepseek: 'sk-0123456789abcdefghijklmnopqrstuv',
  kimi: 'sk-0123456789abcdef0123456789abcdef',
  openai: 'sk-proj-0123456789abcdef0123456789abcdef',
  anthropic: 'sk-ant-api03-0123456789abcdef0123456789abcdef',
}

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MOONSHOT_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

function createSettings(): { settings: ModelProviderSettings; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'mindmesh-settings-'))
  directories.push(directory)
  const path = join(directory, 'model-services.json')
  return { settings: new ModelProviderSettings(path), path }
}

describe('ModelProviderSettings', () => {
  it('encrypts multiple provider keys and never returns secrets in status', () => {
    const { settings, path } = createSettings()
    settings.save({ id: 'deepseek-official', apiKey: keys.deepseek })
    const statuses = settings.save({ id: 'openai', apiKey: keys.openai })

    expect(statuses.find((provider) => provider.id === 'deepseek-official')?.source).toBe('saved')
    expect(statuses.find((provider) => provider.id === 'openai')?.source).toBe('saved')
    expect(JSON.stringify(statuses)).not.toContain('apiKey')
    expect(readFileSync(path, 'utf8')).not.toContain(keys.deepseek)
    expect(readFileSync(path, 'utf8')).not.toContain(keys.openai)
    expect(settings.getProvider('openai')?.apiKey).toBe(keys.openai)
  })

  it('removes one saved key without affecting others and falls back to the environment', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-environment-value-that-is-long-enough'
    const { settings } = createSettings()
    settings.save({ id: 'deepseek-official', apiKey: keys.deepseek })
    settings.save({ id: 'moonshotai-cn', apiKey: keys.kimi })

    const statuses = settings.remove('deepseek-official')

    expect(statuses.find((provider) => provider.id === 'deepseek-official')?.source).toBe('environment')
    expect(statuses.find((provider) => provider.id === 'moonshotai-cn')?.source).toBe('saved')
    expect(settings.getProvider('deepseek-official')?.apiKey).toBe('sk-environment-value-that-is-long-enough')
  })

  it('stores custom metadata while keeping its key encrypted', () => {
    const { settings, path } = createSettings()
    const statuses = settings.save({
      id: 'custom',
      name: '内部网关',
      baseUrl: 'https://llm.example.com/v1',
      model: 'team-chat',
      apiKey: 'internal-secret-key',
    })

    expect(statuses.at(-1)).toMatchObject({
      id: 'custom',
      name: '内部网关',
      baseUrl: 'https://llm.example.com/v1',
      model: 'team-chat',
      configured: true,
    })
    expect(readFileSync(path, 'utf8')).not.toContain('internal-secret-key')
    expect(settings.getProvider('custom')).toMatchObject({
      name: '内部网关',
      model: 'team-chat',
      apiKey: 'internal-secret-key',
    })
  })

  it('reads the previous DeepSeek-only storage format', () => {
    const { settings, path } = createSettings()
    writeFileSync(path, JSON.stringify({
      deepseekApiKey: Buffer.from(`encrypted:${keys.deepseek}`).toString('base64'),
    }))

    expect(settings.getProvider('deepseek-official')?.apiKey).toBe(keys.deepseek)
    expect(settings.statuses()[0].source).toBe('saved')
  })

  it('ignores a damaged saved secret and falls back to the environment', () => {
    process.env.OPENAI_API_KEY = keys.openai
    const { settings, path } = createSettings()
    writeFileSync(path, JSON.stringify({
      version: 2,
      providers: { openai: { apiKey: Buffer.from('damaged').toString('base64') } },
    }))

    expect(settings.statuses().find((provider) => provider.id === 'openai')?.source).toBe('environment')
    expect(settings.getProvider('openai')?.apiKey).toBe(keys.openai)
  })

  it('validates provider-specific prefixes and custom fields', () => {
    const { settings } = createSettings()

    expect(() => settings.save({ id: 'anthropic', apiKey: keys.openai })).toThrow('必须以 sk-ant- 开头')
    expect(() => settings.save({ id: 'deepseek-official', apiKey: 'sk-too-short' })).toThrow('完整长度应为 27-67 个字符')
    expect(() => settings.save({
      id: 'custom', name: 'Test', baseUrl: 'not-a-url', model: 'model', apiKey: 'valid-secret',
    })).toThrow('请输入完整有效的 API Base URL')
    expect(() => settings.save({
      id: 'custom', name: 'Test', baseUrl: 'ftp://example.com', model: 'model', apiKey: 'valid-secret',
    })).toThrow('必须以 http:// 或 https:// 开头')
  })
})
