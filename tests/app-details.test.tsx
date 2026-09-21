// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, MindMeshApi } from '../src/shared/contracts'
import { App } from '../src/renderer/src/App'

const agent: Agent = {
  id: 'researcher',
  name: 'Researcher',
  role: '研究分析专家',
  persona: '坚持证据优先。',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  skills: ['研究分析'],
  tools: [],
  createdAt: '',
}

function mockApi(): MindMeshApi {
  return {
    agents: { list: vi.fn(async () => [agent]), create: vi.fn(), remove: vi.fn() },
    spaces: { list: vi.fn(async () => []), create: vi.fn() },
    chat: {
      messages: vi.fn(async () => []),
      sendPrivate: vi.fn(async () => []),
      sendSpace: vi.fn(async () => []),
      onDelta: vi.fn(() => () => undefined),
    },
    catalog: { skills: vi.fn(async () => []), tools: vi.fn(async () => []), models: vi.fn(async () => []) },
    runtime: {
      status: vi.fn(async () => ({ state: 'ready' as const, label: '准备就绪', detail: '模型服务已连接。' })),
    },
    settings: {
      modelProviders: vi.fn(async () => []),
      saveModelProvider: vi.fn(async () => []),
      removeModelProvider: vi.fn(async () => []),
    },
  }
}

describe('chat details', () => {
  it('opens the selected agent drawer from 查看详情', async () => {
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: mockApi() })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }))

    expect(screen.getByText('身份设定')).toBeInTheDocument()
    expect(screen.getByText('坚持证据优先。')).toBeInTheDocument()
  })
})
