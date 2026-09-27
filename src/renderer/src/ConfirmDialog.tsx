import { createContext, useContext, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

export type ConfirmRequest = {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void | Promise<void>
}

export const ConfirmContext = createContext<((request: ConfirmRequest) => void) | null>(null)

export function useConfirm(): (request: ConfirmRequest) => void {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmContext.Provider')
  return confirm
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  async function approve(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await request.onConfirm()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '操作失败，请重试。')
      setBusy(false)
    }
  }

  return <div className="modal-backdrop confirm-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose()
  }}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
      <header><span className="confirm-mark" aria-hidden="true"><AlertTriangle size={19} /></span><div><h2 id="confirm-title">{request.title}</h2><p id="confirm-description">{request.description}</p></div></header>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button className="secondary-button" autoFocus disabled={busy} onClick={onClose}>取消</button><button className="danger-button solid" disabled={busy} onClick={() => void approve()}>{busy && <span className="spinner" />}{request.confirmLabel}</button></footer>
    </div>
  </div>
}
