import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import type { FileChange } from '../shared/contracts'

/** Confirmations emitted by DSH 0.2.0-rc.2 write/edit tools, not assistant prose. */
// ponytail: write/edit only; add adapters when other tools expose verified mutation results.
export function fileChangesFromToolResult(toolName: string, output: string): FileChange[] {
  if (output.length > 16_384) return []
  if (toolName === 'write') {
    const match =
      /^<path>([^\r\n]+)<\/path>\r?\n<type>file<\/type>\r?\n<content>\r?\n(Created|Updated) file\r?\n<\/content>$/.exec(
        output
      )
    return match
      ? [{ path: match[1], type: match[2] === 'Created' ? 'generated_file' : 'modified_file' }]
      : []
  }
  if (toolName === 'edit') {
    const match =
      /^The file ([^\r\n]+) has been updated(?: successfully\.|\. All occurrences were successfully replaced\.)$/.exec(
        output
      )
    return match ? [{ path: match[1], type: 'modified_file' }] : []
  }
  return []
}

/** Reject URLs, UNC paths and symlink traversal; only reveal regular files. */
export function artifactFile(
  path: string,
  workspace: string
): { path: string; name: string; mimeType: string } {
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    path.length > 4096 ||
    /[\x00-\x1f]/.test(path) ||
    /^[\\/]{2}|^[a-z][a-z\d+.-]*:\/\//i.test(path) ||
    /^[\\/]{2}/.test(workspace)
  )
    throw new Error('无效的成果路径')
  const requested = resolve(workspace, path)
  if (/^[\\/]{2}/.test(requested)) throw new Error('无效的成果路径')
  const ancestors: string[] = []
  for (let current = requested; ; current = dirname(current)) {
    ancestors.push(current)
    if (current === dirname(current)) break
  }
  for (const ancestor of ancestors.reverse()) {
    if (lstatSync(ancestor).isSymbolicLink()) throw new Error('成果路径不能经过符号链接')
  }
  const absolute = realpathSync(requested)
  if (/^[\\/]{2}/.test(absolute) || !statSync(absolute).isFile())
    throw new Error('成果文件不存在或不是普通文件')
  const mimeTypes: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return {
    path: absolute,
    name: basename(absolute),
    mimeType: mimeTypes[extname(absolute).toLowerCase()] ?? 'application/octet-stream',
  }
}
