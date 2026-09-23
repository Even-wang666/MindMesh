import { describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import type { WebContents } from 'electron'
import { installNavigationGuards } from '../src/main/navigation'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }))

describe('window navigation', () => {
  it('allows trusted reloads and blocks navigation to other origins or local files', () => {
    const on = vi.fn()
    const setWindowOpenHandler = vi.fn()
    const getURL = vi.fn(() => 'http://localhost:5173/chat')
    installNavigationGuards({ on, setWindowOpenHandler, getURL } as unknown as WebContents)

    const preventDefault = vi.fn()
    const navigate = on.mock.calls[0][1] as (event: { preventDefault(): void }, url: string) => void
    expect(on.mock.calls[0][0]).toBe('will-navigate')
    navigate({ preventDefault }, 'http://localhost:5173/settings')
    expect(preventDefault).not.toHaveBeenCalled()
    navigate({ preventDefault }, 'https://example.com')
    navigate({ preventDefault }, 'file:///tmp/secret')
    expect(preventDefault).toHaveBeenCalledTimes(2)

    const open = setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => { action: string }
    expect(open({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(open({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(open({ url: 'file:///tmp/secret' })).toEqual({ action: 'deny' })
    expect(open({ url: 'not a URL' })).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledOnce()
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('allows only the loaded file when the packaged renderer refreshes', () => {
    const on = vi.fn()
    installNavigationGuards({
      on,
      getURL: () => 'file:///C:/MindMesh/out/renderer/index.html',
      setWindowOpenHandler: vi.fn(),
    } as unknown as WebContents)
    const navigate = on.mock.calls[0][1] as (event: { preventDefault(): void }, url: string) => void
    const preventDefault = vi.fn()
    navigate({ preventDefault }, 'file:///C:/MindMesh/out/renderer/index.html')
    expect(preventDefault).not.toHaveBeenCalled()
    navigate({ preventDefault }, 'file:///C:/secrets.txt')
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
