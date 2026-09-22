// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, ChatDelta, ChatProgress, Message, MindMeshApi, Space } from '../src/shared/contracts'
import { App } from '../src/renderer/src/App'

afterEach(cleanup)
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })

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
    spaces: { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), remove: vi.fn(), updateContext: vi.fn() },
    chat: {
      messages: vi.fn(async () => []),
      sendPrivate: vi.fn(async () => []),
      sendSpace: vi.fn(async () => []),
      onDelta: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => undefined),
    },
    catalog: { skills: vi.fn(async () => []), tools: vi.fn(async () => []), models: vi.fn(async () => []) },
    runtime: {
      status: vi.fn(async () => ({ state: 'ready' as const, label: '准备就绪', detail: '模型服务已连接。' })),
    },
    settings: {
      workspace: vi.fn(async () => 'C:\\MindMesh'),
      chooseWorkspace: vi.fn(async () => 'C:\\My Files'),
      profile: vi.fn(async () => ({ name: '你', avatar: null })),
      saveProfile: vi.fn(async (profile) => profile),
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

describe('local file workspace', () => {
  it('shows the current folder and updates it after the native picker returns', async () => {
    const api = mockApi()
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(await screen.findByText('C:\\MindMesh')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByText('C:\\My Files')).toBeInTheDocument()
    expect(api.settings.chooseWorkspace).toHaveBeenCalledOnce()
  })
})

describe('user profile', () => {
  it('saves the nickname and avatar and shows them on existing user messages', async () => {
    const api = mockApi()
    api.chat.messages = vi.fn(async () => [{
      id: 'user-message', scope: 'private' as const, scopeId: agent.id, authorType: 'user' as const,
      authorName: '你', content: '你好', sequence: 1, createdAt: new Date().toISOString(),
    }])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)
    expect(await screen.findByText('你好')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.change(screen.getByRole('textbox', { name: '展示昵称' }), { target: { value: '小明' } })
    fireEvent.change(document.getElementById('profile-avatar-input')!, { target: { files: [new File(['image'], 'avatar.png', { type: 'image/png' })] } })
    await waitFor(() => expect(document.querySelector('.profile-avatar img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/)))
    fireEvent.click(screen.getByRole('button', { name: '保存个人资料' }))
    await waitFor(() => expect(api.settings.saveProfile).toHaveBeenCalledWith({ name: '小明', avatar: expect.stringMatching(/^data:image\/png;base64,/) }))
    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    expect(await screen.findByText('你好')).toBeInTheDocument()
    expect(screen.getByText('小明', { selector: '.message header strong' })).toBeInTheDocument()
    expect(document.querySelector('.message.user .avatar img')).toBeInTheDocument()
  })
})

describe('agent deletion', () => {
  it('requires confirmation before deleting an agent and selects a remaining agent', async () => {
    const second = { ...agent, id: 'developer', name: 'Developer' }
    let current = [agent, second]
    const api = mockApi()
    api.agents.list = vi.fn(async () => current)
    api.agents.remove = vi.fn(async (id) => { current = current.filter((item) => item.id !== id) })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    try {
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }))
      fireEvent.click(screen.getByRole('button', { name: '删除智能体' }))
      expect(api.agents.remove).not.toHaveBeenCalled()
      confirm.mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: '删除智能体' }))
      await waitFor(() => expect(api.agents.remove).toHaveBeenCalledWith(agent.id))
      expect(await screen.findByPlaceholderText('给 Developer 发送消息…')).toBeInTheDocument()
    } finally { confirm.mockRestore() }
  })
})

describe('space background', () => {
  it('confirms Space deletion and shows an empty state after the last Space is removed', async () => {
    const space: Space = { id: 'space', name: '临时空间', description: '', context: '', memberIds: [agent.id], createdAt: '' }
    let current = [space]
    const api = mockApi()
    api.spaces.list = vi.fn(async () => current)
    api.spaces.remove = vi.fn(async (id) => { current = current.filter((item) => item.id !== id) })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    try {
      render(<App />)
      fireEvent.click(screen.getByRole('button', { name: '协作空间' }))
      fireEvent.click(await screen.findByRole('button', { name: '删除空间' }))
      expect(api.spaces.remove).not.toHaveBeenCalled()
      confirm.mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: '删除空间' }))
      await waitFor(() => expect(api.spaces.remove).toHaveBeenCalledWith(space.id))
      expect(await screen.findByRole('heading', { name: '还没有协作空间' })).toBeInTheDocument()
    } finally { confirm.mockRestore() }
  })

  it('shows one working edit action and refreshes the saved background', async () => {
    let space: Space = {
      id: 'space', name: 'AI Product Research', description: '产品研究', context: '旧背景',
      memberIds: [agent.id], createdAt: '',
    }
    const api = mockApi()
    api.spaces.list = vi.fn(async () => [space])
    const updateContext = vi.fn(async (_id: string, context: string) => {
      space = { ...space, context }
      return space
    })
    api.spaces.updateContext = updateContext
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '协作空间' }))
    expect(await screen.findByText('旧背景')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '编辑背景' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '成员与背景' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑背景' }))
    const input = await screen.findByRole('textbox', { name: '背景信息' })
    fireEvent.change(input, { target: { value: '新的背景' } })
    fireEvent.click(screen.getByRole('button', { name: '保存背景' }))

    expect(updateContext).toHaveBeenCalledWith(space.id, '新的背景')
    await screen.findByRole('button', { name: '编辑背景' })
    expect(await screen.findByText('新的背景')).toBeInTheDocument()
  })

  it('edits space details and removes and adds members', async () => {
    const second = { ...agent, id: 'developer', name: 'Developer' }
    let space: Space = { id: 'space', name: '原空间', description: '原简介', context: '原背景', memberIds: [agent.id], createdAt: '' }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [agent, second])
    api.spaces.list = vi.fn(async () => [space])
    api.spaces.update = vi.fn(async (id, input) => { space = { ...space, ...input }; expect(id).toBe('space'); return space })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '协作空间' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑空间' }))
    fireEvent.change(screen.getByRole('textbox', { name: '空间名称' }), { target: { value: '新空间' } })
    fireEvent.click(screen.getByRole('button', { name: 'Researcher' }))
    fireEvent.click(screen.getByRole('button', { name: 'Developer' }))
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.spaces.update).toHaveBeenCalledWith('space', expect.objectContaining({ name: '新空间', memberIds: ['developer'] })))
    expect(await screen.findByRole('heading', { name: '新空间' })).toBeInTheDocument()
  })
})

describe('chat flow', () => {
  it('renders a long Markdown reply as readable structure', async () => {
    const api = mockApi()
    api.chat.messages = vi.fn(async (): Promise<Message[]> => [{
      id: 'markdown-reply', scope: 'private', scopeId: agent.id, authorType: 'agent',
      authorName: agent.name, sequence: 1, createdAt: new Date().toISOString(),
      content: '## 摘要\n\n**重点**说明\n\n- 第一项\n- 第二项\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 完成 |\n\n```ts\nconst ok = true\n```\n\n[文档](https://example.com)\n\n[危险](javascript:alert(1))\n\n<img src=x onerror=alert(1)>',
    }])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    expect(await screen.findByRole('heading', { name: '摘要' })).toBeInTheDocument()
    expect(screen.getByText('重点').tagName).toBe('STRONG')
    expect(screen.getByRole('list')).toHaveTextContent('第一项')
    expect(screen.getByRole('table')).toHaveTextContent('完成')
    expect(document.querySelector('.message-body pre')).toHaveTextContent('const ok = true')
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('link', { name: '危险' })).not.toBeInTheDocument()
    expect(document.querySelector('.message-body img')).not.toBeInTheDocument()
  })

  it('shows a reply event before the send promise resolves', async () => {
    const api = mockApi()
    let notify!: (event: ChatDelta) => void
    let resolveSend!: (messages: Message[]) => void
    api.chat.onDelta = vi.fn((listener) => { notify = listener; return () => undefined })
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('给 Researcher 发送消息…'), { target: { value: '你好' } })
    fireEvent.keyDown(screen.getByPlaceholderText('给 Researcher 发送消息…'), { key: 'Enter' })
    expect(screen.getByText('你好')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('思考中')
    expect(screen.getByRole('status').closest('.message')).toHaveTextContent('Researcher')
    act(() => notify({ requestId: 'request', scope: 'private', scopeId: agent.id,
      agentId: agent.id, text: '**正在生成**' }))
    await waitFor(() => expect(screen.getByText('正在生成').tagName).toBe('STRONG'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(async () => resolveSend([]))
  })

  it('reveals a complete model reply gradually after it arrives', async () => {
    const api = mockApi()
    let resolveSend!: (messages: Message[]) => void
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('给 Researcher 发送消息…'), { target: { value: '问题' } })
    fireEvent.keyDown(screen.getByPlaceholderText('给 Researcher 发送消息…'), { key: 'Enter' })
    await act(async () => resolveSend([{
      id: 'reply', scope: 'private', scopeId: agent.id, authorType: 'agent',
      authorName: agent.name, content: '这是一段需要逐字展示的完整回答。',
      sequence: 1, createdAt: new Date().toISOString(),
    }]))
    expect(screen.queryByText('这是一段需要逐字展示的完整回答。')).not.toBeInTheDocument()
    expect(await screen.findByText('这是一段需要逐字展示的完整回答。')).toBeInTheDocument()
  })

  it('keeps a new draft when Enter is pressed while a reply is pending', async () => {
    const api = mockApi()
    let resolveSend!: (messages: Message[]) => void
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '第一条' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: '第二条草稿' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('第二条草稿')
    expect(api.chat.sendPrivate).toHaveBeenCalledOnce()
    await act(async () => resolveSend([]))
  })

  it('keeps a completed reply in its original conversation', async () => {
    const secondAgent = { ...agent, id: 'developer', name: 'Developer', role: '软件工程师' }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [agent, secondAgent])
    let resolveSend!: (messages: Message[]) => void
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('给 Researcher 发送消息…'), { target: { value: '问题' } })
    fireEvent.keyDown(screen.getByPlaceholderText('给 Researcher 发送消息…'), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: /Developer 软件工程师/ }))
    expect(await screen.findByPlaceholderText('给 Developer 发送消息…')).toBeInTheDocument()

    await act(async () => resolveSend([{
      id: 'old-reply', scope: 'private', scopeId: agent.id, authorType: 'agent',
      authorName: agent.name, content: '旧会话回复', sequence: 1, createdAt: new Date().toISOString(),
    }]))
    expect(screen.queryByText('旧会话回复')).not.toBeInTheDocument()
  })

  it('shows progress only for the active conversation', async () => {
    const secondAgent = { ...agent, id: 'developer', name: 'Developer', role: '软件工程师' }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [agent, secondAgent])
    let notify!: (event: ChatProgress) => void
    api.chat.onProgress = vi.fn((listener) => { notify = listener; return () => undefined })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    await screen.findByPlaceholderText('给 Researcher 发送消息…')
    act(() => notify({ scope: 'private', scopeId: agent.id, agentName: agent.name }))
    expect(screen.getByRole('status')).toHaveTextContent('思考中')
    expect(screen.getByRole('status').closest('.message')).toHaveTextContent('Researcher')
    fireEvent.click(screen.getByRole('button', { name: /Developer 软件工程师/ }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps the first space reply visible while the next agent thinks', async () => {
    const second = { ...agent, id: 'developer', name: 'Developer' }
    const space: Space = { id: 'space', name: '协作', description: '', context: '',
      memberIds: [agent.id, second.id], createdAt: '' }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [agent, second])
    api.spaces.list = vi.fn(async () => [space])
    let notify!: (event: ChatProgress) => void
    api.chat.onProgress = vi.fn((listener) => { notify = listener; return () => undefined })
    let spaceReads = 0
    api.chat.messages = vi.fn(async (scope) => {
      if (scope !== 'space' || ++spaceReads === 1) return []
      return [{ id: 'reply', scope: 'space' as const, scopeId: space.id, authorType: 'agent' as const,
        authorName: agent.name, content: '第一位已完成', sequence: 1,
        createdAt: new Date().toISOString() }]
    })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '协作空间' }))
    await screen.findByRole('heading', { name: '协作' })
    await waitFor(() => expect(api.chat.messages).toHaveBeenCalledWith('space', space.id))
    act(() => notify({ scope: 'space', scopeId: space.id, agentName: second.name }))
    expect(await screen.findByText('第一位已完成')).toBeInTheDocument()
    expect(screen.getByRole('status').closest('.message')).toHaveTextContent('Developer')
  })
})
