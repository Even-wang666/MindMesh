import { shell } from 'electron'
import type { WebContents } from 'electron'

export function installNavigationGuards(webContents: WebContents): void {
  webContents.on('will-navigate', (event) => event.preventDefault())
  webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (['http:', 'https:'].includes(new URL(url).protocol)) {
        void shell.openExternal(url).catch(() => {})
      }
    } catch { /* Invalid URLs stay blocked. */ }
    return { action: 'deny' }
  })
}
