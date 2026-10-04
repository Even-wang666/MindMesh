import { displayModelName } from './model-options'
import { Avatar } from './Ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Plus, Send, ShieldCheck, Sparkles, Square, X } from 'lucide-react'
import type { Agent, CatalogItem, ChatImageAttachment, ChatImageMediaType, ChatPermission, ChatRunOptions, Message, ModelOption } from '../../shared/contracts'
import { getModelContextWindow } from '../../shared/model-providers'
import { getChatContentError } from '../../shared/chat-content'
import { skillDisplayName } from '../../shared/skill-reference'
import { ImagePicker } from './FilePicker'
import { getProviderLogo } from './ProviderLogos'

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const PERMISSION_LABELS: Record<ChatPermission, string> = {
  chat: '仅对话',
  workspace: '允许工作区访问',
  full: '允许完全访问',
}

export function Composer({ busy, canAttach, placeholder, members = [], value, onChange, onSend, onStop, messages, provider, model, models = [], onModelChange, invocableSkills = [] }: {
  busy: boolean; canAttach: boolean; placeholder: string; members?: Agent[]; value: string
  onChange: React.Dispatch<React.SetStateAction<string>>
  onSend: (value: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions) => Promise<boolean>
  onStop: () => Promise<boolean>
  messages: Message[]; provider?: string; model?: string; models?: ModelOption[]; onModelChange?: (model: string) => void
  invocableSkills?: CatalogItem[]
}): React.JSX.Element {
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [stopError, setStopError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [stopAccepted, setStopAccepted] = useState(false)
  const stopCycle = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [permission, setPermission] = useState<ChatPermission>('chat')
  const [sendError, setSendError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<'permission' | 'model' | 'context' | null>(null)
  const selectedModel = models.find((item) => item.id === model)
    ?? models.find((item) => item.name === displayModelName(model ?? ''))
  const contextWindow = selectedModel?.contextWindow ?? getModelContextWindow(provider ?? '', model ?? '')
  const estimatedTokens = estimateContextTokens(messages, value)
  const contextPercent = contextWindow ? Math.min(100, estimatedTokens / contextWindow * 100) : 0
  const mention = /@([\p{L}\p{N}_-]*)$/u.exec(value)
  const matchingMembers = mention ? members.filter((agent) => agent.name.toLowerCase().startsWith(mention[1].toLowerCase())) : []
  const skillCommandMatch = /(^|\s)\/([a-z0-9-]*)$/u.exec(value)
  const matchingSkills = skillCommandMatch ? invocableSkills.filter((skill) => skill.id.startsWith(skillCommandMatch[2])) : []
  const completeSkill = (skill: CatalogItem): void => onChange((draft) => draft.replace(/\/([a-z0-9-]*)$/u, `/${skill.id} `))
  const addFiles = useCallback(async (files: FileList | File[]): Promise<string | null> => {
    if (!canAttach) { const error = '目前仅 DeepSeek Flash 支持图片输入'; setAttachmentError(error); return error }
    setAttachmentError('')
    const next: ChatImageAttachment[] = []
    let error = ''
    let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0)
    for (const file of Array.from(files)) {
      const mediaType = await detectImageMediaType(file)
      if (!mediaType) {
        error = '仅支持 PNG、JPEG、WebP 或 GIF 图片'
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) { error = '单张图片不能超过 32 MiB'; continue }
      totalBytes += file.size
      if (totalBytes > MAX_IMAGE_BYTES) { error = '图片总大小不能超过 32 MiB'; break }
      try {
        const dataUrl = await readFileAsDataUrl(file)
        next.push({ type: 'image', name: file.name, mediaType, data: dataUrl.split(',')[1] ?? '', bytes: file.size })
      } catch {
        error = `无法读取 ${file.name}`
      }
    }
    if (error) { setAttachmentError(error); return error }
    if (next.length > 0) setAttachments((current) => [...current, ...next])
    return next.length > 0 ? null : '请选择图片'
  }, [attachments, canAttach])
  useEffect(() => {
    let dragDepth = 0
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (!canAttach) return
      dragDepth += 1
      setDragging(true)
    }
    const over = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setDragging(false)
    }
    const drop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth = 0
      setDragging(false)
      if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [addFiles])
  useEffect(() => {
    if (!canAttach && attachments.length > 0) setAttachmentError('当前选择的智能体不支持图片输入')
  }, [attachments.length, canAttach])
  useEffect(() => {
    stopCycle.current += 1
    setStopAccepted(false)
    setStopping(false)
    setStopError('')
  }, [busy])
  async function submit(): Promise<void> {
    const current = value
    const currentAttachments = attachments
    if (busy || (!current.trim() && currentAttachments.length === 0) || (currentAttachments.length > 0 && !canAttach)) return
    const validationError = getChatContentError(current)
    if (validationError) { setSendError(validationError); return }
    setSendError('')
    setStopError('')
    onChange('')
    setAttachments([])
    if (!await onSend(current, currentAttachments, onModelChange && model ? { model, permission } : { permission })) {
      onChange((draft) => draft || current)
      setAttachments((draft) => draft.length > 0 ? draft : currentAttachments)
    }
  }
  async function stopGeneration(): Promise<void> {
    if (stopping || stopAccepted) return
    const cycle = stopCycle.current
    setStopping(true)
    setStopError('')
    try {
      const stopped = await onStop()
      if (stopCycle.current !== cycle) return
      if (stopped) setStopAccepted(true)
      else setStopError('未能停止生成，请重试。')
    } catch {
      if (stopCycle.current === cycle) setStopError('未能停止生成，请重试。')
    } finally {
      if (stopCycle.current === cycle) setStopping(false)
    }
  }
  return (
    <div className="composer-wrap">
      {dragging && <div className="drop-overlay" role="status">松开即可添加图片</div>}
      {matchingMembers.length > 0 && <div className="mention-menu">
        <span className="eyebrow">选择智能体</span>
        {matchingMembers.map((agent) => <button key={agent.id} onClick={() => onChange((draft) => draft.replace(/@[\p{L}\p{N}_-]*$/u, `@${agent.name} `))}>
          <Avatar name={agent.name} />
          <span>
            <strong>{agent.name}</strong>
            <small>{agent.role}</small>
          </span>
        </button>)}
      </div>}
      {matchingSkills.length > 0 && <div className="mention-menu" id="skill-invoke-menu" role="group" aria-label="手动触发技能">
        <span className="eyebrow">手动触发技能</span>
        {matchingSkills.map((skill) => <button key={skill.id} onClick={() => completeSkill(skill)}>
          <span className="skill-menu-mark">
            <Sparkles size={14} />
          </span>
          <span>
            <strong>/{skill.id}</strong>
            <small>{skill.description}</small>
          </span>
        </button>)}
      </div>}
      <div className="composer">
        {attachments.length > 0 && <div className="composer-attachments">
          {attachments.map((attachment, index) => <figure key={`${attachment.name}-${index}`}>
            <img src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} />
            <figcaption>{attachment.name}</figcaption>
            <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
              <X size={13} />
            </button>
          </figure>)}
        </div>}
        <textarea value={value} onChange={(event) => { setSendError(''); onChange(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (matchingSkills[0]) completeSkill(matchingSkills[0]); else void submit() } }} placeholder={placeholder} aria-controls={matchingSkills.length > 0 ? 'skill-invoke-menu' : undefined} aria-expanded={matchingSkills.length > 0} />
        {attachmentError && <p className="composer-error" role="alert">{attachmentError}</p>}
        {sendError && <p className="composer-error" role="alert">{sendError}</p>}
        {stopError && <p className="composer-error" role="alert">{stopError}</p>}
        <div className="composer-actions">
          <div className="composer-tools">
            <button type="button" className="composer-add" aria-label="添加图片" title={canAttach ? '添加图片' : '目前仅 DeepSeek Flash 支持图片输入'} disabled={busy || !canAttach} onClick={() => setPickerOpen(true)}>
              <Plus size={19} />
            </button>
            <div className="composer-control-wrap">
              <button type="button" className={`composer-control permission ${permission !== 'full' ? 'limited' : ''}`} aria-label={`权限：${PERMISSION_LABELS[permission]}`} aria-expanded={openMenu === 'permission'} onClick={() => setOpenMenu((current) => current === 'permission' ? null : 'permission')}>
                <ShieldCheck size={15} />{PERMISSION_LABELS[permission]}<ChevronRight size={13} />
              </button>
              {openMenu === 'permission' && <div className="composer-menu permission-menu">
                {(Object.keys(PERMISSION_LABELS) as ChatPermission[]).map((item) => <button type="button" key={item} aria-label={PERMISSION_LABELS[item]} className={item === permission ? 'selected' : ''} onClick={() => { setPermission(item); setOpenMenu(null) }}>
                  <strong>{PERMISSION_LABELS[item]}</strong>
                  <small>{item === 'chat' ? '不使用本地工具' : item === 'workspace' ? '允许文件和网页，不运行 Shell' : '使用智能体已配置的全部工具'}</small>
                </button>)}
              </div>}
            </div>
          </div>
          <div className="composer-route-controls">
            <div className="composer-control-wrap">
              <button type="button" className="context-meter" aria-label={`上下文窗口：约 ${formatTokenCount(estimatedTokens)} / ${contextWindow ? formatTokenCount(contextWindow) : '未知'}`} aria-expanded={openMenu === 'context'} onClick={() => setOpenMenu((current) => current === 'context' ? null : 'context')}>
                <span style={{ '--context-progress': `${contextWindow ? Math.max(2, contextPercent) : 2}%` } as React.CSSProperties} />
              </button>
              {openMenu === 'context' && <div className="composer-menu context-menu">
                <strong>上下文窗口</strong>
                <span>约 {formatTokenCount(estimatedTokens)} / {contextWindow ? formatTokenCount(contextWindow) : '未知'}</span>
                <small>{contextWindow ? '根据当前会话文本估算，实际用量以 API 计费为准。' : '该模型未公布上下文上限；当前用量按会话文本估算。'}</small>
              </div>}
            </div>
            <div className="composer-control-wrap">
              <button type="button" className="composer-control model" aria-label={`选择模型，当前 ${selectedModel?.name ?? '成员模型'}`} aria-expanded={openMenu === 'model'} disabled={!onModelChange} onClick={() => setOpenMenu((current) => current === 'model' ? null : 'model')}>{provider && getProviderLogo(provider) && <img src={getProviderLogo(provider)} alt="" />}{selectedModel?.name ?? '成员模型'}<ChevronRight size={13} />
              </button>
              {openMenu === 'model' && <div className="composer-menu model-menu">
                {models.map((item) => <button type="button" key={item.id} className={item.id === model ? 'selected' : ''} onClick={() => { onModelChange?.(item.id); setOpenMenu(null) }}>{item.name}</button>)}
              </div>}
            </div>
            <button type="button" className="send-button" aria-label={busy ? stopAccepted ? '已停止' : stopping ? '正在停止' : '停止生成' : '发送'} disabled={busy ? stopping || stopAccepted : ((!value.trim() && attachments.length === 0) || (attachments.length > 0 && !canAttach))} onClick={() => busy ? void stopGeneration() : void submit()}>{busy ? <Square size={13} fill="currentColor" /> : <Send size={17} />}</button>
          </div>
        </div>
      </div>
      {pickerOpen && <ImagePicker title="添加图片" hint="先预览并确认，再添加到当前消息。" multiple confirmLabel="添加到消息" onPick={addFiles} onClose={() => setPickerOpen(false)} />}
    </div>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function detectImageMediaType(file: File): Promise<ChatImageMediaType | null> {
  const signature = await readFileAsArrayBuffer(file.slice(0, 12)).catch(() => null)
  if (!signature) return null
  const bytes = new Uint8Array(signature)
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const ascii = String.fromCharCode(...bytes)
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif'
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp'
  return null
}

function readFileAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function estimateContextTokens(messages: Message[], draft: string): number {
  const characters = [...messages.map((message) => `${message.content}\n${message.reasoning ?? ''}`).join('\n'), ...draft].length
  return Math.ceil(characters / 2)
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return String(value)
}
