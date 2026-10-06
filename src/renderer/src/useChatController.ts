import { useEffect, useRef, useState } from 'react'
import { toolCallKey } from '../../shared/tool-display'
import type {
  Agent,
  Artifact,
  ChatImageAttachment,
  ChatProgress,
  ChatRunOptions,
  Conversation,
  Execution,
  Message,
  RuntimeStatus,
} from '../../shared/contracts'

type ChatTarget = {
  scope: Message['scope']
  id: string
  agent?: Agent
} | null

export type ToolCallState = {
  key: string
  callId: string
  toolName: string
  displayName: string
  status: 'running' | 'ok' | 'error' | 'aborted'
  output: string
  truncated: boolean
}

export function useChatController(
  target: ChatTarget,
  profileName: string,
  onRuntime: (runtime: RuntimeStatus) => void
): {
  messages: Message[]
  artifacts: Artifact[]
  conversations: Conversation[]
  conversationId: string
  conversationReady: boolean
  conversationError: string
  executions: Execution[]
  selectConversation: (id: string) => void
  createConversation: () => Promise<void>
  renameConversation: (title: string) => Promise<void>
  archiveConversation: () => Promise<void>
  regenerate: () => Promise<void>
  busy: boolean
  progress: ChatProgress | null
  streamingText: string
  streamingReasoning: string
  liveReplyIds: Set<string>
  toolCalls: ToolCallState[]
  send: (
    content: string,
    attachments?: ChatImageAttachment[],
    options?: ChatRunOptions
  ) => Promise<boolean>
  stop: () => Promise<boolean>
} {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selection, setSelection] = useState({ owner: '', id: '' })
  const [conversationError, setConversationError] = useState('')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [executions, setExecutions] = useState<Execution[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ChatProgress | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([])
  const toolCallKeys = useRef(new Map<string, string>())
  const liveReplyIds = useRef(new Set<string>())
  const activeRun = useRef<{
    scope: Message['scope']
    id: string
    conversationId: string
    stopRequested: boolean
  } | null>(null)
  const sendRevision = useRef(0)
  const owner = target ? `${target.scope}:${target.id}` : ''
  const conversation = selection.owner === owner ? selection.id : ''
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation

  function showLiveMessages(next: Message[], animated = true): void {
    setMessages((current) => {
      const known = new Set(current.map((message) => message.id))
      for (const message of next) {
        if (animated && message.authorType === 'agent' && !known.has(message.id))
          liveReplyIds.current.add(message.id)
      }
      return next
    })
  }

  useEffect(() => {
    const offProgress = window.mindmesh.chat.onProgress((event) => {
      if (conversationRef.current !== (event.conversationId ?? `${event.scope}:${event.scopeId}`))
        return
      setProgress(event)
      setStreamingText('')
      setStreamingReasoning('')
      if (event.scope === 'space') {
        void window.mindmesh.chat
          .messages(event.scope, event.scopeId, event.conversationId)
          .then((next) => {
            if (
              conversationRef.current ===
              (event.conversationId ?? `${event.scope}:${event.scopeId}`)
            )
              showLiveMessages(next)
          })
      }
    })
    // The legacy chat:delta channel is superseded by onRuntimeEvent, which carries
    // the same text/reasoning deltas. Subscribing to both would append every token
    // twice, so body text and reasoning come only from onRuntimeEvent now.
    const offRuntimeEvent = window.mindmesh.chat.onRuntimeEvent((event) => {
      if (conversationRef.current !== event.conversationId) return
      const request = activeRun.current
      if (request?.stopRequested) {
        // After a stop, only the terminal event and the aborted tool closures
        // (which Main now forwards) may pass; body deltas are suppressed.
        const isToolClose = event.type === 'tool:end' && event.aborted
        if (event.type !== 'run:end' && !isToolClose) return
      }

      const nativeKey =
        'callId' in event ? toolCallKey(event.requestId, event.sessionId, event.callId) : ''
      const key = toolCallKeys.current.get(nativeKey)
      switch (event.type) {
        case 'run:start':
          // A new run begins with a clean tool slate; the previous run's tools
          // stay visible until then so a completed reply keeps its audit trail.
          setToolCalls([])
          toolCallKeys.current.clear()
          break
        case 'text:delta':
          setStreamingText((current) => current + event.text)
          break
        case 'reasoning:delta':
          setStreamingReasoning((current) => current + event.text)
          break
        case 'tool:start': {
          const key = crypto.randomUUID()
          toolCallKeys.current.set(nativeKey, key)
          setToolCalls((current) => [
            ...current,
            {
              key,
              callId: event.callId,
              toolName: event.toolName,
              displayName: event.displayName,
              status: 'running',
              output: '',
              truncated: false,
            },
          ])
          break
        }
        case 'tool:delta':
          setToolCalls((current) =>
            current.map((call) =>
              call.key === key ? { ...call, output: call.output + event.text } : call
            )
          )
          break
        case 'tool:output':
          setToolCalls((current) =>
            current.map((call) =>
              call.key === key
                ? {
                    ...call,
                    output: event.text,
                    status: event.isError ? 'error' : 'ok',
                    truncated: event.truncated,
                  }
                : call
            )
          )
          break
        case 'tool:end':
          setToolCalls((current) =>
            current.map((call) =>
              call.key === key && call.status === 'running'
                ? { ...call, status: event.aborted ? 'aborted' : call.status }
                : call
            )
          )
          toolCallKeys.current.delete(nativeKey)
          break
        case 'run:end':
          // Keep the tool audit trail until the next run starts or the target
          // changes; clearing here would hide the terminal aborted/error state.
          break
      }
    })
    return () => {
      offProgress()
      offRuntimeEvent()
    }
  }, [])

  useEffect(() => {
    if (!target) return
    let active = true
    setConversations([])
    setConversationError('')
    void window.mindmesh.chat
      .conversations(target.scope, target.id)
      .then((next) => {
        if (!active) return
        setConversations(next)
        setSelection({ owner, id: next.find((item) => !item.archivedAt)?.id ?? '' })
      })
      .catch(() => {
        if (active) {
          setSelection({ owner, id: '' })
          setConversationError('对话列表加载失败，请重新选择智能体或空间。')
        }
      })
    return () => {
      active = false
    }
  }, [owner])

  useEffect(() => {
    setMessages([])
    setExecutions([])
    setArtifacts([])
    setProgress(null)
    setStreamingText('')
    setStreamingReasoning('')
    setToolCalls([])
    if (!target || !conversation) return
    let active = true
    const revision = sendRevision.current
    setConversationError('')
    toolCallKeys.current.clear()
    liveReplyIds.current.clear()
    void window.mindmesh.chat
      .messages(target.scope, target.id, conversation)
      .then((next) => {
        // A history read started before a send must not overwrite its pending message or result.
        if (active && revision === sendRevision.current) setMessages(next)
      })
      .catch(() => {
        if (active && revision === sendRevision.current)
          setConversationError('消息加载失败，请重新选择对话。')
      })
    void window.mindmesh.chat
      .executions(conversation)
      .then((next) => {
        if (active && revision === sendRevision.current) setExecutions(next)
      })
      .catch(() => {
        if (active && revision === sendRevision.current)
          setConversationError('回答版本加载失败，请重新选择对话。')
      })
    void window.mindmesh.chat
      .artifacts(conversation)
      .then((next) => {
        if (active && revision === sendRevision.current) setArtifacts(next)
      })
      .catch(() => {
        if (active && revision === sendRevision.current)
          setConversationError('成果加载失败，请重新选择对话。')
      })
    return () => {
      active = false
    }
  }, [conversation])

  async function refreshOutputs(id: string): Promise<void> {
    const results = await Promise.allSettled([
      window.mindmesh.chat.executions(id),
      window.mindmesh.chat.artifacts(id),
    ])
    if (conversationRef.current !== id) return
    if (results[0].status === 'fulfilled') setExecutions(results[0].value)
    if (results[1].status === 'fulfilled') setArtifacts(results[1].value)
    if (results.some((item) => item.status === 'rejected'))
      setConversationError('执行记录或成果加载失败，请重新选择对话。')
  }

  async function send(
    content: string,
    attachments: ChatImageAttachment[] = [],
    options: ChatRunOptions = {}
  ): Promise<boolean> {
    if ((!content.trim() && attachments.length === 0) || busy) return true
    if (!target || !conversation) return false
    sendRevision.current += 1
    const { scope, id } = target
    const requestConversation = conversation
    const requestRun = { scope, id, conversationId: conversation, stopRequested: false }
    const knownIds = new Set(messages.map((message) => message.id))
    activeRun.current = requestRun
    setBusy(true)
    setStreamingText('')
    setStreamingReasoning('')
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        scope,
        scopeId: id,
        authorType: 'user',
        authorName: profileName,
        content: content.trim(),
        attachments,
        sequence: 0,
        createdAt: new Date().toISOString(),
      },
    ])
    if (scope === 'private' && target.agent) {
      setProgress({ scope, scopeId: id, agentName: target.agent.name })
    }
    try {
      const runOptions = { ...options, conversationId: conversation }
      const result =
        scope === 'private'
          ? await window.mindmesh.chat.sendPrivate(id, content.trim(), attachments, runOptions)
          : await window.mindmesh.chat.sendSpace(id, content.trim(), attachments, runOptions)
      if (conversationRef.current === requestConversation) {
        showLiveMessages(result, !requestRun.stopRequested)
        await refreshOutputs(requestConversation)
        setStreamingText('')
        setStreamingReasoning('')
        setToolCalls([])
      }
      try {
        onRuntime(await window.mindmesh.runtime.status())
      } catch {
        /* A status refresh must not turn a completed send into a failure. */
      }
      return true
    } catch {
      let saved = true
      let next: Message[] | null = null
      try {
        next = await window.mindmesh.chat.messages(scope, id, requestConversation)
        saved = next.some((message) => message.authorType === 'user' && !knownIds.has(message.id))
      } catch {
        /* Keep the pending message when persistence cannot be checked. */
      }
      if (conversationRef.current === requestConversation) {
        const error = next
          ? saved
            ? '发送未完成，请检查会话后再重试。'
            : '发送失败，消息未保存。请重试。'
          : '发送状态未确认，请检查会话后再重试。'
        const notice: Message = {
          id: crypto.randomUUID(),
          scope,
          scopeId: id,
          authorType: 'system',
          authorName: 'MindMesh',
          content: error,
          sequence: 0,
          createdAt: new Date().toISOString(),
        }
        setMessages((current) => [...(next ?? current), notice])
        setStreamingText('')
        setStreamingReasoning('')
        setToolCalls([])
      }
      return saved || conversationRef.current !== requestConversation
    } finally {
      if (activeRun.current === requestRun) activeRun.current = null
      setProgress(null)
      setBusy(false)
    }
  }

  async function stop(): Promise<boolean> {
    const request = activeRun.current
    if (!request) return false
    request.stopRequested = true
    try {
      const stopped = await window.mindmesh.chat.stop(
        request.scope,
        request.id,
        request.conversationId
      )
      if (!stopped) request.stopRequested = false
      return stopped
    } catch (error) {
      request.stopRequested = false
      throw error
    }
  }

  async function refreshConversations(id: string): Promise<void> {
    if (!target) return
    const next = await window.mindmesh.chat.conversations(target.scope, target.id)
    if (ownerRef.current !== owner || conversationRef.current !== conversation) return
    setConversations(next)
    setSelection({ owner, id })
  }

  async function createConversation(): Promise<void> {
    if (!target || busy) return
    const next = await window.mindmesh.chat.createConversation(target.scope, target.id)
    await refreshConversations(next.id)
  }

  async function renameConversation(title: string): Promise<void> {
    await window.mindmesh.chat.renameConversation(conversation, title)
    await refreshConversations(conversation)
  }

  async function archiveConversation(): Promise<void> {
    if (!target || busy || !conversation) return
    await window.mindmesh.chat.archiveConversation(conversation)
    const next = await window.mindmesh.chat.conversations(target.scope, target.id)
    if (ownerRef.current !== owner || conversationRef.current !== conversation) return
    setConversations(next)
    setSelection({ owner, id: next.find((item) => !item.archivedAt)?.id ?? '' })
  }

  async function regenerate(): Promise<void> {
    if (!target || busy || !conversation) return
    const id = conversation
    const request = { scope: target.scope, id: target.id, conversationId: id, stopRequested: false }
    activeRun.current = request
    sendRevision.current += 1
    setBusy(true)
    setStreamingText('')
    setStreamingReasoning('')
    try {
      const next = await window.mindmesh.chat.regenerate(id)
      await refreshOutputs(id)
      if (conversationRef.current === id) {
        showLiveMessages(next, !request.stopRequested)
      }
    } catch (error) {
      const saved = await Promise.allSettled([
        window.mindmesh.chat.messages(target.scope, target.id, id),
        window.mindmesh.chat.executions(id),
        window.mindmesh.chat.artifacts(id),
      ])
      if (conversationRef.current === id) {
        if (saved[0].status === 'fulfilled') setMessages(saved[0].value)
        if (saved[1].status === 'fulfilled') setExecutions(saved[1].value)
        if (saved[2].status === 'fulfilled') setArtifacts(saved[2].value)
      }
      throw error
    } finally {
      if (activeRun.current === request) activeRun.current = null
      setBusy(false)
      setProgress(null)
      setStreamingText('')
      setStreamingReasoning('')
      setToolCalls([])
    }
  }

  return {
    conversations,
    conversationId: conversation,
    conversationReady: selection.owner === owner,
    conversationError,
    executions,
    selectConversation: (id) => {
      if (!busy) setSelection({ owner, id })
    },
    createConversation,
    renameConversation,
    archiveConversation,
    regenerate,
    messages,
    artifacts,
    busy,
    progress,
    streamingText,
    streamingReasoning,
    liveReplyIds: liveReplyIds.current,
    toolCalls,
    send,
    stop,
  }
}
