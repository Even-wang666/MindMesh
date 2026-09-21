import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

import { buildProviderSettingsYaml } from '../src/main/harness-adapter'

describe('model provider runtime settings', () => {
  it('uses an empty provider map when only the native DeepSeek route is configured', () => {
    expect(buildProviderSettingsYaml([
      { id: 'deepseek-official', name: 'DeepSeek', apiKey: 'secret' },
    ])).toBe('llm-pi-ai:\n  providers: {}\n')
  })

  it('builds standard and custom Harness provider routes without embedding secrets', () => {
    const yaml = buildProviderSettingsYaml([
      { id: 'openai', name: 'OpenAI', apiKey: 'openai-secret' },
      {
        id: 'custom',
        name: 'Internal Gateway',
        apiKey: 'custom-secret',
        baseUrl: 'https://llm.example.com/v1',
        model: 'team-chat',
      },
    ])

    expect(yaml).toContain('openai:')
    expect(yaml).toContain('apiKeyEnv: OPENAI_API_KEY')
    expect(yaml).toContain('baseURL: "https://llm.example.com/v1"')
    expect(yaml).toContain('id: "team-chat"')
    expect(yaml).not.toContain('openai-secret')
    expect(yaml).not.toContain('custom-secret')
  })
})
