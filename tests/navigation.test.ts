import { describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import type { WebContents } from 'electron'
import { installNavigationGuards } from '../src/main/navigation'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }))

describe('window navigation', () => {
  it('blocks same-window navigation and opens only web links externally', () => {
    const on = vi.fn()
    const setWindowOpenHandler = vi.fn()
    installNavigationGuards({ on, setWindowOpenHandler } as unknown as WebContents)

    const preventDefault = vi.fn()
    on.mock.calls[0][1]({ preventDefault })
    expect(on.mock.calls[0][0]).toBe('will-navigate')
    expect(preventDefault).toHaveBeenCalledOnce()

    const open = setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => { action: string }
    expect(open({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(open({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(open({ url: 'file:///tmp/secret' })).toEqual({ action: 'deny' })
    expect(open({ url: 'not a URL' })).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledOnce()
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
  })
})
