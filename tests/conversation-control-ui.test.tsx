// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Execution, Message, MindMeshApi } from '../src/shared/contracts'
import {
  ConversationControls,
  visibleGenerationMessages,
} from '../src/renderer/src/ConversationControls'
import { MessageList } from '../src/renderer/src/MessageList'
import { useChatController } from '../src/renderer/src/useChatController'

afterEach(cleanup)
const executions: Execution[] = [1, 2].map((generationIndex) => ({
  id: `e${generationIndex}`,
  conversationId: 'c',
  triggerMessageId: 'u',
  generationIndex,
  status: 'completed',
  regeneratedFromExecutionId: generationIndex === 1 ? null : 'e1',
}))
const messages: Message[] = [
  {
    id: 'u',
    scope: 'private',
    scopeId: 'a',
    authorType: 'user',
    authorName: 'You',
    content: 'question',
    sequence: 1,
    createdAt: '',
  },
  ...executions.map(
    (e, index): Message => ({
      id: e.id,
      executionId: e.id,
      scope: 'private',
      scopeId: 'a',
      authorType: 'agent',
      authorName: 'Agent',
      content: `answer-${index + 1}`,
      sequence: index + 2,
      createdAt: '',
    })
  ),
]
const conversations: Conversation[] = [
  {
    id: 'c',
    scope: 'private',
    scopeId: 'a',
    title: 'Task',
    archivedAt: null,
    createdAt: '',
    updatedAt: '',
  },
]

describe('conversation controls', () => {
  it('retains reply content when version metadata is unavailable', () => {
    expect(visibleGenerationMessages(messages, [], {}).map((m) => m.id)).toEqual(['u', 'e1', 'e2'])
  })
  it('shows the latest generation and switches versions without execution', () => {
    const onRegenerate = vi.fn()
    const onMessages = vi.fn()
    render(
      <ConversationControls
        conversations={conversations}
        conversationId="c"
        executions={executions}
        messages={messages}
        busy={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onRegenerate={onRegenerate}
        onMessages={onMessages}
      />
    )
    expect(visibleGenerationMessages(messages, executions, {}).map((m) => m.id)).toEqual([
      'u',
      'e2',
    ])
    fireEvent.click(screen.getByLabelText('上一回答版本'))
    expect(onMessages).toHaveBeenCalledWith({ u: 'e1' })
    expect(visibleGenerationMessages(messages, executions, { u: 'e1' }).map((m) => m.id)).toEqual([
      'u',
      'e1',
    ])
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(screen.getByText('回答版本 1 / 2')).toBeTruthy()
  })

  it('keeps new conversation enabled when every conversation is archived', () => {
    render(
      <ConversationControls
        conversations={[]}
        conversationId=""
        executions={[]}
        messages={[]}
        busy={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onRegenerate={vi.fn()}
        onMessages={vi.fn()}
      />
    )
    expect((screen.getByText('新对话') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByText('重新生成最后一轮') as HTMLButtonElement).disabled).toBe(true)
  })

  it('copies the displayed reply and reports clipboard failure', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn()
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(
      <MessageList
        messages={[messages[2]]}
        profile={{ name: 'You', avatar: null }}
        emptyText=""
        streamingText=""
        streamingReasoning=""
        liveReplyIds={new Set()}
      />
    )
    fireEvent.click(screen.getByLabelText('复制 Agent 的回复'))
    await screen.findByText('已复制回复')
    expect(writeText).toHaveBeenCalledWith('answer-2')
    fireEvent.click(screen.getByLabelText('复制 Agent 的回复'))
    await screen.findByText('复制失败，请重试。')
  })

  it('does not route another conversation progress or overwrite the new selection with stale reads', async () => {
    let notify!: (event: {
      scope: 'private'
      scopeId: string
      conversationId: string
      agentName: string
    }) => void
    let finishOld!: (value: Message[]) => void
    const api = {
      conversations: vi.fn(async () => [...conversations, { ...conversations[0], id: 'other' }]),
      messages: vi.fn(async (_scope, _id, conversationId) =>
        conversationId === 'c'
          ? new Promise<Message[]>((resolve) => {
              finishOld = resolve
            })
          : []
      ),
      executions: vi.fn(async () => []),
      onProgress: (listener: typeof notify) => {
        notify = listener
        return () => {}
      },
      onRuntimeEvent: () => () => {},
    }
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: { chat: api } as unknown as MindMeshApi,
    })
    const { result } = renderHook(() =>
      useChatController({ scope: 'private', id: 'a' }, 'You', vi.fn())
    )
    await waitFor(() => expect(result.current.conversationId).toBe('c'))
    act(() => result.current.selectConversation('other'))
    await act(async () => {
      finishOld(messages)
      notify({ scope: 'private', scopeId: 'a', conversationId: 'c', agentName: 'Old' })
    })
    expect(result.current.messages).toEqual([])
    expect(result.current.progress).toBeNull()
  })

  it('refreshes partial persisted generations when regeneration rejects', async () => {
    const api = {
      conversations: async () => conversations,
      messages: vi.fn().mockResolvedValueOnce(messages.slice(0, 2)).mockResolvedValue(messages),
      executions: vi
        .fn()
        .mockResolvedValueOnce(executions.slice(0, 1))
        .mockResolvedValue(executions),
      regenerate: vi.fn(async () => {
        throw new Error('Preparation failed')
      }),
      onProgress: () => () => {},
      onRuntimeEvent: () => () => {},
    }
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: { chat: api } as unknown as MindMeshApi,
    })
    const { result } = renderHook(() =>
      useChatController({ scope: 'private', id: 'a' }, 'You', vi.fn())
    )
    await waitFor(() => expect(result.current.executions).toHaveLength(1))
    await act(async () => {
      await expect(result.current.regenerate()).rejects.toThrow('Preparation failed')
    })
    expect(result.current.executions).toHaveLength(2)
    expect(
      visibleGenerationMessages(result.current.messages, result.current.executions, {}).map(
        (m) => m.id
      )
    ).toEqual(['u', 'e2'])
  })

  it('ignores the version query started before a send', async () => {
    let finishVersions!: (value: Execution[]) => void
    const api = {
      conversations: async () => conversations,
      messages: async () => [],
      executions: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Execution[]>((resolve) => {
              finishVersions = resolve
            })
        )
        .mockResolvedValue(executions),
      sendPrivate: async () => messages,
      onProgress: () => () => {},
      onRuntimeEvent: () => () => {},
    }
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: { chat: api } as unknown as MindMeshApi,
    })
    const { result } = renderHook(() =>
      useChatController({ scope: 'private', id: 'a' }, 'You', vi.fn())
    )
    await waitFor(() => expect(api.executions).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.send('question')
    })
    await act(async () => {
      finishVersions([])
    })
    expect(result.current.executions).toEqual(executions)
    expect(
      visibleGenerationMessages(result.current.messages, result.current.executions, {}).map(
        (m) => m.id
      )
    ).toEqual(['u', 'e2'])
  })
})
