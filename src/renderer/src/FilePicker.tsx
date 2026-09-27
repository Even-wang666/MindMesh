import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FolderOpen, ImagePlus, X } from 'lucide-react'

const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

function useDialogFocus(onClose: () => void, busy: boolean): React.RefObject<HTMLDivElement | null> {
  const dialog = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const busyRef = useRef(busy)
  closeRef.current = onClose
  busyRef.current = busy
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = (): HTMLElement[] => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])
    focusable()[0]?.focus()
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current()
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [])
  return dialog
}

export function ImagePicker({ title, hint, multiple, confirmLabel, onPick, onClose }: {
  title: string
  hint: string
  multiple: boolean
  confirmLabel: string
  onPick: (files: File[]) => string | null | Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const previews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files])
  useEffect(() => () => previews.forEach(({ url }) => URL.revokeObjectURL(url)), [previews])
  const dialog = useDialogFocus(onClose, busy)

  function select(next: FileList | File[]): void {
    const selected = Array.from(next)
    setFiles(multiple ? selected : selected.slice(0, 1))
    setError('')
  }

  async function confirm(): Promise<void> {
    if (files.length === 0) return
    setBusy(true)
    setError('')
    try {
      const validationError = await onPick(files)
      if (validationError) setError(validationError)
      else onClose()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '无法读取所选图片，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return <div className="modal-backdrop picker-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose()
  }}>
    <div ref={dialog} className="confirm-dialog file-picker" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header><span className="confirm-mark picker-mark" aria-hidden="true"><ImagePlus size={19} /></span><div><h2 id={titleId}>{title}</h2><p>{hint}</p></div><button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <button type="button" className={`picker-dropzone${dragging ? ' dragging' : ''}`} onClick={() => input.current?.click()} onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(true) }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(true) }} onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(false) }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(false); if (event.dataTransfer.files.length) select(event.dataTransfer.files) }}>
        <ImagePlus size={24} /><strong>拖拽图片到这里，或点击选择</strong><small>支持 PNG、JPEG、WebP、GIF</small>
      </button>
      <input ref={input} className="visually-hidden" aria-label={`${title}文件`} type="file" accept={IMAGE_TYPES} multiple={multiple} onChange={(event) => { if (event.target.files) select(event.target.files); event.target.value = '' }} />
      {previews.length > 0 && <ul className="picker-preview">{previews.map(({ file, url }, index) => <li key={`${file.name}-${file.size}-${index}`}><img src={url} alt={file.name} /><span className="picker-file-meta"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={15} /></button></li>)}</ul>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || files.length === 0} onClick={() => void confirm()}>{busy && <span className="spinner" />}{confirmLabel}</button></footer>
    </div>
  </div>
}

export function DirectoryConfirm({ title, path, confirmLabel, onReselect, onConfirm, onClose }: {
  title: string
  path: string
  confirmLabel: string
  onReselect: () => void | Promise<void>
  onConfirm: () => void | Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useDialogFocus(onClose, busy)

  async function confirm(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '操作失败，请重试。')
      setBusy(false)
    }
  }

  return <div className="modal-backdrop picker-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose()
  }}>
    <div ref={dialog} className="confirm-dialog directory-confirm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header><span className="confirm-mark picker-mark" aria-hidden="true"><FolderOpen size={19} /></span><div><h2 id={titleId}>{title}</h2><p>确认路径后才会执行，不会立即修改现有数据。</p></div><button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <div className="directory-path" title={path}><FolderOpen size={17} /><code>{path}</code></div>
      <button type="button" className="text-button picker-reselect" disabled={busy} onClick={() => void onReselect()}>重新选择</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy && <span className="spinner" />}{confirmLabel}</button></footer>
    </div>
  </div>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
