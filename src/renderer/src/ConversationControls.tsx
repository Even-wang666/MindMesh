import { useState } from 'react'
import type { Conversation, Execution, Message } from '../../shared/contracts'

export function visibleGenerationItems<T extends { executionId?: string }>(
  messages: T[],
  executions: Execution[],
  selected: Record<string, string>
): T[] {
  const active = new Map<string, Execution>()
  for (const execution of executions) {
    const current = active.get(execution.triggerMessageId)
    if (!current || execution.generationIndex > current.generationIndex)
      active.set(execution.triggerMessageId, execution)
  }
  const visible = new Set(
    [...active.values()].map((item) => selected[item.triggerMessageId] ?? item.id)
  )
  const known = new Set(executions.map((item) => item.id))
  return messages.filter(
    (message) =>
      !message.executionId || !known.has(message.executionId) || visible.has(message.executionId)
  )
}

export function ConversationControls({
  conversations,
  conversationId,
  executions,
  messages,
  busy,
  onSelect,
  onCreate,
  onRename,
  onArchive,
  onRegenerate,
  onMessages,
}: {
  conversations: Conversation[]
  conversationId: string
  executions: Execution[]
  messages: Message[]
  busy: boolean
  onSelect: (id: string) => void
  onCreate: () => Promise<void>
  onRename: (title: string) => Promise<void>
  onArchive: () => Promise<void>
  onRegenerate: () => Promise<void>
  onMessages: (selection: Record<string, string>) => void
}): React.JSX.Element {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [rename, setRename] = useState<string | null>(null)
  const [selection, setSelection] = useState<Record<string, string>>({})
  const locked = busy || pending
  const current = conversations.find((item) => item.id === conversationId)
  const lastTrigger = messages.filter((message) => message.authorType === 'user').at(-1)
  const lastExecution = executions
    .filter((item) => item.triggerMessageId === lastTrigger?.id)
    .at(-1)

  async function act(action: () => Promise<void>): Promise<void> {
    setError('')
    setPending(true)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="conversation-controls">
      <div className="conversation-actions">
        <label>
          对话{' '}
          <select
            aria-label="切换对话"
            value={conversationId}
            disabled={locked}
            onChange={(event) => {
              setRename(null)
              setError('')
              onSelect(event.target.value)
            }}
          >
            <option value="" disabled>
              选择对话
            </option>
            {conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
                {item.archivedAt ? '（已归档）' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button compact"
          disabled={locked}
          onClick={() => void act(onCreate)}
        >
          新对话
        </button>
        <button
          className="ghost-button"
          disabled={locked || !current}
          onClick={() => setRename(current?.title ?? '')}
        >
          重命名
        </button>
        <button
          className="ghost-button"
          disabled={locked || !current || !!current.archivedAt}
          onClick={() => void act(onArchive)}
        >
          归档
        </button>
        <button
          className="secondary-button compact"
          disabled={locked || !lastExecution || !!current?.archivedAt}
          onClick={() =>
            void act(async () => {
              await onRegenerate()
              const next = { ...selection }
              if (lastTrigger) delete next[lastTrigger.id]
              setSelection(next)
              onMessages(next)
            })
          }
        >
          重新生成最后一轮
        </button>
      </div>
      {rename !== null && (
        <form
          className="conversation-actions"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              await onRename(rename)
              setRename(null)
            })
          }}
        >
          <input
            aria-label="对话名称"
            maxLength={200}
            value={rename}
            onChange={(event) => setRename(event.target.value)}
          />
          <button
            className="secondary-button compact"
            disabled={locked || !rename.trim()}
            type="submit"
          >
            保存名称
          </button>
          <button className="ghost-button" type="button" onClick={() => setRename(null)}>
            取消
          </button>
        </form>
      )}
      {[...new Set(executions.map((item) => item.triggerMessageId))].map((triggerId) => {
        const versions = executions
          .filter((item) => item.triggerMessageId === triggerId)
          .sort((a, b) => a.generationIndex - b.generationIndex)
        if (versions.length < 2) return null
        const index = Math.max(
          0,
          versions.findIndex((item) => item.id === (selection[triggerId] ?? versions.at(-1)?.id))
        )
        const choose = (nextIndex: number) => {
          const next = { ...selection, [triggerId]: versions[nextIndex].id }
          setSelection(next)
          onMessages(next)
        }
        return (
          <div className="generation-controls" key={triggerId}>
            <span title={messages.find((item) => item.id === triggerId)?.content}>
              回答版本 {index + 1} / {versions.length}
            </span>
            <button
              className="ghost-button"
              aria-label="上一回答版本"
              disabled={locked || index === 0}
              onClick={() => choose(index - 1)}
            >
              ‹
            </button>
            <button
              className="ghost-button"
              aria-label="下一回答版本"
              disabled={locked || index === versions.length - 1}
              onClick={() => choose(index + 1)}
            >
              ›
            </button>
          </div>
        )
      })}
      {current?.archivedAt && <p role="status">此对话已归档，可以浏览历史。请新建对话以继续。</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
