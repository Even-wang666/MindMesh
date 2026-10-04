// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplacePage } from '../src/renderer/src/MarketplacePage'
import type { MarketplaceCatalog } from '../src/shared/marketplace'

afterEach(() => cleanup())
function setup(list: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'mindmesh', { configurable: true, value: { marketplace: { list } } })
}

describe('Marketplace page', () => {
  it('shows loading and empty states, switches tabs and forces refresh', async () => {
    const list = vi.fn(async (kind) => ({ kind, state: 'fresh', items: [], fetchedAt: null }))
    setup(list)
    render(<MarketplacePage />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载')
    expect(await screen.findByText('暂无智能体')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '团队' }))
    expect(await screen.findByText('暂无团队')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('teams', true))
    await screen.findByText('暂无团队')
    fireEvent.click(screen.getByRole('tab', { name: '插件' }))
    expect(await screen.findByText('暂无插件')).toBeInTheDocument()
    expect(list).toHaveBeenLastCalledWith('plugins', false)
    fireEvent.keyDown(screen.getByRole('tab', { name: '插件' }), { key: 'ArrowRight' })
    expect(await screen.findByText('暂无智能体')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '智能体' })).toHaveFocus()
  })

  it('discards an old tab response and renders stale content as text', async () => {
    let finish!: (value: MarketplaceCatalog) => void
    const list = vi.fn((kind) => kind === 'agents' ? new Promise<MarketplaceCatalog>((resolve) => { finish = resolve })
      : Promise.resolve({ kind, state: 'stale', fetchedAt: '2026-10-04T00:00:00Z', error: '刷新失败', items: [
        { key: 'team', kind, source: 'curated', sourceId: 'one', name: '<script>bad</script>', description: 'description' },
      ] }))
    setup(list)
    render(<MarketplacePage />)
    fireEvent.click(screen.getByRole('tab', { name: '团队' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(screen.getByText('<script>bad</script>')).toBeInTheDocument()
    await act(async () => { finish({ kind: 'agents', state: 'fresh', items: [], fetchedAt: null }) })
    expect(screen.getByText('<script>bad</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })

  it('shows IPC failure and allows a retry', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('raw secret')).mockResolvedValue({ kind: 'agents', state: 'fresh', items: [], fetchedAt: null })
    setup(list)
    render(<MarketplacePage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('请重试')
    expect(screen.queryByText('raw secret')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }))
    expect(await screen.findByText('暂无智能体')).toBeInTheDocument()
  })
})
