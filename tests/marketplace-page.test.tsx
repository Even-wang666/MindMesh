// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplacePage } from '../src/renderer/src/MarketplacePage'
import type { MarketplaceCatalog } from '../src/shared/marketplace'

afterEach(() => cleanup())
function setup(list: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'mindmesh', {
    configurable: true,
    value: { marketplace: { list } },
  })
}

describe('Marketplace page', () => {
  it('installs a Team and opens its Space, with Installed/Open restored on remount', async () => {
    const item = {
      kind: 'teams',
      source: 'mindmesh-curated',
      sourceId: 'web-delivery',
      key: '["teams","mindmesh-curated","web-delivery"]',
      name: 'Web 交付团队',
      description: '',
      revision: 'b'.repeat(64),
    }
    const installTeam = vi
      .fn()
      .mockRejectedValueOnce(new Error('secret'))
      .mockResolvedValue({ id: 'team-space' })
    const list = vi.fn(async (kind) => ({
      kind,
      state: 'fresh',
      fetchedAt: null,
      items: kind === 'teams' ? [item] : [],
    }))
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: { marketplace: { list, installTeam } },
    })
    const open = vi.fn().mockRejectedValueOnce(new Error('secret')).mockResolvedValue(undefined)
    const page = render(<MarketplacePage onOpenSpace={open} />)
    fireEvent.click(screen.getByRole('tab', { name: '团队' }))
    fireEvent.click(await screen.findByRole('button', { name: '安装团队' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('安装团队失败')
    fireEvent.click(screen.getByRole('button', { name: '安装团队' }))
    fireEvent.click(await screen.findByRole('button', { name: '已安装 · 打开' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('打开团队失败')
    fireEvent.click(screen.getByRole('button', { name: '已安装 · 打开' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    expect(open).toHaveBeenLastCalledWith('team-space')
    expect(installTeam).toHaveBeenLastCalledWith(item.key, item.revision)
    page.unmount()
    list.mockImplementation(async (kind) => ({
      kind,
      state: 'fresh',
      fetchedAt: null,
      items: kind === 'teams' ? [{ ...item, installedSpaceId: 'team-space' }] : [],
    }))
    render(<MarketplacePage onOpenSpace={open} />)
    fireEvent.click(screen.getByRole('tab', { name: '团队' }))
    fireEvent.click(await screen.findByRole('button', { name: '已安装 · 打开' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(3))
    expect(installTeam).toHaveBeenCalledTimes(2)
  })
  it('installs the displayed revision, exposes Open and keeps an installation failure retryable', async () => {
    const item = {
      kind: 'agents',
      source: 'agency',
      sourceId: 'engineering/writer.md',
      key: '["agents","agency","engineering/writer.md"]',
      revision: 'a'.repeat(40),
      name: 'Writer',
      description: 'Writes',
      license: 'MIT',
    }
    const installAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error('sensitive raw error'))
      .mockResolvedValue({ id: 'installed' })
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: {
        marketplace: {
          list: vi.fn(async () => ({
            kind: 'agents',
            state: 'fresh',
            items: [item],
            fetchedAt: null,
          })),
          installAgent,
        },
      },
    })
    const open = vi.fn()
    render(<MarketplacePage onOpenAgent={open} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装智能体' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('安装智能体失败')
    expect(screen.queryByText('sensitive raw error')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装智能体' }))
    const button = await screen.findByRole('button', { name: '已安装 · 打开' })
    expect(installAgent).toHaveBeenLastCalledWith(item.key, item.revision)
    fireEvent.click(button)
    await waitFor(() => expect(open).toHaveBeenCalledWith('installed'))
    expect(installAgent).toHaveBeenCalledTimes(2)
  })

  it('does not put a completed install onto a different tab', async () => {
    let finish!: (agent: { id: string }) => void
    const item = {
      kind: 'agents',
      source: 'agency',
      sourceId: 'engineering/writer.md',
      key: 'writer',
      revision: 'a'.repeat(40),
      name: 'Writer',
      description: '',
    }
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: {
        marketplace: {
          list: vi.fn(async (kind) => ({
            kind,
            state: 'fresh',
            items: kind === 'agents' ? [item] : [],
            fetchedAt: null,
          })),
          installAgent: vi.fn(
            () =>
              new Promise<{ id: string }>((resolve) => {
                finish = resolve
              })
          ),
        },
      },
    })
    render(<MarketplacePage />)
    fireEvent.click(await screen.findByRole('button', { name: '安装智能体' }))
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: '团队' }))
    await screen.findByText('暂无团队')
    await act(async () => {
      finish({ id: 'installed' })
    })
    expect(screen.getByText('暂无团队')).toBeInTheDocument()
    expect(screen.queryByText('Writer')).toBeNull()
  })

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
    const list = vi.fn((kind) =>
      kind === 'agents'
        ? new Promise<MarketplaceCatalog>((resolve) => {
            finish = resolve
          })
        : Promise.resolve({
            kind,
            state: 'stale',
            fetchedAt: '2026-10-04T00:00:00Z',
            error: '刷新失败',
            items: [
              {
                key: 'team',
                kind,
                source: 'curated',
                sourceId: 'one',
                name: '<script>bad</script>',
                description: 'description',
              },
            ],
          })
    )
    setup(list)
    render(<MarketplacePage />)
    fireEvent.click(screen.getByRole('tab', { name: '团队' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(screen.getByText('<script>bad</script>')).toBeInTheDocument()
    await act(async () => {
      finish({ kind: 'agents', state: 'fresh', items: [], fetchedAt: null })
    })
    expect(screen.getByText('<script>bad</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })

  it('shows IPC failure and allows a retry', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('raw secret'))
      .mockResolvedValue({ kind: 'agents', state: 'fresh', items: [], fetchedAt: null })
    setup(list)
    render(<MarketplacePage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('请重试')
    expect(screen.queryByText('raw secret')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }))
    expect(await screen.findByText('暂无智能体')).toBeInTheDocument()
  })
})
