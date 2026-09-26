// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, ChatDelta, ChatProgress, Message, MindMeshApi, ModelProviderStatus, Space, UserProfile } from '../src/shared/contracts'
import { createSkillReference } from '../src/shared/skill-reference'
import { App } from '../src/renderer/src/App'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
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
  let storedProfile: UserProfile = { name: '你', avatar: null }
  return {
    agents: { list: vi.fn(async () => [agent]), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    spaces: { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), remove: vi.fn(), updateContext: vi.fn() },
    chat: {
      messages: vi.fn(async () => []),
      sendPrivate: vi.fn(async () => []),
      sendSpace: vi.fn(async () => []),
      stop: vi.fn(async () => false),
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
      profile: vi.fn(async () => storedProfile),
      saveProfile: vi.fn(async (profile) => { storedProfile = profile; return profile }),
      modelProviders: vi.fn(async () => []),
      saveModelProvider: vi.fn(async () => []),
      removeModelProvider: vi.fn(async () => []),
    },
  }
}

describe('chat details', () => {
  it('shows a persistent marker on a stopped reply loaded from history', async () => {
    const api = mockApi()
    api.chat.messages = vi.fn(async () => [{
      id: 'stopped-message', scope: 'private' as const, scopeId: agent.id, authorType: 'agent' as const,
      authorId: agent.id, authorName: agent.name, content: '被打断的半句话', stopped: true,
      sequence: 1, createdAt: new Date().toISOString(),
    }])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })

    render(<App />)

    expect(await screen.findByText('被打断的半句话')).toBeInTheDocument()
    expect(screen.getByText('已停止 · 回复可能不完整')).toBeInTheDocument()
  })

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

  it('shows the friendly name for a stable skill reference', async () => {
    const api = mockApi()
    api.agents.list = vi.fn(async () => [{
      ...agent,
      skills: [createSkillReference('mindmesh-builtin-workout-planner-v1', '训练计划')],
    }])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }))

    expect(screen.getByText('训练计划')).toBeInTheDocument()
    expect(screen.queryByText(/mindmesh-builtin-workout-planner-v1/)).not.toBeInTheDocument()
  })

  it('requires an exact choice when a legacy skill name has multiple matches', async () => {
    let currentAgent = { ...agent, skills: ['训练计划'] }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [currentAgent])
    api.agents.update = vi.fn(async (_id, input) => (currentAgent = { ...currentAgent, ...input }))
    api.catalog.skills = vi.fn(async () => [
      { id: 'custom-workout', name: '训练计划', description: '用户版本', status: '已安装' },
      { id: 'mindmesh-builtin-workout-planner-v1', name: '训练计划', description: '内置版本', status: '已安装' },
    ])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '编辑智能体' }))
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }))
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }))
    const choices = await screen.findAllByRole('button', { name: /训练计划/ })
    expect(choices.every((choice) => !choice.classList.contains('checked'))).toBe(true)
    fireEvent.click(choices[0])
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }))
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }))

    await waitFor(() => expect(currentAgent.skills).toEqual([
      createSkillReference('custom-workout', '训练计划'),
    ]))
  })
})

describe('model provider balance', () => {
  it('shows the configured DeepSeek balance in settings', async () => {
    const api = mockApi()
    api.settings.modelProviders = vi.fn(async () => ([{
      id: 'deepseek-official', name: 'DeepSeek', description: 'DeepSeek 官方 API',
      configured: true, source: 'saved',
      balance: {
        available: true, updatedAt: '2026-09-23T12:30:00.000Z',
        items: [{ currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' }],
      },
    }] as ModelProviderStatus[]))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))

    expect(await screen.findByText('¥110.00')).toBeInTheDocument()
    expect(screen.getByText('CNY')).toBeInTheDocument()
  })

  it('refreshes the model catalog after saving a provider', async () => {
    const api = mockApi()
    const unconfigured: ModelProviderStatus[] = [{
      id: 'deepseek-official', name: 'DeepSeek', description: 'DeepSeek 官方 API',
      configured: false, source: null,
    }]
    const configured: ModelProviderStatus[] = [{
      id: 'deepseek-official', name: 'DeepSeek', description: 'DeepSeek 官方 API',
      configured: true, source: 'saved',
    }]
    api.settings.modelProviders = vi.fn(async () => unconfigured)
    api.settings.saveModelProvider = vi.fn(async () => configured)
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await screen.findByText('DeepSeek 官方 API')
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    fireEvent.change(await screen.findByPlaceholderText(/sk-0123456789/), { target: { value: `sk-${'a'.repeat(30)}` } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.settings.saveModelProvider).toHaveBeenCalledOnce())
    await waitFor(() => expect(api.catalog.models).toHaveBeenCalledTimes(2))
  })

  it('confirms removing a saved provider in the app dialog', async () => {
    const provider: ModelProviderStatus = {
      id: 'deepseek-official', name: 'DeepSeek', description: 'DeepSeek 官方 API',
      configured: true, source: 'saved',
    }
    const api = mockApi()
    api.settings.modelProviders = vi.fn(async () => [provider])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '移除' }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('移除 DeepSeek 的 API 配置？')
    expect(api.settings.removeModelProvider).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '移除配置' }))
    await waitFor(() => expect(api.settings.removeModelProvider).toHaveBeenCalledWith(provider.id))
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
    fireEvent.click(screen.getByRole('button', { name: '编辑资料' }))
    fireEvent.change(screen.getByRole('textbox', { name: '你希望智能体怎么称呼你' }), { target: { value: '小明' } })
    fireEvent.change(document.getElementById('profile-avatar-input')!, { target: { files: [new File(['image'], 'avatar.png', { type: 'image/png' })] } })
    await waitFor(() => expect(document.querySelector('.profile-avatar img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/)))
    fireEvent.click(screen.getByRole('button', { name: '保存个人资料' }))
    await waitFor(() => expect(api.settings.saveProfile).toHaveBeenCalledWith({ name: '小明', avatar: expect.stringMatching(/^data:image\/png;base64,/) }))
    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    expect(await screen.findByText('你好')).toBeInTheDocument()
    expect(screen.getByText('小明', { selector: '.message header strong' })).toBeInTheDocument()
    expect(document.querySelector('.message.user .avatar img')).toBeInTheDocument()
  })

  it('switches between profile display and editing without keeping cancelled changes', async () => {
    const api = mockApi()
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(await screen.findByText('智能体在对话中会这样称呼你')).toBeInTheDocument()
    expect(document.querySelector('.profile-section > .profile-row')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '你希望智能体怎么称呼你' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑资料' }))
    const input = screen.getByRole('textbox', { name: '你希望智能体怎么称呼你' })
    expect(input).toHaveAccessibleDescription('这个名字会显示在对话里，智能体也会用它称呼你')
    fireEvent.change(input, { target: { value: '小红' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('textbox', { name: '你希望智能体怎么称呼你' })).not.toBeInTheDocument()
    expect(document.querySelector('.profile-name')).toHaveTextContent('你')
    expect(api.settings.saveProfile).not.toHaveBeenCalled()
  })

  it('saves only substantive profile changes and returns to display mode', async () => {
    const api = mockApi()
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }))
    const input = screen.getByRole('textbox', { name: '你希望智能体怎么称呼你' })
    const save = screen.getByRole('button', { name: '保存个人资料' })
    expect(save).toBeDisabled()

    fireEvent.change(input, { target: { value: ' 你 ' } })
    expect(save).toBeDisabled()
    fireEvent.change(input, { target: { value: ' 小明 ' } })
    expect(save).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '保存个人资料' }))

    await waitFor(() => expect(api.settings.saveProfile).toHaveBeenCalledWith({ name: '小明', avatar: null }))
    expect(await screen.findByRole('status')).toHaveTextContent('个人资料已保存')
    expect(screen.getByRole('status').tagName).toBe('SPAN')
    expect(screen.queryByRole('textbox', { name: '你希望智能体怎么称呼你' })).not.toBeInTheDocument()
    expect(document.querySelector('.profile-name')).toHaveTextContent('小明')

    fireEvent.click(screen.getByRole('button', { name: '编辑资料' }))
    expect(screen.queryByText('个人资料已保存')).not.toBeInTheDocument()
  })

  it('keeps a failed profile save visible instead of reporting success', async () => {
    const api = mockApi()
    api.settings.saveProfile = vi.fn(async () => { throw new Error('磁盘写入失败') })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }))
    fireEvent.change(screen.getByRole('textbox', { name: '你希望智能体怎么称呼你' }), { target: { value: '小明' } })
    fireEvent.click(screen.getByRole('button', { name: '保存个人资料' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘写入失败')
    expect(screen.queryByText('个人资料已保存')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '你希望智能体怎么称呼你' })).toHaveValue('小明')
  })
})

describe('agent deletion', () => {
  it('confirms in an app dialog before deleting an agent and selects a remaining agent', async () => {
    const second = { ...agent, id: 'developer', name: 'Developer' }
    let current = [agent, second]
    const api = mockApi()
    api.agents.list = vi.fn(async () => current)
    api.agents.remove = vi.fn(async (id) => { current = current.filter((item) => item.id !== id) })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '删除智能体' }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('确定删除智能体「Researcher」吗？')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(api.agents.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除智能体' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确定删除' }))
    await waitFor(() => expect(api.agents.remove).toHaveBeenCalledWith(agent.id))
    expect(await screen.findByPlaceholderText('给 Developer 发送消息…')).toBeInTheDocument()
  })

  it('keeps the dialog open with the reason when deleting fails', async () => {
    const api = mockApi()
    api.agents.remove = vi.fn(async () => { throw new Error('该智能体正在生成回复') })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '删除智能体' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确定删除' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('该智能体正在生成回复')
    expect(within(dialog).getByRole('button', { name: '确定删除' })).toBeEnabled()
  })
})

describe('space background', () => {
  it('confirms Space deletion in an app dialog and shows an empty state after the last Space is removed', async () => {
    const space: Space = { id: 'space', name: '临时空间', description: '', context: '', memberIds: [agent.id], createdAt: '' }
    let current = [space]
    const api = mockApi()
    api.spaces.list = vi.fn(async () => current)
    api.spaces.remove = vi.fn(async (id) => { current = current.filter((item) => item.id !== id) })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '协作空间' }))
    expect(screen.queryByRole('button', { name: '删除空间' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '编辑空间' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除空间' }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('确定删除协作空间「临时空间」吗？')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(api.spaces.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除空间' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确定删除' }))
    await waitFor(() => expect(api.spaces.remove).toHaveBeenCalledWith(space.id))
    expect(await screen.findByRole('heading', { name: '还没有协作空间' })).toBeInTheDocument()
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
    expect(screen.queryByText('旧背景')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '编辑空间' }))
    expect(await screen.findByText('旧背景')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑空间' }))
    expect(screen.queryByText('旧背景')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑空间' }))
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
    fireEvent.click(screen.getByRole('button', { name: '编辑空间信息' }))
    fireEvent.change(screen.getByRole('textbox', { name: '空间名称' }), { target: { value: '新空间' } })
    fireEvent.click(screen.getByRole('button', { name: 'Researcher' }))
    fireEvent.click(screen.getByRole('button', { name: 'Developer' }))
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.spaces.update).toHaveBeenCalledWith('space', expect.objectContaining({ name: '新空间', memberIds: ['developer'] })))
    expect(await screen.findByRole('heading', { name: '新空间' })).toBeInTheDocument()
  })
})

describe('chat flow', () => {
  it('opens existing conversations at the bottom without scrolling through history', async () => {
    const api = mockApi()
    let notify!: (event: ChatDelta) => void
    api.chat.messages = vi.fn(async (): Promise<Message[]> => [{
      id: 'history', scope: 'private', scopeId: agent.id, authorType: 'agent',
      authorName: agent.name, content: '已有聊天记录', sequence: 1, createdAt: new Date().toISOString(),
    }])
    api.chat.onDelta = vi.fn((listener) => { notify = listener; return () => undefined })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    expect(await screen.findByText('已有聊天记录')).toBeInTheDocument()
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto' }))
    expect(scrollIntoView).not.toHaveBeenCalledWith({ behavior: 'smooth' })

    scrollIntoView.mockClear()
    act(() => notify({ requestId: 'request', scope: 'private', scopeId: agent.id,
      agentId: agent.id, text: '新内容' }))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' }))
  })

  it('keeps a dedicated resizer between the list and conversation panes', async () => {
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: mockApi() })
    render(<App />)

    expect(await screen.findByRole('separator', { name: /列表栏宽度/ }))
      .toHaveAttribute('data-pane', 'list-content')
  })

  it('selects the conversation model and permission from the composer', async () => {
    const api = mockApi()
    api.catalog.models = vi.fn(async () => [
      { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 },
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
    ])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /选择模型/ }))
    expect(screen.getAllByRole('button', { name: 'DeepSeek V4.1 Flash' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek V4 Pro' }))
    fireEvent.click(screen.getByRole('button', { name: /权限：允许完全访问/ }))
    fireEvent.click(screen.getByRole('button', { name: '仅对话' }))
    expect(screen.getByRole('button', { name: /上下文窗口/ })).toHaveAccessibleName(/1M/)
    const input = screen.getByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '使用新模型' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(api.chat.sendPrivate).toHaveBeenCalledWith(
      agent.id, '使用新模型', [], { model: 'deepseek-v4-pro', permission: 'chat' },
    ))
  })

  it('keeps non-DeepSeek conversations usable while model switching is unavailable', async () => {
    const openAiAgent = { ...agent, provider: 'openai', model: 'gpt-4.1' }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [openAiAgent])
    api.catalog.models = vi.fn(async () => [
      { provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1' },
    ])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    expect(screen.getByRole('button', { name: /选择模型/ })).toBeDisabled()
    fireEvent.change(input, { target: { value: '普通对话' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(api.chat.sendPrivate).toHaveBeenCalledWith(
      agent.id, '普通对话', [], { permission: 'full' },
    ))
  })

  it('previews and sends a DeepSeek image without requiring text', async () => {
    const api = mockApi()
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const file = new File([
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ], 'chart.png', { type: 'image/png' })
    fireEvent.change(await screen.findByLabelText('选择图片'), { target: { files: [file] } })
    expect(await screen.findByAltText('chart.png')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(api.chat.sendPrivate).toHaveBeenCalledWith(
      agent.id,
      '',
      [expect.objectContaining({ type: 'image', name: 'chart.png', mediaType: 'image/png' })],
      { model: 'deepseek-v4-flash', permission: 'full' },
    ))
  })

  it('adds an image dropped anywhere in the active chat to the composer', async () => {
    const api = mockApi()
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)
    await screen.findByLabelText('选择图片')
    const file = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], 'dropped.png')
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }

    fireEvent.dragEnter(window, { dataTransfer })
    expect(screen.getByText('松开即可添加图片')).toBeInTheDocument()
    fireEvent.drop(window, { dataTransfer })

    expect(await screen.findByAltText('dropped.png')).toBeInTheDocument()
    expect(screen.queryByText('松开即可添加图片')).not.toBeInTheDocument()
  })

  it('reconciles a failed send before persistence and tells the user', async () => {
    const api = mockApi()
    api.chat.sendPrivate = vi.fn(async () => { throw new Error('智能体不存在') })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '待发送内容' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('发送失败，消息未保存。请重试。')).toBeInTheDocument()
    expect(document.querySelector('.message.user')).not.toBeInTheDocument()
    expect(input).toHaveValue('待发送内容')
    expect(api.chat.messages).toHaveBeenCalledTimes(2)
  })

  it('keeps an already persisted message when the send call fails', async () => {
    const api = mockApi()
    api.chat.sendPrivate = vi.fn(async () => { throw new Error('response lost') })
    api.chat.messages = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'saved', scope: 'private', scopeId: agent.id, authorType: 'user',
        authorName: '你', content: '已经保存', sequence: 1, createdAt: new Date().toISOString(),
      }])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '已经保存' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('发送未完成，请检查会话后再重试。')).toBeInTheDocument()
    expect(screen.getAllByText('已经保存')).toHaveLength(1)
  })

  it('keeps a pending message when persistence cannot be checked', async () => {
    const api = mockApi()
    api.chat.sendPrivate = vi.fn(async () => { throw new Error('send failed') })
    api.chat.messages = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('read failed'))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '状态未知' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('发送状态未确认，请检查会话后再重试。')).toBeInTheDocument()
    expect(document.querySelector('.message.user')).toHaveTextContent('状态未知')
  })

  it('does not show a failed send in another conversation', async () => {
    const second = { ...agent, id: 'developer', name: 'Developer' }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [agent, second])
    let rejectSend!: (error: Error) => void
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((_resolve, reject) => { rejectSend = reject }))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '仅发给 Researcher' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: /Developer 研究分析专家/ }))
    await screen.findByPlaceholderText('给 Developer 发送消息…')
    await act(async () => rejectSend(new Error('send failed')))
    expect(screen.queryByText('发送失败，消息未保存。请重试。')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('给 Developer 发送消息…')).toHaveValue('')
  })

  it('completes a Chinese agent mention in a space message', async () => {
    const chineseAgent = { ...agent, id: 'analyst', name: '数据分析师' }
    const space: Space = { id: 'space', name: '协作', description: '', context: '',
      memberIds: [chineseAgent.id], createdAt: '' }
    const api = mockApi()
    api.agents.list = vi.fn(async () => [chineseAgent])
    api.spaces.list = vi.fn(async () => [space])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '协作空间' }))
    const input = await screen.findByPlaceholderText('@智能体 输入消息…')
    fireEvent.change(input, { target: { value: '你好 @数据' } })
    fireEvent.click(screen.getByRole('button', { name: /数据分析师/ }))
    expect(input).toHaveValue('你好 @数据分析师 ')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.chat.sendSpace).toHaveBeenCalledWith(
      'space', '你好 @数据分析师', [], { model: 'deepseek-v4-flash', permission: 'full' },
    ))
  })

  it('renders a sent user Markdown message as structured content', async () => {
    const api = mockApi()
    let resolveSend!: (messages: Message[]) => void
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '## 问题\n\n**重点**\n\n- 第一项\n- 第二项\n\n```ts\nconst ok = true\n```' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const message = screen.getByRole('heading', { name: '问题' }).closest('.message.user')!
    expect(message.querySelector('.message-body strong')).toHaveTextContent('重点')
    expect(message.querySelector('ul')).toHaveTextContent('第一项')
    expect(message.querySelector('pre')).toHaveTextContent('const ok = true')
    expect(message).not.toHaveTextContent('## 问题')
    await act(async () => resolveSend([]))
  })

  it('keeps separate reasoning paragraphs in a collapsed reply', async () => {
    const api = mockApi()
    api.chat.messages = vi.fn(async () => [{
      id: 'reply', scope: 'private' as const, scopeId: agent.id, authorType: 'agent' as const,
      authorName: agent.name, content: '最终回答', reasoning: '第一步\n\n第二步',
      sequence: 1, createdAt: new Date().toISOString(),
    }])
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const summary = await screen.findByText('思考过程')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(details.querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByText('最终回答')).toBeInTheDocument()
    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })

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
      agentId: agent.id, kind: 'reasoning', text: '先分析\n\n再回答' }))
    const thinking = screen.getByText('思考过程').closest('details')!
    expect(thinking.open).toBe(true)
    await waitFor(() => expect(thinking.querySelectorAll('p')).toHaveLength(2))
    act(() => notify({ requestId: 'request', scope: 'private', scopeId: agent.id,
      agentId: agent.id, text: '**正在生成**' }))
    await waitFor(() => expect(screen.getByText('正在生成').tagName).toBe('STRONG'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(async () => resolveSend([]))
  })

  it('turns the send button into an enabled stop button while a reply is pending', async () => {
    const api = mockApi()
    let notify!: (event: ChatDelta) => void
    let resolveSend!: (messages: Message[]) => void
    let resolveStop!: (stopped: boolean) => void
    api.chat.onDelta = vi.fn((listener) => { notify = listener; return () => undefined })
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((resolve) => { resolveSend = resolve }))
    const stop = vi.fn(() => new Promise<boolean>((resolve) => { resolveStop = resolve }))
    api.chat.stop = stop
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '请分析' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const stopButton = await screen.findByRole('button', { name: '停止生成' })
    expect(stopButton).toBeEnabled()
    fireEvent.click(stopButton)
    await waitFor(() => expect(stop).toHaveBeenCalledWith('private', agent.id))
    act(() => notify({ requestId: 'late', scope: 'private', scopeId: agent.id,
      agentId: agent.id, text: '停止后不应显示' }))
    expect(screen.queryByText('停止后不应显示')).not.toBeInTheDocument()
    await act(async () => resolveStop(true))
    const stoppedButton = await screen.findByRole('button', { name: '已停止' })
    expect(stoppedButton).toBeDisabled()
    fireEvent.click(stoppedButton)
    expect(stop).toHaveBeenCalledOnce()
    await act(async () => resolveSend([]))
    expect(await screen.findByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('ignores a stop result that arrives after its generation settled', async () => {
    const api = mockApi()
    const sendResolvers: Array<(messages: Message[]) => void> = []
    let resolveStop!: (stopped: boolean) => void
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>((resolve) => { sendResolvers.push(resolve) }))
    api.chat.stop = vi.fn(() => new Promise<boolean>((resolve) => { resolveStop = resolve }))
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '第一轮' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: '停止生成' }))
    await act(async () => sendResolvers[0]([]))
    expect(await screen.findByRole('button', { name: '发送' })).toBeDisabled()

    await act(async () => resolveStop(true))
    fireEvent.change(input, { target: { value: '第二轮' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('button', { name: '停止生成' })).toBeEnabled()
    await act(async () => sendResolvers[1]([]))
  })

  it('shows a retryable error when stopping the model fails', async () => {
    const api = mockApi()
    api.chat.sendPrivate = vi.fn(() => new Promise<Message[]>(() => undefined))
    api.chat.stop = vi.fn(async () => { throw new Error('close failed') })
    Object.defineProperty(window, 'mindmesh', { configurable: true, value: api })
    render(<App />)

    const input = await screen.findByPlaceholderText('给 Researcher 发送消息…')
    fireEvent.change(input, { target: { value: '请分析' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: '停止生成' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('未能停止生成，请重试')
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
      reasoning: '先分析问题\n\n再整理答案',
      sequence: 1, createdAt: new Date().toISOString(),
    }]))
    expect(screen.queryByText('这是一段需要逐字展示的完整回答。')).not.toBeInTheDocument()
    expect(await screen.findByText('这是一段需要逐字展示的完整回答。')).toBeInTheDocument()
    const details = screen.getByText('思考过程').closest('details')!
    expect(details.open).toBe(true)
    fireEvent.click(screen.getByText('思考过程'))
    expect(details.open).toBe(false)
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
