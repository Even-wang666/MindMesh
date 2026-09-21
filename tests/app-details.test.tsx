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
    agents: { list: vi.fn(async () => [agent]), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
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

  it('edits the selected agent and keeps its ID', async () => {
    let currentAgent = agent
    const api = mockApi()
    api.agents.list = vi.fn(async () => [currentAgent])
    api.agents.update = vi.fn(async (id, input) => {
      currentAgent = { ...currentAgent, ...input }
      expect(id).toBe(agent.id)
      return currentAgent
    })
    api.catalog.models = vi.fn(async () => [
      { provider: agent.provider, id: agent.model, name: 'DeepSeek V4 Flash' },
    ])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '编辑智能体' }))
    expect(screen.getByRole('heading', { name: '编辑智能体' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('角色定位'), { target: { value: '高级研究员' } })
    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: /下一步/ }))
    }
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }))

    expect((await screen.findAllByText('高级研究员')).length).toBeGreaterThanOrEqual(2)
    expect(api.agents.update).toHaveBeenCalledOnce()
    expect(currentAgent.id).toBe(agent.id)
  })
})
