import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, UserProfile } from '../../shared/contracts'
import type { ToolCallState } from './useChatController'
import { toolStatusPhrase } from '../../shared/tool-display'
import { Avatar } from './Ui'
import { BrandLogo } from './BrandLogo'

export function MessageList({
  messages,
  profile,
  emptyText,
  progress,
  streamingText,
  streamingReasoning,
  liveReplyIds,
  toolCalls = [],
  starters = [],
  onStarter,
}: {
  messages: Message[]
  profile: UserProfile
  emptyText: string
  progress?: string
  streamingText: string
  streamingReasoning: string
  liveReplyIds: Set<string>
  toolCalls?: ToolCallState[]
  starters?: string[]
  onStarter?: (starter: string) => void
}): React.JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  const hasScrolled = useRef(false)
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef({
    ids: new Set<string>(),
    tools: new Map<string, ToolCallState['status']>(),
    progress: undefined as string | undefined,
  })
  useEffect(() => {
    const notices: string[] = []
    // Initial history loading is silent; only newly persisted replies are read.
    if (previous.current.ids.size) {
      for (const message of messages) {
        if (message.authorType !== 'user' && !previous.current.ids.has(message.id)) {
          notices.push(
            `${message.authorName}${message.stopped ? '，已停止' : ''}：${message.content}`
          )
        }
      }
    }
    for (const call of toolCalls) {
      if (previous.current.tools.get(call.key) !== call.status) {
        notices.push(`${call.displayName}，${TOOL_STATUS_LABEL[call.status]}`)
      }
    }
    if (progress && progress !== previous.current.progress) notices.push(`${progress} 正在思考`)
    previous.current = {
      ids: new Set(messages.map((message) => message.id)),
      tools: new Map(toolCalls.map((call) => [call.key, call.status])),
      progress,
    }
    if (notices.length) setAnnouncement(notices.join('。'))
  }, [messages, toolCalls, progress])
  useLayoutEffect(() => {
    if (!end.current) return
    end.current.scrollIntoView({ behavior: hasScrolled.current ? 'smooth' : 'auto' })
    hasScrolled.current = true
  }, [messages, progress, streamingText, streamingReasoning, toolCalls])
  const runningTool = toolCalls.find((call) => call.status === 'running')
  if (!messages.length && !progress && !streamingText && !streamingReasoning && !toolCalls.length)
    return (
      <div className="conversation-empty">
        <span className="empty-mark">
          <BrandLogo size={34} />
        </span>
        <h3>{emptyText}</h3>
        <p>消息仅保存在这台设备上，不会自动上传。</p>
        {starters.length > 0 && (
          <div className="suggestion-row">
            {starters.map((starter) => (
              <button key={starter} className="suggestion" onClick={() => onStarter?.(starter)}>
                {starter}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  return (
    <div className="messages" role="log" aria-live="polite" aria-relevant="additions text">
      <span className="visually-hidden" aria-atomic="true" data-announcement>
        {announcement}
      </span>
      {messages.map((message) => (
        <article key={message.id} className={`message ${message.authorType}`} aria-live="off">
          <Avatar
            name={message.authorType === 'user' ? profile.name : message.authorName}
            image={message.authorType === 'user' ? profile.avatar : null}
          />
          <div>
            <header>
              <strong>{message.authorType === 'user' ? profile.name : message.authorName}</strong>
              {message.stopped && <span className="stopped-badge">已停止 · 回复可能不完整</span>}
              <time>
                {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </header>
            {message.reasoning && (
              <ReasoningDetails
                content={message.reasoning}
                initiallyOpen={liveReplyIds.has(message.id)}
              />
            )}
            {!!message.toolCalls?.length && (
              <ToolCards
                calls={message.toolCalls.map((call) => ({
                  id: call.id,
                  displayName: call.displayName,
                  status: call.status,
                  output: call.output,
                  truncated: false,
                }))}
              />
            )}
            {!!message.attachments?.length && (
              <div className="message-attachments">
                {message.attachments.map((attachment, index) => (
                  <img
                    key={`${attachment.name}-${index}`}
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.name}
                  />
                ))}
              </div>
            )}
            {message.content && (
              <MessageBody content={message.content} animated={liveReplyIds.has(message.id)} />
            )}
          </div>
        </article>
      ))}
      {(progress || streamingText || streamingReasoning || toolCalls.length > 0) && (
        <article className="message agent" aria-live="off">
          <Avatar name={progress ?? '智能体'} />
          <div>
            <header>
              <strong>{progress ?? '智能体'}</strong>
            </header>
            {streamingReasoning && <ReasoningDetails content={streamingReasoning} initiallyOpen />}
            {toolCalls.length > 0 && (
              <ToolCards
                calls={toolCalls.map((call) => ({
                  id: call.key,
                  displayName: call.displayName,
                  status: call.status,
                  output: call.output,
                  truncated: call.truncated,
                }))}
              />
            )}
            {streamingText ? (
              <MessageBody content={streamingText} />
            ) : (
              !streamingReasoning && (
                <div className="chat-progress" role="status" aria-live="off">
                  <span className="chat-progress-dot" />
                  {runningTool ? toolStatusPhrase(runningTool.toolName) : '思考中'}…
                </div>
              )
            )}
          </div>
        </article>
      )}
      <div ref={end} />
    </div>
  )
}

const TOOL_STATUS_LABEL: Record<ToolCallState['status'], string> = {
  running: '执行中',
  ok: '已完成',
  error: '失败',
  aborted: '已中止',
}

/** A tool call shaped for rendering, from either a live event or a stored row. */
type ToolCardItem = {
  id: string
  displayName: string
  status: ToolCallState['status']
  output: string
  truncated: boolean
}

function ToolCards({ calls }: { calls: ToolCardItem[] }): React.JSX.Element {
  return (
    <div className="tool-cards">
      {calls.map((call) => (
        <details key={call.id} className={`tool-card ${call.status}`}>
          <summary>
            <span className="tool-card-status" aria-hidden>
              {call.status === 'running'
                ? '…'
                : call.status === 'ok'
                  ? '✓'
                  : call.status === 'error'
                    ? '✕'
                    : '⊘'}
            </span>
            <span className="tool-card-name">{call.displayName}</span>
            <span className="visually-hidden">{TOOL_STATUS_LABEL[call.status]}</span>
            {call.truncated && <span className="tool-card-truncated">已截断</span>}
          </summary>
          {call.output && (
            <pre className="tool-card-output">
              {call.output}
              {call.truncated ? '\n…(已截断)' : ''}
            </pre>
          )}
        </details>
      ))}
    </div>
  )
}

function ReasoningDetails({
  content,
  initiallyOpen = false,
  animated = false,
}: {
  content: string
  initiallyOpen?: boolean
  animated?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <details
      className="reasoning-details"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>思考过程</summary>
      <MessageBody content={content} animated={animated} />
    </details>
  )
}

function MessageBody({
  content,
  animated = false,
}: {
  content: string
  animated?: boolean
}): React.JSX.Element {
  const [visible, setVisible] = useState(animated ? '' : content)
  useEffect(() => {
    if (!animated || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setVisible(content)
      return
    }
    const characters = Array.from(content)
    const perFrame = Math.max(1, Math.ceil(characters.length / 60))
    let count = content.startsWith(visible) ? Array.from(visible).length : 0
    const timer = window.setInterval(() => {
      count = Math.min(count + perFrame, characters.length)
      setVisible(characters.slice(0, count).join(''))
      if (count === characters.length) window.clearInterval(timer)
    }, 25)
    return () => window.clearInterval(timer)
  }, [animated, content])
  return (
    <div className="message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={['img']}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {visible}
      </ReactMarkdown>
    </div>
  )
}
