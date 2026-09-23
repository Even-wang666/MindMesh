import { shell } from 'electron'
import type { WebContents } from 'electron'

export function installNavigationGuards(webContents: WebContents): void {
  webContents.on('will-navigate', (event, url) => {
    if (!isTrustedNavigation(url, webContents.getURL())) event.preventDefault()
  })
  webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (['http:', 'https:'].includes(new URL(url).protocol)) {
        void shell.openExternal(url).catch(() => {})
      }
    } catch { /* Invalid URLs stay blocked. */ }
    return { action: 'deny' }
  })
}

function isTrustedNavigation(destination: string, current: string): boolean {
  try {
    const next = new URL(destination)
    const loaded = new URL(current)
    if (loaded.protocol === 'http:' || loaded.protocol === 'https:') return next.origin === loaded.origin
    return loaded.protocol === 'file:' && next.protocol === 'file:' &&
      next.host === loaded.host && next.pathname.toLowerCase() === loaded.pathname.toLowerCase()
  } catch {
    return false
  }
}
