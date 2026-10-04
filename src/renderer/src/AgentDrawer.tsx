import { useLayoutEffect, useRef } from 'react'
import { Trash2, X } from 'lucide-react'
import type { Agent } from '../../shared/contracts'
import { skillDisplayName } from '../../shared/skill-reference'
import { useConfirm } from './ConfirmDialog'
import { Avatar } from './Ui'

export function AgentDrawer({
  agent,
  onClose,
  onChat,
  onEdit,
  onRemove,
}: {
  agent?: Agent
  onClose: () => void
  onChat: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => Promise<void>
}): React.JSX.Element | null {
  const confirm = useConfirm()
  const drawerRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!agent) return
    const previousFocus = document.activeElement
    drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [agent?.id])
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    // A confirmation opened above the drawer owns its Escape/Tab handling.
    if (document.querySelector('[role="alertdialog"]')) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const controls = drawerRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], summary, [tabindex="0"]'
    )
    if (!controls?.length) return
    const first = controls[0],
      last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  if (!agent) return null
  const target = agent
  function requestRemove(): void {
    confirm({
      title: `确定删除智能体「${target.name}」吗？`,
      description: '该操作会将其从协作空间移除。',
      confirmLabel: '确定删除',
      onConfirm: () => onRemove(target.id),
    })
  }
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside
        ref={drawerRef}
        className="agent-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-drawer-title"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Avatar name={agent.name} large />
          <div>
            <h2 id="agent-drawer-title">{agent.name}</h2>
            <p>{agent.role}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <section>
          <span className="eyebrow">身份设定</span>
          <p>{agent.persona}</p>
        </section>
        {agent.source && (
          <section>
            <details>
              <summary>来源与许可</summary>
              <p>
                {agent.source.repository} · {agent.source.sourceId}
              </p>
              <p>
                版本：{agent.source.revision} · {agent.source.license}
              </p>
              <pre className="source-license">{agent.source.licenseText}</pre>
            </details>
          </section>
        )}
        <section>
          <span className="eyebrow">模型</span>
          <p>
            <em>{agent.model}</em>
          </p>
        </section>
        <section>
          <span className="eyebrow">技能</span>
          <div className="tags">
            {agent.skills.map((item) => (
              <i key={item}>{skillDisplayName(item)}</i>
            ))}
          </div>
        </section>
        <section>
          <span className="eyebrow">工具</span>
          <div className="tags">
            {agent.tools.map((item) => (
              <i key={item}>{item}</i>
            ))}
          </div>
        </section>
        <footer>
          <button className="primary-button" onClick={() => onChat(agent.id)}>
            开始对话
          </button>
          <button className="secondary-button" onClick={() => onEdit(agent.id)}>
            编辑智能体
          </button>
          <button className="danger-button" onClick={requestRemove}>
            <Trash2 size={15} />
            删除智能体
          </button>
        </footer>
      </aside>
    </div>
  )
}
