import { createHash } from 'node:crypto'
import type { Space } from '../shared/contracts'
import { parseMarketplaceKey } from '../shared/marketplace'
import type { AgencyProvider, AgencyTemplate } from './agency-provider'
import type { MindMeshDatabase } from './database'
import type { MarketplaceCatalogService } from './marketplace'

// Ordered references only; Team manifests never grant capabilities or execute workflows.
export const curatedTeams = [
  {
    sourceId: 'web-delivery',
    name: 'Web 交付团队',
    description: '前端、后端与测试协作，从需求到交付逐步核验。',
    context:
      '先明确需求和验收条件，再由前端、后端和测试成员依次提出方案。共享发现、接口约定和待验证项。',
    members: [
      'engineering/engineering-frontend-developer.md',
      'engineering/engineering-backend-architect.md',
      'testing/testing-api-tester.md',
    ],
  },
  {
    sourceId: 'engineering-review',
    name: '工程审查团队',
    description: '架构、代码审查与测试自动化协作，识别风险并提出最小修复。',
    context:
      '先检查架构和真实调用路径，再审查代码，最后给出可重复的测试建议。明确证据、风险和最小修复。',
    members: [
      'engineering/engineering-software-architect.md',
      'engineering/engineering-code-reviewer.md',
      'testing/testing-test-automation-engineer.md',
    ],
  },
]

export type TeamManifest = (typeof curatedTeams)[number]
export type ResolvedTeam = TeamManifest & { revision: string; templates: AgencyTemplate[] }

export function teamRevision(manifest: TeamManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

export const teamProvider = {
  kind: 'teams' as const,
  source: 'mindmesh-curated',
  load: async () =>
    curatedTeams.map((team) => ({
      ...team,
      revision: teamRevision(team),
      license: 'MIT',
      team: {
        members: team.members.map((path) =>
          path
            .split('/')[1]
            .replace(/^[^-]+-/, '')
            .replace(/\.md$/, '')
            .replaceAll('-', ' ')
        ),
      },
    })),
}

export async function installTeam(
  key: unknown,
  revision: unknown,
  agency: AgencyProvider,
  marketplace: MarketplaceCatalogService,
  db: MindMeshDatabase
): Promise<Space> {
  try {
    if (
      typeof key !== 'string' ||
      key.length > 2_048 ||
      typeof revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(revision)
    )
      throw new Error('无效参数')
    const identity = parseMarketplaceKey(key)
    if (identity.kind !== 'teams' || identity.source !== teamProvider.source)
      throw new Error('无效来源')
    const manifest = curatedTeams.find((team) => team.sourceId === identity.sourceId)
    if (!manifest || teamRevision(manifest) !== revision) throw new Error('团队目录已改变')
    const existing = db.findSpaceBySource(identity.source, identity.sourceId)
    if (existing) return existing
    // Resolve every reference from one pinned Agency snapshot before any database mutation.
    const catalog = await marketplace.list('agents')
    const templates = manifest.members.map((sourceId) => {
      const item = catalog.items.find(
        (entry) => entry.source === 'agency' && entry.sourceId === sourceId
      )
      if (!item?.revision) throw new Error('团队成员模板缺失')
      return agency.template(sourceId, item.revision)
    })
    if (new Set(templates.map((template) => template.provenance.revision)).size !== 1)
      throw new Error('团队成员版本不一致')
    return db.installTeam({ ...manifest, revision, templates })
  } catch (error) {
    throw new Error('安装团队失败，请刷新目录后重试。', { cause: error })
  }
}
