import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Read the runtime we actually launch, including the unpacked distribution. */
export function getDshRuntimeInfo(resourcesPath = process.resourcesPath): { version: string; dshBin: string } {
  const bundledManifest = resourcesPath && join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const packaged = resourcesPath && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp
  const manifestPath = bundledManifest && (packaged || existsSync(bundledManifest))
    ? bundledManifest
    : createRequire(join(process.cwd(), 'package.json')).resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') {
    throw new Error('Invalid DSH runtime manifest')
  }
  return { version: manifest.version, dshBin: join(dirname(manifestPath), 'lib', 'bin.js') }
}
