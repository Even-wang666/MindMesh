import { useEffect, useRef, useState } from 'react'
import { ChevronRight, CircleHelp, X } from 'lucide-react'
import type {
  Agent,
  CatalogItem,
  CreateAgentInput,
  ModelOption,
  Space,
} from '../../shared/contracts'
import { DEFAULT_AGENT_MODEL, getModelProviderDefinition } from '../../shared/model-providers'
import { createSkillReference } from '../../shared/skill-reference'
import { Avatar, Field } from './Ui'

const defaultAgent: CreateAgentInput = {
  name: '',
  role: '',
  persona: '',
  ...DEFAULT_AGENT_MODEL,
  skills: [],
  tools: [],
}

export function AgentWizard({
  initialAgent,
  onClose,
  onSaved,
}: {
  initialAgent?: Agent
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<CreateAgentInput>(
    initialAgent
      ? {
          name: initialAgent.name,
          role: initialAgent.role,
          persona: initialAgent.persona,
          provider: initialAgent.provider,
          model: initialAgent.model,
          skills: initialAgent.skills,
          tools: initialAgent.tools,
          reasoningEffort: initialAgent.reasoningEffort,
        }
      : defaultAgent
  )
  const [models, setModels] = useState<ModelOption[]>([])
  const [skills, setSkills] = useState<CatalogItem[]>([])
  const [tools, setTools] = useState<CatalogItem[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const steps = ['身份', '模型', '技能', '工具']
  const options = step === 2 ? skills : tools

  useEffect(() => {
    void Promise.all([
      window.mindmesh.catalog.models(),
      window.mindmesh.catalog.skills(),
      window.mindmesh.catalog.tools(),
    ]).then(([nextModels, nextSkills, nextTools]) => {
      setModels(nextModels)
      setSkills(nextSkills)
      setTools(nextTools)
    })
  }, [])

  const providerIds = [...new Set(models.map((model) => model.provider))]
  const providerModels = models.filter((model) => model.provider === form.provider)
  function selectProvider(provider: string): void {
    const firstModel = models.find((model) => model.provider === provider)
    setForm({ ...form, provider, model: firstModel?.id ?? '' })
  }
  function toggle(value: string, legacyValue = value, acceptLegacy = true): void {
    const key = step === 2 ? 'skills' : 'tools'
    setForm((current) => {
      const checked =
        current[key].includes(value) || (acceptLegacy && current[key].includes(legacyValue))
      const remaining = current[key].filter((item) => item !== value && item !== legacyValue)
      return { ...current, [key]: checked ? remaining : [...remaining, value] }
    })
  }
  async function next(): Promise<void> {
    if (step < 3) {
      setStep(step + 1)
      return
    }
    setSaving(true)
    setError('')
    try {
      if (initialAgent) await window.mindmesh.agents.update(initialAgent.id, form)
      else await window.mindmesh.agents.create(form)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存智能体失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="wizard">
        <header>
          <div>
            <span className="eyebrow">{initialAgent ? 'EDIT AGENT' : 'CREATE AGENT'}</span>
            <h2>{initialAgent ? '编辑智能体' : '创建你的智能体'}</h2>
            <p>定义它是谁、会什么，以及可以使用哪些工具。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="stepper">
          {steps.map((label, index) => (
            <div key={label} className={index === step ? 'current' : index < step ? 'done' : ''}>
              <i>{index < step ? '✓' : index + 1}</i>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="wizard-body">
          {step === 0 && (
            <>
              <h3>它是谁？</h3>
              <div className="avatar-picker">
                <Avatar name={form.name || 'M'} large />
                <button className="secondary-button">选择头像</button>
                <small>MVP 使用默认头像</small>
              </div>
              <Field label="名称">
                <input
                  autoFocus
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="例如 Researcher"
                />
              </Field>
              <Field label="角色定位">
                <input
                  value={form.role}
                  onChange={(event) => setForm({ ...form, role: event.target.value })}
                  placeholder="例如 研究分析专家"
                />
              </Field>
              <Field label="身份设定">
                <textarea
                  value={form.persona}
                  onChange={(event) => setForm({ ...form, persona: event.target.value })}
                  placeholder="描述它是谁、擅长什么，以及应该如何回答。"
                />
              </Field>
            </>
          )}
          {step === 1 && (
            <>
              <h3>选择模型</h3>
              <Field label="模型服务商">
                <select
                  value={form.provider}
                  onChange={(event) => selectProvider(event.target.value)}
                >
                  {providerIds.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider === 'custom'
                        ? '自定义服务'
                        : (getModelProviderDefinition(provider)?.name ?? provider)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="模型">
                <select
                  value={form.model}
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                >
                  {providerModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="info-box">
                <CircleHelp size={18} />
                <p>不同模型在推理、编程、创作和速度方面各有特点。</p>
              </div>
            </>
          )}
          {(step === 2 || step === 3) && (
            <>
              <h3>{step === 2 ? '它会什么？' : '它可以使用哪些工具？'}</h3>
              <div className="choice-list">
                {options.map((option) => {
                  const value =
                    step === 2 ? createSkillReference(option.id, option.name) : option.name
                  const selected = step === 2 ? form.skills : form.tools
                  const uniqueLegacy =
                    step !== 2 || skills.filter((item) => item.name === option.name).length === 1
                  const checked =
                    selected.includes(value) || (uniqueLegacy && selected.includes(option.name))
                  const unavailable =
                    step === 2 ? option.available === false : option.status !== '可用'
                  return (
                    <button
                      key={value}
                      className={checked ? 'checked' : ''}
                      disabled={unavailable && !checked}
                      onClick={() => toggle(value, option.name, uniqueLegacy)}
                    >
                      <i>{checked ? '✓' : '+'}</i>
                      <span>
                        <strong>{option.name}</strong>
                        <small>
                          {option.description}
                          {unavailable ? ` · ${option.status}` : ''}
                        </small>
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <footer>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="secondary-button"
            disabled={saving}
            onClick={step === 0 ? onClose : () => setStep(step - 1)}
          >
            {step === 0 ? '取消' : '上一步'}
          </button>
          <button
            className="primary-button"
            disabled={saving || (step === 0 && (!form.name.trim() || !form.persona.trim()))}
            onClick={() => void next()}
          >
            {step === 3 ? (initialAgent ? '保存修改' : '创建智能体') : '下一步'}{' '}
            <ChevronRight size={16} />
          </button>
        </footer>
      </div>
    </div>
  )
}

export function SpaceWizard({
  agents,
  initialSpace,
  onClose,
  onSaved,
}: {
  agents: Agent[]
  initialSpace?: Space
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(initialSpace?.name ?? '')
  const [description, setDescription] = useState(initialSpace?.description ?? '')
  const [context, setContext] = useState(initialSpace?.context ?? '')
  const [members, setMembers] = useState<string[]>(initialSpace?.memberIds ?? [])
  const draggedMember = useRef<string | null>(null)
  const restoreFocus = useRef<string | null>(null)
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const [orderAnnouncement, setOrderAnnouncement] = useState('')
  useEffect(() => {
    if (restoreFocus.current) handles.current.get(restoreFocus.current)?.focus()
    restoreFocus.current = null
  }, [members])
  function moveMember(id: string, destination: number): void {
    const index = members.indexOf(id)
    if (index < 0 || destination < 0 || destination >= members.length || index === destination)
      return
    const next = [...members]
    next.splice(index, 1)
    next.splice(destination, 0, id)
    restoreFocus.current = id
    setMembers(next)
    setOrderAnnouncement(
      `${agents.find((agent) => agent.id === id)?.name ?? id} 已移到第 ${destination + 1} 位`
    )
  }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function save(): Promise<void> {
    setSaving(true)
    setError('')
    try {
      const input = {
        name,
        description,
        context,
        memberIds: members,
        executionMode: 'sequential' as const,
      }
      if (initialSpace) await window.mindmesh.spaces.update(initialSpace.id, input)
      else await window.mindmesh.spaces.create(input)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <div className="wizard space-wizard">
        <header>
          <div>
            <span className="eyebrow">{initialSpace ? 'EDIT SPACE' : 'NEW SPACE'}</span>
            <h2>{initialSpace ? '编辑协作空间' : '创建协作空间'}</h2>
            <p>让多个智能体共享背景并一起协作。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="wizard-body">
          <Field label="空间名称">
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 AI Product Research"
            />
          </Field>
          <Field label="简介">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个空间用来做什么？"
            />
          </Field>
          <Field label="背景信息">
            <textarea
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder="当前目标、项目背景、主要限制和关键规则"
            />
          </Field>
          <label className="field">
            <span>添加智能体</span>
            <div className="member-choices">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  aria-label={agent.name}
                  aria-pressed={members.includes(agent.id)}
                  className={members.includes(agent.id) ? 'selected' : ''}
                  onClick={() =>
                    setMembers((items) =>
                      items.includes(agent.id)
                        ? items.filter((id) => id !== agent.id)
                        : [...items, agent.id]
                    )
                  }
                >
                  <Avatar name={agent.name} />
                  {agent.name}
                </button>
              ))}
            </div>
          </label>
          <fieldset className="workflow-mode" disabled={saving}>
            <legend>协作方式</legend>
            <label>
              <input type="radio" name="executionMode" checked readOnly />
              顺序执行
            </label>
            <label>
              <input type="radio" name="executionMode" disabled />
              并行执行（暂未开放）
            </label>
          </fieldset>
          <section className="workflow-order">
            <h3>成员执行顺序</h3>
            <p id="workflow-order-help">拖动调整顺序，也可使用上下方向键或移动按钮。</p>
            <ol aria-label="成员执行顺序">
              {members.map((id, index) => {
                const agent = agents.find((item) => item.id === id)
                if (!agent) return null
                return (
                  <li
                    key={id}
                    data-member-id={id}
                    onDragOver={(event) => {
                      if (draggedMember.current && !saving) event.preventDefault()
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (draggedMember.current && !saving) moveMember(draggedMember.current, index)
                      draggedMember.current = null
                    }}
                  >
                    <button
                      type="button"
                      className="workflow-handle"
                      draggable={!saving}
                      disabled={saving}
                      aria-label={`调整 ${agent.name} 的执行顺序`}
                      aria-describedby="workflow-order-help"
                      ref={(node) => {
                        if (node) handles.current.set(id, node)
                        else handles.current.delete(id)
                      }}
                      onDragStart={(event) => {
                        draggedMember.current = id
                        event.dataTransfer.setData('text/plain', id)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        draggedMember.current = null
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault()
                          moveMember(id, index + (event.key === 'ArrowUp' ? -1 : 1))
                        }
                      }}
                    >
                      ≡
                    </button>
                    <span className="workflow-member-name">
                      {index + 1}. {agent.name}
                    </span>
                    <button
                      type="button"
                      disabled={saving || index === 0}
                      aria-label={`上移 ${agent.name}`}
                      onClick={() => moveMember(id, index - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={saving || index === members.length - 1}
                      aria-label={`下移 ${agent.name}`}
                      onClick={() => moveMember(id, index + 1)}
                    >
                      ↓
                    </button>
                  </li>
                )
              })}
            </ol>
            <span className="visually-hidden" role="status">
              {orderAnnouncement}
            </span>
          </section>
        </div>
        <footer>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="secondary-button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={saving || !name.trim()}
            onClick={() => void save()}
          >
            {initialSpace ? '保存修改' : '创建空间'}
          </button>
        </footer>
      </div>
    </div>
  )
}
