import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarness, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import type { Agent } from '../src/shared/contracts'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

import { buildProviderSettingsYaml, DeepSeekHarnessAdapter, SessionResumeUnsupportedError } from '../src/main/harness-adapter'

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

  it('maps SDK assistant notifications to text callbacks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-runtime-'))
    const run = vi.spyOn(DeepSeekHarness.prototype, 'run').mockImplementation(async (_prompt, options) => {
      options?.onNotification?.({
        method: 'session.event',
        params: { sessionId: 'session', event: {
          type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一段' }] } },
        } },
      } as never)
      return { finalResponse: '第一段', sessionId: 'session', events: [], notifications: [] }
    })
    const close = vi.spyOn(DeepSeekHarness.prototype, 'close').mockResolvedValue()
    const providerSettings = {
      getProvider: () => ({ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }),
      configuredProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }],
    } as unknown as ModelProviderSettings
    const agent: Agent = {
      id: 'agent', name: 'Agent', role: '', persona: '助手', provider: 'deepseek-official',
      model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '',
    }
    const adapter = new DeepSeekHarnessAdapter(directory, directory, providerSettings)
    const chunks: string[] = []
    try {
      await adapter.run(agent, '你好', 'session', (text) => chunks.push(text))
      expect(chunks).toEqual(['第一段'])
    } finally {
      await adapter.shutdownAll()
      run.mockRestore()
      close.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('identifies the SDK rejection of a persisted session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-resume-'))
    const run = vi.spyOn(DeepSeekHarness.prototype, 'run').mockRejectedValue(
      new JsonRpcResponseError(-32603, 'session "old-session" already exists'),
    )
    const close = vi.spyOn(DeepSeekHarness.prototype, 'close').mockResolvedValue()
    const providerSettings = {
      getProvider: () => ({ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }),
      configuredProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }],
    } as unknown as ModelProviderSettings
    const adapter = new DeepSeekHarnessAdapter(directory, directory, providerSettings)
    const agent: Agent = {
      id: 'agent', name: 'Agent', role: '', persona: '助手', provider: 'deepseek-official',
      model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '',
    }
    try {
      await expect(adapter.run(agent, '你好', 'old-session')).rejects.toBeInstanceOf(SessionResumeUnsupportedError)
    } finally {
      await adapter.shutdownAll()
      run.mockRestore()
      close.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
