import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, UserProfile } from '../../shared/contracts'
import { Avatar } from './Ui'
import { BrandLogo } from './BrandLogo'

export function MessageList({ messages, profile, emptyText, progress, streamingText, streamingReasoning, liveReplyIds, starters = [], onStarter }: { messages: Message[]; profile: UserProfile; emptyText: string; progress?: string; streamingText: string; streamingReasoning: string; liveReplyIds: Set<string>; starters?: string[]; onStarter?: (starter: string) => void }): React.JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  const hasScrolled = useRef(false)
  useLayoutEffect(() => {
    if (!end.current) return
    end.current.scrollIntoView({ behavior: hasScrolled.current ? 'smooth' : 'auto' })
    hasScrolled.current = true
  }, [messages, progress, streamingText, streamingReasoning])
  if (!messages.length && !progress && !streamingText && !streamingReasoning) return (
    <div className="conversation-empty">
      <span className="empty-mark">
        <BrandLogo size={34} />
      </span>
      <h3>{emptyText}</h3>
      <p>消息仅保存在这台设备上，不会自动上传。</p>
      {starters.length > 0 && <div className="suggestion-row">
        {starters.map((starter) => <button key={starter} className="suggestion" onClick={() => onStarter?.(starter)}>{starter}</button>)}
      </div>}
    </div>
  )
  return (
    <div className="messages">
      {messages.map((message) => <article key={message.id} className={`message ${message.authorType}`}>
        <Avatar name={message.authorType === 'user' ? profile.name : message.authorName} image={message.authorType === 'user' ? profile.avatar : null} />
        <div>
          <header>
            <strong>{message.authorType === 'user' ? profile.name : message.authorName}</strong>
            {message.stopped && <span className="stopped-badge">已停止 · 回复可能不完整</span>}
            <time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
          </header>
          {message.reasoning && <ReasoningDetails content={message.reasoning} initiallyOpen={liveReplyIds.has(message.id)} />}
          {!!message.attachments?.length && <div className="message-attachments">
            {message.attachments.map((attachment, index) => <img key={`${attachment.name}-${index}`} src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} />)}
          </div>}
          {message.content && <MessageBody content={message.content} animated={liveReplyIds.has(message.id)} />}
        </div>
      </article>)}
      {(progress || streamingText || streamingReasoning) && <article className="message agent">
        <Avatar name={progress ?? '智能体'} />
        <div>
          <header>
            <strong>{progress ?? '智能体'}</strong>
          </header>
          {streamingReasoning && <ReasoningDetails content={streamingReasoning} initiallyOpen />}
          {streamingText ? <MessageBody content={streamingText} /> : !streamingReasoning && <div className="chat-progress" role="status">
            <span className="chat-progress-dot" />思考中…</div>}
        </div>
      </article>}
      <div ref={end} />
    </div>
  )
}

function ReasoningDetails({ content, initiallyOpen = false, animated = false }: { content: string; initiallyOpen?: boolean; animated?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <details className="reasoning-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>思考过程</summary>
      <MessageBody content={content} animated={animated} />
    </details>
  )
}

function MessageBody({ content, animated = false }: { content: string; animated?: boolean }): React.JSX.Element {
  const [visible, setVisible] = useState(animated ? '' : content)
  useEffect(() => {
    if (!animated || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setVisible(content); return }
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{visible}</ReactMarkdown>
    </div>
  )
}
