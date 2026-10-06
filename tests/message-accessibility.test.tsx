// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message, MindMeshApi, RuntimeEvent } from '../src/shared/contracts'
import { MessageList } from '../src/renderer/src/MessageList'
import { useChatController } from '../src/renderer/src/useChatController'

afterEach(cleanup)

describe('message announcements', () => {
  it('keeps repeated native tool IDs isolated in live cards', async () => {
    let notify!: (event: RuntimeEvent) => void
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: {
        chat: {
          conversations: async () => [{ id: 'private:a', archivedAt: null }],
          executions: async () => [],
          messages: async () => [],
          onProgress: () => () => {},
          onRuntimeEvent: (listener: typeof notify) => {
            notify = listener
            return () => {}
          },
        },
      } as unknown as MindMeshApi,
    })
    const { result } = renderHook(() =>
      useChatController({ scope: 'private', id: 'a' }, 'You', vi.fn())
    )
    await act(async () => {})
    const base = {
      requestId: 'r',
      conversationId: 'private:a',
      agentId: 'a',
      executionId: 'e',
      triggerMessageId: 'm',
      sessionId: 'root',
      seq: 1,
      time: 1,
      callId: 'c',
    }
    await act(async () => {
      notify({ ...base, type: 'tool:start', toolName: 'read', displayName: '读取文件' })
      notify({
        ...base,
        type: 'tool:output',
        seq: 2,
        text: 'first',
        isError: false,
        truncated: false,
      })
      notify({ ...base, type: 'tool:end', seq: 3, aborted: false })
      notify({ ...base, type: 'tool:start', seq: 4, toolName: 'read', displayName: '读取文件' })
      notify({
        ...base,
        type: 'tool:output',
        seq: 5,
        text: 'second',
        isError: false,
        truncated: false,
      })
      notify({
        ...base,
        sessionId: 'child',
        type: 'tool:start',
        toolName: 'read',
        displayName: '读取文件',
      })
    })
    expect(result.current.toolCalls.map((call) => call.output)).toEqual(['first', 'second', ''])
    expect(new Set(result.current.toolCalls.map((call) => call.key)).size).toBe(3)
  })

  it('announces final replies and tool states without announcing each delta', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn()
    const user: Message = {
      id: 'u',
      scope: 'private',
      scopeId: 'a',
      authorType: 'user',
      authorName: 'You',
      content: 'hello',
      sequence: 1,
      createdAt: '2026-10-06',
    }
    const props = {
      messages: [user],
      profile: { name: 'You', avatar: null },
      emptyText: '',
      streamingText: '',
      streamingReasoning: '',
      liveReplyIds: new Set<string>(),
    }
    const view = render(<MessageList {...props} />)
    const log = screen.getByRole('log')
    expect(log.getAttribute('aria-live')).toBe('polite')
    const announcement = () => log.querySelector('[data-announcement]')?.textContent
    await act(async () => view.rerender(<MessageList {...props} streamingText="token one" />))
    const before = announcement()
    await act(async () => view.rerender(<MessageList {...props} streamingText="token two" />))
    expect(announcement()).toBe(before)
    await act(async () =>
      view.rerender(
        <MessageList
          {...props}
          toolCalls={[
            {
              key: 'c',
              callId: 'c',
              toolName: 'read',
              displayName: '读取文件',
              status: 'running',
              output: '',
              truncated: false,
            },
          ]}
        />
      )
    )
    expect(announcement()).toContain('读取文件')
    expect(announcement()).toContain('执行中')
    await act(async () =>
      view.rerender(
        <MessageList
          {...props}
          messages={[
            user,
            {
              ...user,
              id: 'reply',
              authorType: 'agent',
              authorName: 'Agent',
              content: 'final answer',
              sequence: 2,
            },
          ]}
        />
      )
    )
    expect(announcement()).toContain('final answer')
  })
})
