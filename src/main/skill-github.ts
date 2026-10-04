import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { x as extractTar } from 'tar'
import type { SkillInstallProgress } from '../shared/contracts'
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES } from './skill-limits'

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_ARCHIVE_EXPANDED_BYTES = 256 * 1024 * 1024

type GitHubSkillLocation = {
  url: string
  repository: string
  ref?: string
  path: string
}

type GitHubSkillSource = {
  kind: 'github'
  url: string
  repository: string
  commit: string
  path: string
}

export async function withGitHubSkillBundle<T>(
  input: string,
  onProgress: ((progress: SkillInstallProgress) => void) | undefined,
  install: (source: string, receipt: GitHubSkillSource) => T
): Promise<T> {
  onProgress?.({ phase: 'resolving' })
  const github = parseGitHubSkillUrl(input)
  const resolved = await resolveGitHubLocation(github)
  const commit = resolved.commit
  const temporary = mkdtempSync(join(tmpdir(), 'mindmesh-skill-'))
  const archive = join(temporary, 'repository.tar.gz')
  const checkout = join(temporary, 'checkout')
  mkdirSync(checkout)
  try {
    onProgress?.({ phase: 'downloading' })
    await downloadFile(
      `https://codeload.github.com/${github.repository}/tar.gz/${commit}`,
      archive,
      (receivedBytes, totalBytes) =>
        onProgress?.({ phase: 'downloading', receivedBytes, totalBytes })
    )
    let files = 0
    let bytes = 0
    let archiveEntries = 0
    let archiveExpandedBytes = 0
    onProgress?.({ phase: 'extracting' })
    await extractTar({
      file: archive,
      cwd: checkout,
      gzip: true,
      strip: 1,
      preservePaths: false,
      filter: (path, entry) => {
        archiveEntries += 1
        archiveExpandedBytes += entry.size
        if (
          archiveEntries > MAX_ARCHIVE_ENTRIES ||
          archiveExpandedBytes > MAX_ARCHIVE_EXPANDED_BYTES
        ) {
          throw new Error('GitHub 仓库归档解压规模过大')
        }
        const relativePath = path.split('/').slice(1).join('/')
        if (
          resolved.path &&
          relativePath !== resolved.path &&
          !relativePath.startsWith(`${resolved.path}/`)
        )
          return false
        const entryType =
          'type' in entry
            ? entry.type
            : entry.isFile()
              ? 'File'
              : entry.isSymbolicLink()
                ? 'SymbolicLink'
                : 'Directory'
        if (entryType === 'SymbolicLink' || entryType === 'Link') {
          throw new Error('GitHub skill bundle 不允许链接文件')
        }
        if (entryType === 'File' || entryType === 'OldFile') {
          files += 1
          bytes += entry.size
          if (files > MAX_BUNDLE_FILES)
            throw new Error(`技能 bundle 超过 ${MAX_BUNDLE_FILES} 个文件`)
          if (bytes > MAX_BUNDLE_BYTES) throw new Error('技能 bundle 超过 16 MiB')
        }
        return true
      },
    })
    const source = resolved.path ? join(checkout, ...resolved.path.split('/')) : checkout
    onProgress?.({ phase: 'installing' })
    const installed = install(source, {
      kind: 'github',
      url: github.url,
      repository: github.repository,
      commit,
      path: resolved.path,
    })
    onProgress?.({ phase: 'done' })
    return installed
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function parseGitHubSkillUrl(input: string): GitHubSkillLocation {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('请输入有效的 GitHub skill URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password
  ) {
    throw new Error('仅支持公开的 GitHub HTTPS URL')
  }
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
  if (
    segments.length < 2 ||
    !segments.slice(0, 2).every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment))
  ) {
    throw new Error('GitHub 仓库 URL 无效')
  }
  const repository = `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`
  let ref: string | undefined
  let path = ''
  if (segments.length > 2) {
    if (segments[2] !== 'tree' || !segments[3])
      throw new Error('请选择 GitHub 仓库或 skill 目录 URL')
    ref = segments[3]
    const pathSegments = segments.slice(4)
    if (
      pathSegments.some(
        (segment) => !segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)
      )
    ) {
      throw new Error('GitHub skill 目录无效')
    }
    path = pathSegments.join('/')
  }
  url.search = ''
  url.hash = ''
  return { url: url.toString().replace(/\/$/, ''), repository, ref, path }
}

async function githubDefaultBranch(repository: string): Promise<string> {
  const value = await githubJson(`https://api.github.com/repos/${repository}`)
  if (!isRecord(value) || typeof value.default_branch !== 'string')
    throw new Error('GitHub 仓库未返回默认分支')
  return value.default_branch
}

async function resolveGitHubLocation(
  location: GitHubSkillLocation
): Promise<{ commit: string; path: string }> {
  if (!location.ref) {
    const reference = await githubDefaultBranch(location.repository)
    const commit = await githubCommit(location.repository, reference)
    if (!commit) throw new Error('GitHub 默认分支不存在')
    return { commit, path: '' }
  }
  const pathSegments = location.path ? location.path.split('/') : []
  let reference = location.ref
  for (;;) {
    const commit = await githubCommit(location.repository, reference)
    if (commit) return { commit, path: pathSegments.join('/') }
    const segment = pathSegments.shift()
    if (!segment) throw new Error('GitHub 分支、标签或 commit 不存在')
    reference += `/${segment}`
  }
}

async function githubCommit(repository: string, reference: string): Promise<string | undefined> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(reference)}`,
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MindMesh' },
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）`)
  const value: unknown = await response.json()
  if (!isRecord(value) || typeof value.sha !== 'string' || !/^[a-f0-9]{40}$/.test(value.sha)) {
    throw new Error('GitHub 未返回有效 commit')
  }
  return value.sha
}

async function githubJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MindMesh' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）`)
  return response.json()
}

export async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (receivedBytes: number, totalBytes?: number) => void
): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error(`GitHub 下载失败（${response.status}）`)
  const contentLength = response.headers.get('content-length')
  const declaredBytes = contentLength === null ? undefined : Number(contentLength)
  const totalBytes =
    declaredBytes !== undefined && Number.isFinite(declaredBytes) ? declaredBytes : undefined
  if (totalBytes !== undefined && totalBytes > MAX_ARCHIVE_BYTES)
    throw new Error('GitHub 仓库归档超过 32 MiB')
  let bytes = 0
  let reportedBytes = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_ARCHIVE_BYTES) return callback(new Error('GitHub 仓库归档超过 32 MiB'))
      if (bytes - reportedBytes >= 256 * 1024 || bytes === totalBytes) {
        reportedBytes = bytes
        onProgress?.(bytes, totalBytes)
      }
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(destination))
  if (bytes !== reportedBytes) onProgress?.(bytes, totalBytes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
