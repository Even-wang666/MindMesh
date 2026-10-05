// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginMarketplace } from '../src/renderer/src/PluginMarketplace'
import { marketplaceKey, type MarketplaceItem } from '../src/shared/marketplace'
import type { PluginOperation, PluginRequest, PluginState } from '../src/shared/plugins'

const item: MarketplaceItem = {
  kind: 'plugins',
  source: 'dsh',
  sourceId: 'fixture-plugin',
  key: marketplaceKey({ kind: 'plugins', source: 'dsh', sourceId: 'fixture-plugin' }),
  name: 'Fixture',
  description: '<script>data only</script>',
  plugin: { packageName: 'fixture-plugin', version: '1.0.1', warnings: ['Third-party code'] },
}
afterEach(() => cleanup())
function setup(
  initial: PluginState = {
    installed: [],
    results: [],
    operation: null,
    available: [{ key: item.key, version: '1.0.1' }],
  }
) {
  let current = initial,
    progress!: (operation: PluginOperation) => void
  const unsubscribe = vi.fn()
  const state = vi.fn(async () => current)
  const change = vi.fn(async (request: PluginRequest) => {
    current = { ...current, operation: { ...request, phase: 'succeeded' } }
    if (request.action === 'check')
      current.results = [{ key: item.key, version: '1.0.1', compatibility: 'compatible' }]
    if (request.action === 'install' || request.action === 'update')
      current.installed = [
        {
          packageName: 'fixture-plugin',
          version: request.version!,
          enabled: true,
          configuration: 'default',
        },
      ]
    if (request.action === 'disable') current.installed[0].enabled = false
    if (request.action === 'enable') current.installed[0].enabled = true
    if (request.action === 'remove') current.installed = []
    progress(current.operation!)
    return current.operation!
  })
  const cancel = vi.fn(async () => true)
  const importGitHub = vi.fn(async (request: { requestId: string; url: string }) => {
    const operation: PluginOperation = {
      requestId: request.requestId,
      key: item.key,
      action: 'install',
      phase: 'succeeded',
      message: 'GitHub 插件验证通过，安装完成。',
    }
    current = { ...current, operation }
    progress(operation)
    return operation
  })
  Object.defineProperty(window, 'mindmesh', {
    configurable: true,
    value: {
      plugins: {
        state,
        change,
        cancel,
        importGitHub,
        onProgress: vi.fn((listener) => {
          progress = listener
          return unsubscribe
        }),
      },
    },
  })
  return {
    state,
    change,
    cancel,
    importGitHub,
    unsubscribe,
    update: (next: PluginState) => {
      current = next
      progress(next.operation!)
    },
  }
}
describe('plugin Marketplace UI', () => {
  it('imports one GitHub URL and shows success or a concrete validation failure', async () => {
    const { importGitHub, update } = setup()
    render(<PluginMarketplace items={[item]} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'GitHub 导入' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'GitHub 导入' }))
    expect(screen.getByRole('dialog', { name: '从 GitHub 导入插件' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub 插件地址' }), {
      target: { value: 'https://github.com/acme/plugin' },
    })
    fireEvent.click(screen.getByRole('button', { name: '验证并安装' }))
    expect(await screen.findByText('GitHub 插件验证通过，安装完成。')).toBeInTheDocument()
    expect(importGitHub).toHaveBeenCalledWith({
      requestId: expect.any(String),
      url: 'https://github.com/acme/plugin',
    })
    await act(async () =>
      update({
        installed: [],
        results: [],
        operation: {
          requestId: 'owned',
          key: item.key,
          action: 'install',
          phase: 'failed',
          message: 'GitHub 插件验证失败，已终止安装：@deepseek-ai/dsh 要求 0.1.5，当前 0.2.0。',
        },
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '已终止安装：@deepseek-ai/dsh 要求 0.1.5'
    )
  })
  it('hides unprepared and incompatible entries while showing preparation status', async () => {
    setup({
      installed: [],
      results: [{ key: item.key, version: '1.0.1', compatibility: 'incompatible' }],
      operation: null,
      available: [],
      preparing: true,
    })
    render(<PluginMarketplace items={[item]} />)
    expect(await screen.findByText('正在准备可安装插件…')).toBeInTheDocument()
    expect(screen.queryByText('Fixture')).toBeNull()
    expect(screen.queryByRole('button', { name: '安装插件' })).toBeNull()
    expect(screen.queryByRole('button', { name: '检查兼容性' })).toBeNull()
  })
  it('offers one-click install for prepared plugins without a compatibility step', async () => {
    const { change } = setup()
    render(<PluginMarketplace items={[item]} />)
    const install = await screen.findByRole('button', { name: '安装插件' })
    expect(install).toBeEnabled()
    expect(screen.getByText('<script>data only</script>')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '检查兼容性' })).toBeNull()
    fireEvent.click(install)
    const disable = await screen.findByRole('button', { name: '停用插件' })
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'install', version: '1.0.1', key: item.key })
    )
    fireEvent.click(disable)
    fireEvent.click(await screen.findByRole('button', { name: '启用插件' }))
    fireEvent.click(await screen.findByRole('button', { name: '移除插件' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '移除插件' })).toBeNull())
  })
  it('keeps off-catalog installed plugins controllable and disables unsupported catalog entries', async () => {
    const { change } = setup({
      installed: [
        {
          packageName: 'fixture-plugin',
          version: '1.0.0',
          enabled: true,
          configuration: 'configured',
        },
      ],
      results: [{ key: item.key, version: '1.0.1', compatibility: 'compatible' }],
      available: [{ key: item.key, version: '1.0.1' }],
      operation: null,
    })
    const page = render(<PluginMarketplace items={[item]} />)
    fireEvent.click(await screen.findByRole('button', { name: '更新至 1.0.1' }))
    await waitFor(() =>
      expect(change).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'update', version: '1.0.1' })
      )
    )
    page.rerender(
      <PluginMarketplace
        items={[
          {
            ...item,
            key: 'manual',
            sourceId: 'manual',
            name: 'Manual',
            plugin: { warnings: ['Needs setup'] },
          },
        ]}
      />
    )
    expect(await screen.findByText('已安装插件；当前目录无可用的更新信息。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停用插件' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '安装插件' })).toBeNull()
    expect(screen.queryByText('Manual')).toBeNull()
    page.rerender(
      <PluginMarketplace
        items={[{ ...item, plugin: { warnings: ['Upstream version missing'] } }]}
      />
    )
    expect(screen.getByRole('button', { name: '停用插件' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '移除插件' })).toBeEnabled()
    expect(screen.getByText('包：fixture-plugin')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安装插件' })).toBeNull()
  })
  it('restores an active operation, cancels by request ID and presents safe failed diagnostics', async () => {
    const operation: PluginOperation = {
      requestId: 'owned',
      key: item.key,
      action: 'install',
      phase: 'booting',
    }
    const { cancel, update, unsubscribe } = setup({ installed: [], results: [], operation })
    const page = render(<PluginMarketplace items={[item]} />)
    fireEvent.click(await screen.findByRole('button', { name: '取消操作' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('owned'))
    expect(screen.queryByRole('button', { name: '检查兼容性' })).toBeNull()
    await act(async () =>
      update({
        installed: [],
        results: [
          {
            key: item.key,
            version: '1.0.1',
            compatibility: 'needs-approval',
            diagnostics: 'Requires approved build; token=[REDACTED]',
          },
        ],
        operation: {
          ...operation,
          phase: 'failed',
          message: 'Validation failed',
          diagnostics: 'Requires approved build',
        },
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Validation failed')
    expect(screen.queryByText('Fixture')).toBeNull()
    expect(screen.queryByRole('button', { name: '安装插件' })).toBeNull()
    page.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
