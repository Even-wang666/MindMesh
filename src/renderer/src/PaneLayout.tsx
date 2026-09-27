import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, RefObject } from 'react'

export type PaneShares = { nav: number; list: number }

const PANE_LIMITS = { nav: 200, list: 220, content: 380 }
const PANE_STORE_KEY = 'mindmesh.pane-shares'

export function clampShares(shares: PaneShares, width: number): PaneShares {
  if (!(width > 0)) return shares
  const asPct = (px: number): number => (px / width) * 100
  const minNav = asPct(PANE_LIMITS.nav)
  const minList = asPct(PANE_LIMITS.list)
  const minContent = asPct(PANE_LIMITS.content)
  const nav = Math.min(Math.max(shares.nav, minNav), 100 - minList - minContent)
  const list = Math.min(Math.max(shares.list, minList), 100 - nav - minContent)
  return { nav, list }
}

export function resizeShares(index: number, start: PaneShares, deltaPct: number): PaneShares {
  return index === 0
    ? { nav: start.nav + deltaPct, list: start.list - deltaPct }
    : { nav: start.nav, list: start.list + deltaPct }
}

function measureShares(shell: HTMLElement): PaneShares & { width: number } {
  const width = shell.getBoundingClientRect().width
  const shareOf = (selector: string): number => {
    const element = shell.querySelector(selector)
    return width > 0 && element ? (element.getBoundingClientRect().width / width) * 100 : 0
  }
  const nav = shell.querySelector('.primary-nav')
  const measuredNav = shareOf('.primary-nav')
  const logicalNav = nav?.classList.contains('is-collapsed')
    ? Number.parseFloat(getComputedStyle(shell).getPropertyValue('--nav-share'))
    : measuredNav
  return {
    width,
    nav: Number.isFinite(logicalNav) ? logicalNav : measuredNav,
    list: shareOf('.object-list'),
  }
}

export function usePaneShares(appRef: RefObject<HTMLElement | null>): [PaneShares | null, (next: PaneShares | null) => void] {
  const [shares, setShares] = useState<PaneShares | null>(() => {
    try {
      const raw = window.localStorage.getItem(PANE_STORE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<PaneShares>
      return typeof parsed.nav === 'number' && typeof parsed.list === 'number'
        ? { nav: parsed.nav, list: parsed.list } : null
    } catch { return null }
  })

  useEffect(() => {
    try {
      if (shares) window.localStorage.setItem(PANE_STORE_KEY, JSON.stringify(shares))
      else window.localStorage.removeItem(PANE_STORE_KEY)
    } catch { /* Persistence failure must not disable resizing. */ }
  }, [shares])

  useEffect(() => {
    if (!shares) return
    const onResize = (): void => {
      const shell = appRef.current
      if (!shell) return
      const width = shell.getBoundingClientRect().width
      setShares((current) => {
        if (!current) return current
        const next = clampShares(current, width)
        return next.nav === current.nav && next.list === current.list ? current : next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [shares, appRef])

  return [shares, setShares]
}

export function PaneResizer({ index, appRef, onShares, onReset }: {
  index: number
  appRef: RefObject<HTMLElement | null>
  onShares: (next: PaneShares | null) => void
  onReset: () => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; start: PaneShares & { width: number } } | null>(null)
  const [active, setActive] = useState(false)

  function applyFrom(start: PaneShares & { width: number }, deltaPct: number): void {
    onShares(clampShares(resizeShares(index, start, deltaPct), start.width))
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    const shell = appRef.current
    if (!shell) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, start: measureShares(shell) }
    shell.classList.add('is-resizing')
    setActive(true)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (current) applyFrom(current.start, ((event.clientX - current.x) / current.start.width) * 100)
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return
    drag.current = null
    appRef.current?.classList.remove('is-resizing')
    setActive(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const shell = appRef.current
    if (!shell) return
    event.preventDefault()
    const step = event.shiftKey ? 2 : 0.5
    applyFrom(measureShares(shell), event.key === 'ArrowRight' ? step : -step)
  }

  const label = index === 0 ? '导航' : '列表'
  return <div
    className={active ? 'pane-resizer is-active' : 'pane-resizer'}
    data-pane={index === 0 ? 'nav-list' : 'list-content'}
    role="separator"
    aria-orientation="vertical"
    aria-label={`拖动调整${label}栏宽度，双击恢复默认比例`}
    tabIndex={0}
    title={`拖动调整${label}栏宽度 · 双击恢复默认比例`}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onDoubleClick={onReset}
    onKeyDown={onKeyDown}
  />
}
