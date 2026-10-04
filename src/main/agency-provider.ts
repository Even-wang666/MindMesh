import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { t as listTar } from 'tar'
import { parseDocument } from 'yaml'
import type { Agent, AgentSource } from '../shared/contracts'
import { parseMarketplaceKey } from '../shared/marketplace'
import type { MarketplaceCatalogService, MarketplaceProvider } from './marketplace'
import type { MindMeshDatabase } from './database'
import { downloadFile } from './skill-github'

export const AGENCY_REPOSITORY = 'msitarzewski/agency-agents'
// ponytail: reviewed division allowlist; add new upstream divisions when their format is supported.
const divisions = new Set([
  'academic',
  'design',
  'engineering',
  'finance',
  'game-development',
  'gis',
  'healthcare',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'research',
  'sales',
  'security',
  'spatial-computing',
  'specialized',
  'support',
  'testing',
])
const MAX_CONTENT_BYTES = 64 * 1024
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

export type AgencyTemplate = {
  name: string
  description: string
  persona: string
  provenance: AgentSource
}

export function parseAgencyTemplate(
  sourceId: string,
  content: string,
  revision: string,
  licenseText: string
): AgencyTemplate | undefined {
  if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    typeof licenseText !== 'string' ||
    !licenseText.startsWith('MIT License') ||
    Buffer.byteLength(licenseText) > 16_384 ||
    typeof content !== 'string' ||
    Buffer.byteLength(content) > MAX_CONTENT_BYTES
  ) {
    throw new Error('Agency 内容或许可无效')
  }
  const parts = sourceId.split('/')
  if (parts.length !== 2 || !divisions.has(parts[0]) || !/^[a-z0-9][a-z0-9-]*\.md$/.test(parts[1]))
    return undefined
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    content.replace(/^\uFEFF/, '')
  )
  if (!match) return undefined
  const document = parseDocument(match[1])
  if (document.errors.length) throw new Error('Agency 模板头部无效')
  const header: unknown = document.toJS({ maxAliasCount: 0 })
  if (!header || typeof header !== 'object' || Array.isArray(header)) return undefined
  const { name, description } = header as Record<string, unknown>
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 160 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    typeof description !== 'string' ||
    !description.trim() ||
    !match[2].trim()
  )
    return undefined
  return {
    name: name.trim(),
    description: description
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 2_000),
    persona: match[2].trim(),
    provenance: {
      source: 'agency',
      sourceId,
      revision,
      repository: AGENCY_REPOSITORY,
      content,
      license: 'MIT',
      licenseText,
    },
  }
}

export class AgencyProvider implements MarketplaceProvider {
  readonly kind = 'agents' as const
  readonly source = 'agency'
  private readonly directory: string

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'marketplace-cache', 'agency')
  }

  async load(): Promise<unknown> {
    const response = await fetch(`https://api.github.com/repos/${AGENCY_REPOSITORY}/commits/main`, {
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'MindMesh' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    })
    if (!response.ok || !response.body) throw new Error('Agency revision 请求失败')
    let revision = ''
    let revisionBytes = 0
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      revisionBytes += chunk.length
      if (revisionBytes > 80) throw new Error('Agency revision 响应过大')
      revision += chunk.toString('utf8')
    }
    revision = revision.trim()
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Agency revision 无效')
    const temporary = mkdtempSync(join(tmpdir(), 'mindmesh-agency-'))
    try {
      const archive = join(temporary, 'agency.tar.gz')
      await downloadFile(
        `https://codeload.github.com/${AGENCY_REPOSITORY}/tar.gz/${revision}`,
        archive
      )
      const files: Record<string, string> = {}
      let entries = 0
      let expanded = 0
      let contentBytes = 0
      const seen = new Set<string>()
      const parser = listTar({
        gzip: true,
        strict: true,
        filter: (path, entry) => {
          entries += 1
          expanded += entry.size
          if (entries > 10_000 || expanded > 256 * 1024 * 1024) {
            parser.abort(new Error('Agency 归档规模过大'))
            return false
          }
          const parts = path.split('/')
          return (
            (parts.length === 2 && parts[1] === 'LICENSE') ||
            (parts.length === 3 &&
              divisions.has(parts[1]) &&
              /^[a-z0-9][a-z0-9-]*\.md$/.test(parts[2]))
          )
        },
        onReadEntry: (entry) => {
          if (entry.type !== 'File' || entry.size > MAX_CONTENT_BYTES || seen.has(entry.path)) {
            parser.abort(new Error('Agency 文件无效或过大'))
            return
          }
          seen.add(entry.path)
          contentBytes += entry.size
          if (contentBytes > MAX_SNAPSHOT_BYTES / 2) {
            parser.abort(new Error('Agency 内容规模过大'))
            return
          }
          const chunks: Buffer[] = []
          entry.on('data', (chunk: Buffer) => chunks.push(chunk))
          entry.on('end', () => {
            files[entry.path.split('/').slice(1).join('/')] = Buffer.concat(chunks).toString('utf8')
          })
        },
      })
      await pipeline(createReadStream(archive), parser)
      const licenseText = files.LICENSE
      if (!licenseText) throw new Error('Agency 许可缺失')
      const templates = Object.entries(files)
        .filter(([path]) => path !== 'LICENSE')
        .map(([path, content]) => parseAgencyTemplate(path, content, revision, licenseText))
        .filter((item) => item !== undefined)
      if (!templates.length || templates.length > 2_000) throw new Error('Agency 目录无效')
      const snapshot = JSON.stringify({ revision, files })
      if (Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) throw new Error('Agency 快照过大')
      mkdirSync(this.directory, { recursive: true })
      // ponytail: retain pinned snapshots for cached revisions; add pruning if disk use becomes material.
      const path = join(this.directory, `${revision}.json`)
      writeFileSync(`${path}.tmp`, snapshot, 'utf8')
      renameSync(`${path}.tmp`, path)
      return templates.map((template) => ({
        sourceId: template.provenance.sourceId,
        name: template.name,
        description: template.description,
        revision,
        license: 'MIT',
      }))
    } finally {
      // temporary is created here, never derived from remote paths; archive members are read without extraction.

      if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) {
        // biome-ignore lint/correctness/noUnsafeFinally: Refuse recursive cleanup outside the verified temporary directory, even after an earlier failure.
        throw new Error('Unexpected Agency temporary path')
      }
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  template(sourceId: string, revision: string): AgencyTemplate {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Agency revision 无效')
    const path = join(this.directory, `${revision}.json`)
    if (statSync(path).size > MAX_SNAPSHOT_BYTES) throw new Error('Agency 快照过大')
    const snapshot = JSON.parse(readFileSync(path, 'utf8'))
    if (
      snapshot.revision !== revision ||
      !snapshot.files ||
      typeof snapshot.files !== 'object' ||
      Array.isArray(snapshot.files)
    ) {
      throw new Error('Agency 快照无效')
    }
    const result = parseAgencyTemplate(
      sourceId,
      snapshot.files[sourceId],
      revision,
      snapshot.files.LICENSE
    )
    if (!result) throw new Error('Agency 模板不存在')
    return result
  }
}

export async function installAgencyAgent(
  key: unknown,
  revision: unknown,
  agency: AgencyProvider,
  marketplace: MarketplaceCatalogService,
  db: MindMeshDatabase
): Promise<Agent> {
  try {
    if (
      typeof key !== 'string' ||
      key.length > 2_048 ||
      typeof revision !== 'string' ||
      !/^[a-f0-9]{40}$/.test(revision)
    ) {
      throw new Error('无效参数')
    }
    const identity = parseMarketplaceKey(key)
    if (identity.kind !== 'agents' || identity.source !== 'agency') throw new Error('无效来源')
    const existing = db.findAgentBySource(identity.source, identity.sourceId)
    if (existing) return existing
    const catalog = await marketplace.list('agents')
    if (!catalog.items.some((item) => item.key === key && item.revision === revision))
      throw new Error('目录已改变')
    return db.installAgencyAgent(agency.template(identity.sourceId, revision))
  } catch (error) {
    throw new Error('安装智能体失败，请刷新目录后重试。', { cause: error })
  }
}
