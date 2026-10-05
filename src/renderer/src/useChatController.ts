import { useEffect, useRef, useState } from 'react'
import type {
  Agent,
  ChatImageAttachment,
  ChatProgress,
  ChatRunOptions,
  Message,
  RuntimeStatus,
} from '../../shared/contracts'

type ChatTarget = {
  scope: Message['scope']
  id: string
  agent?: Agent
} | null

export type ToolCallState = {
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
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ChatProgress | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([])
  const liveReplyIds = useRef(new Set<string>())
  const activeRun = useRef<{ scope: Message['scope']; id: string; stopRequested: boolean } | null>(
    null
  )
  const sendRevision = useRef(0)
  const conversation = target ? `${target.scope}:${target.id}` : ''
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
      setProgress(event)
      setStreamingText('')
      setStreamingReasoning('')
      if (event.scope === 'space') {
        void window.mindmesh.chat.messages(event.scope, event.scopeId).then((next) => {
          if (conversationRef.current === `${event.scope}:${event.scopeId}`) showLiveMessages(next)
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

      switch (event.type) {
        case 'text:delta':
          setStreamingText((current) => current + event.text)
          break
        case 'reasoning:delta':
          setStreamingReasoning((current) => current + event.text)
          break
        case 'tool:start':
          setToolCalls((current) => [
            ...current,
            {
              callId: event.callId,
              toolName: event.toolName,
              displayName: event.displayName,
              status: 'running',
              output: '',
              truncated: false,
            },
          ])
          break
        case 'tool:delta':
          setToolCalls((current) =>
            current.map((call) =>
              call.callId === event.callId
                ? { ...call, output: call.output + event.text }
                : call
            )
          )
          break
        case 'tool:output':
          setToolCalls((current) =>
            current.map((call) =>
              call.callId === event.callId
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
              call.callId === event.callId && call.status === 'running'
                ? { ...call, status: event.aborted ? 'aborted' : call.status }
                : call
            )
          )
          break
        case 'run:end':
          setToolCalls([])
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
    const revision = sendRevision.current
    setMessages([])
    setStreamingText('')
    setStreamingReasoning('')
    setToolCalls([])
    liveReplyIds.current.clear()
    void window.mindmesh.chat.messages(target.scope, target.id).then((next) => {
      // A history read started before a send must not overwrite its pending message or result.
      if (active && revision === sendRevision.current) setMessages(next)
    })
    return () => {
      active = false
    }
  }, [target?.scope, target?.id])

  async function send(
    content: string,
    attachments: ChatImageAttachment[] = [],
    options: ChatRunOptions = {}
  ): Promise<boolean> {
    if ((!content.trim() && attachments.length === 0) || busy) return true
    if (!target) return false
    sendRevision.current += 1
    const { scope, id } = target
    const requestConversation = `${scope}:${id}`
    const requestRun = { scope, id, stopRequested: false }
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
      const runOptions = Object.keys(options).length > 0 ? options : undefined
      const result =
        scope === 'private'
          ? runOptions
            ? await window.mindmesh.chat.sendPrivate(id, content.trim(), attachments, runOptions)
            : attachments.length > 0
              ? await window.mindmesh.chat.sendPrivate(id, content.trim(), attachments)
              : await window.mindmesh.chat.sendPrivate(id, content.trim())
          : runOptions
            ? await window.mindmesh.chat.sendSpace(id, content.trim(), attachments, runOptions)
            : attachments.length > 0
              ? await window.mindmesh.chat.sendSpace(id, content.trim(), attachments)
              : await window.mindmesh.chat.sendSpace(id, content.trim())
      if (conversationRef.current === requestConversation) {
        showLiveMessages(result, !requestRun.stopRequested)
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
        next = await window.mindmesh.chat.messages(scope, id)
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
      const stopped = await window.mindmesh.chat.stop(request.scope, request.id)
      if (!stopped) request.stopRequested = false
      return stopped
    } catch (error) {
      request.stopRequested = false
      throw error
    }
  }

  return {
    messages,
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
