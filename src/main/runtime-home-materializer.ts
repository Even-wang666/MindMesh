import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { prepareAgentCapabilities } from './capabilities'
import type { RuntimeIdentity, RuntimeRequest } from './runtime-revision'
import type { ModelProviderRuntimeConfig } from './model-provider-settings'
import { skillBundlesRevision } from './skills'
import { getModelProviderDefinition, MODEL_CATALOG } from '../shared/model-providers'

const RETENTION_MS = 7 * 24 * 60 * 60_000
type Metadata = { identity: RuntimeIdentity; state: 'ready'; composition: string; lastUsedAt: number }

/** Owns app composition and retention; never copies legacy DSH session/storage state. */
export class RuntimeHomeMaterializer {
  constructor(private readonly dataDirectory: string) {}

  ensure(request: RuntimeRequest): { dshHome: string; capabilityPatch: string; created: boolean } {
    const root = join(this.dataDirectory, 'runtime-v2')
    mkdirSync(root, { recursive: true })
    if (!/^[a-f0-9]{64}$/.test(request.identity.key)) throw new Error('Invalid runtime home key')
    const home = join(root, request.identity.key)
    const metadataPath = join(home, 'metadata.json')
    const patch = join(home, 'capabilities.cordis.patch.yml')
    if (existsSync(home)) {
      if (lstatSync(home).isSymbolicLink() || dirname(realpathSync(home)) !== realpathSync(root)) throw new Error('Runtime home path is unsafe')
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Metadata
        if (metadata.state === 'ready' && JSON.stringify(metadata.identity) === JSON.stringify(request.identity)
          && metadata.composition === this.composition(home)
          && skillBundlesRevision(request.skillIds.map((id) => join(home, 'selected-skills', id))) === request.identity.skillRevision) {
          this.markLastUsed(request.identity.key)
          return { dshHome: home, capabilityPatch: patch, created: false }
        }
      } catch { /* An interrupted or altered app composition must be rebuilt. */ }
      // Preserve invalid state for diagnosis/rollback; do not reuse its sessions in the rebuilt home.
      renameSync(home, `${home}.invalid-${randomUUID()}`)
    }
    mkdirSync(home)
    writeFileSync(join(home, 'settings.yaml'), buildProviderSettingsYaml(request.providers))
    prepareAgentCapabilities(request.agent, this.dataDirectory, home)
    const copiedRevision = skillBundlesRevision(request.skillIds.map((id) => join(home, 'selected-skills', id)))
    if (copiedRevision !== request.identity.skillRevision) throw new Error('Skill content changed while preparing runtime')
    const metadata: Metadata = { identity: request.identity, state: 'ready', composition: this.composition(home), lastUsedAt: Date.now() }
    writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 })
    return { dshHome: home, capabilityPatch: patch, created: true }
  }

  markLastUsed(key: string): void {
    const path = join(this.dataDirectory, 'runtime-v2', key, 'metadata.json')
    const metadata = JSON.parse(readFileSync(path, 'utf8')) as Metadata
    metadata.lastUsedAt = Date.now()
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(metadata), { mode: 0o600 })
    renameSync(temporary, path)
  }

  cleanupExpired(references: string[], activeKeys: string[]): void {
    const root = join(this.dataDirectory, 'runtime-v2')
    if (!existsSync(root)) return
    const rootPath = realpathSync(root)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || activeKeys.includes(entry.name)) continue
      const target = resolve(rootPath, entry.name)
      try {
        if (dirname(target) !== rootPath || lstatSync(target).isSymbolicLink() || dirname(realpathSync(target)) !== rootPath) continue
        const metadata = JSON.parse(readFileSync(join(target, 'metadata.json'), 'utf8')) as Metadata
        if (metadata.state !== 'ready' || metadata.identity.key !== entry.name
          || references.includes(metadata.identity.capabilityHash) || !Number.isFinite(metadata.lastUsedAt)
          || Date.now() - metadata.lastUsedAt < RETENTION_MS) continue
        rmSync(target, { recursive: true, force: true })
      } catch { /* Unknown, incomplete or busy directories are retained. */ }
    }
  }

  private composition(home: string): string {
    return createHash('sha256').update(readFileSync(join(home, 'settings.yaml')))
      .update(readFileSync(join(home, 'capabilities.cordis.patch.yml'))).digest('hex')
  }
}

export function buildProviderSettingsYaml(providers: readonly ModelProviderRuntimeConfig[]): string {
  const lines = ['llm-pi-ai:', '  providers:']
  for (const provider of providers) {
    if (provider.id === 'deepseek-official') continue
    if (provider.id === 'custom') {
      lines.push('    custom:', `      displayName: ${JSON.stringify(provider.name)}`, '      apiKeyEnv: MINDMESH_CUSTOM_API_KEY',
        '      api: openai-completions', `      baseURL: ${JSON.stringify(provider.baseUrl)}`, '      models:',
        `        - id: ${JSON.stringify(provider.model)}`, `          name: ${JSON.stringify(provider.model)}`,
        '          contextWindow: 131072', '          maxTokens: 8192')
      continue
    }
    const definition = getModelProviderDefinition(provider.id)
    if (['moonshotai-cn', 'openai', 'anthropic'].includes(provider.id)) {
      lines.push(`    ${provider.id}:`, `      apiKeyEnv: ${definition?.environmentKey}`)
      continue
    }
    const models = MODEL_CATALOG.filter((model) => model.provider === provider.id)
    lines.push(`    ${provider.id}:`, `      displayName: ${JSON.stringify(provider.name)}`, `      apiKeyEnv: ${definition?.environmentKey}`,
      '      api: openai-completions', `      baseURL: ${JSON.stringify(definition?.baseUrl)}`, '      models:',
      ...models.flatMap((model) => [`        - id: ${JSON.stringify(model.id)}`, `          name: ${JSON.stringify(model.name)}`,
        `          contextWindow: ${model.contextWindow ?? 131072}`, '          maxTokens: 8192']))
  }
  return lines.length === 2 ? 'llm-pi-ai:\n  providers: {}\n' : `${lines.join('\n')}\n`
}
