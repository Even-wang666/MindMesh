import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { MindMeshApi } from '../src/shared/contracts'
import { MAX_CHAT_CONTENT_BYTES } from '../src/shared/chat-content'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}))

let api: MindMeshApi

beforeAll(async () => {
  await import('../src/preload/index')
  api = electron.exposeInMainWorld.mock.calls[0][1] as MindMeshApi
})

describe('preload chat boundary', () => {
  it('rejects oversized content before invoking main-process IPC', () => {
    expect(() => api.chat.sendPrivate('agent', 'a'.repeat(MAX_CHAT_CONTENT_BYTES + 1))).toThrow('64 KiB')
    expect(() => api.chat.sendSpace('space', 'a'.repeat(MAX_CHAT_CONTENT_BYTES + 1))).toThrow('64 KiB')
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('forwards skill install progress and removes the exact listener', () => {
    const listener = vi.fn()
    const unsubscribe = api.catalog.onInstallProgress(listener)
    const subscription = electron.on.mock.calls.find(([channel]) => channel === 'catalog:installProgress')
    expect(subscription).toBeDefined()

    const handler = subscription?.[1]
    const progress = { phase: 'downloading' as const, receivedBytes: 1024, totalBytes: 4096 }
    handler({}, progress)
    expect(listener).toHaveBeenCalledWith(progress)

    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledWith('catalog:installProgress', handler)
  })
})
