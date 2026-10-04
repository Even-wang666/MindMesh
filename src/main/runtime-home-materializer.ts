import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { prepareAgentCapabilities } from './capabilities'
import type { RuntimeIdentity, RuntimeRequest } from './runtime-revision'
import type { ModelProviderRuntimeConfig } from './model-provider-settings'
import { skillBundlesRevision } from './skills'
import { getModelProviderDefinition, MODEL_CATALOG } from '../shared/model-providers'
import { materializePlugins, pluginHomeDigest } from './plugins/plugin-runtime'
import { parseDocument } from 'yaml'

const RETENTION_MS = 7 * 24 * 60 * 60_000
type Metadata = {
  identity: RuntimeIdentity
  state: 'ready'
  composition: string
  lastUsedAt: number
}

/** Owns app composition and retention; never copies legacy DSH session/storage state. */
export class RuntimeHomeMaterializer {
  constructor(private readonly dataDirectory: string) {}

  async ensure(
    request: RuntimeRequest,
    signal?: AbortSignal
  ): Promise<{ dshHome: string; capabilityPatch: string; created: boolean }> {
    signal?.throwIfAborted()
    let root = join(this.dataDirectory, 'runtime-v2')
    mkdirSync(root, { recursive: true })
    root = realpathSync.native(root)
    if (!/^[a-f0-9]{64}$/.test(request.identity.key)) throw new Error('Invalid runtime home key')
    const home = join(root, request.identity.key)
    const metadataPath = join(home, 'metadata.json')
    const patch = join(home, 'capabilities.cordis.patch.yml')
    if (existsSync(home)) {
      if (lstatSync(home).isSymbolicLink() || dirname(realpathSync(home)) !== realpathSync(root))
        throw new Error('Runtime home path is unsafe')
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Metadata
        if (
          metadata.state === 'ready' &&
          JSON.stringify(metadata.identity) === JSON.stringify(request.identity) &&
          metadata.composition === this.composition(home, Boolean(request.plugins)) &&
          (request.plugins || this.coreProfileIntact(home)) &&
          skillBundlesRevision(request.skillIds.map((id) => join(home, 'selected-skills', id))) ===
            request.identity.skillRevision
        ) {
          this.markLastUsed(request.identity.key)
          return { dshHome: home, capabilityPatch: patch, created: false }
        }
      } catch {
        /* An interrupted or altered app composition must be rebuilt. */
      }
      // Preserve invalid state for diagnosis/rollback; do not reuse its sessions in the rebuilt home.
      renameSync(home, `${home}.invalid-${randomUUID()}`)
    }
    mkdirSync(home)
    // settings.yaml is a legacy DSH import that renames itself and mutates the profile.
    // Keep our provider input separate and supply it through the app-owned patch instead.
    const providers = buildProviderSettingsYaml(request.providers)
    writeFileSync(join(home, 'provider-settings.yaml'), providers)
    prepareAgentCapabilities(request.agent, this.dataDirectory, home)
    const providerPatch = [
      '- id: llm-pi-ai',
      '  config:',
      ...providers
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((line) => `  ${line}`),
    ].join('\n')
    writeFileSync(patch, `${readFileSync(patch, 'utf8')}\n${providerPatch}\n`)
    const patchContent = readFileSync(patch, 'utf8')
    const copiedRevision = skillBundlesRevision(
      request.skillIds.map((id) => join(home, 'selected-skills', id))
    )
    if (copiedRevision !== request.identity.skillRevision)
      throw new Error('Skill content changed while preparing runtime')
    try {
      await materializePlugins(this.dataDirectory, home, request, signal)
    } catch (error) {
      writeFileSync(
        join(home, 'materialization-failure.json'),
        JSON.stringify({
          at: new Date().toISOString(),
          kind: 'materialization',
          cancelled: Boolean(signal?.aborted),
          diagnostics: 'plugin-diagnostics',
        })
      )
      throw error
    }
    signal?.throwIfAborted()
    if (
      readFileSync(patch, 'utf8') !== patchContent ||
      readFileSync(join(home, 'provider-settings.yaml'), 'utf8') !== providers ||
      skillBundlesRevision(request.skillIds.map((id) => join(home, 'selected-skills', id))) !==
        copiedRevision
    )
      throw new Error('Plugin mutated application composition')
    const metadata: Metadata = {
      identity: request.identity,
      state: 'ready',
      composition: this.composition(home, Boolean(request.plugins)),
      lastUsedAt: Date.now(),
    }
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
      if (
        !entry.isDirectory() ||
        !/^[a-f0-9]{64}$/.test(entry.name) ||
        activeKeys.includes(entry.name)
      )
        continue
      const target = resolve(rootPath, entry.name)
      try {
        if (
          dirname(target) !== rootPath ||
          lstatSync(target).isSymbolicLink() ||
          dirname(realpathSync(target)) !== rootPath
        )
          continue
        const metadata = JSON.parse(readFileSync(join(target, 'metadata.json'), 'utf8')) as Metadata
        if (
          metadata.state !== 'ready' ||
          metadata.identity.key !== entry.name ||
          references.includes(metadata.identity.capabilityHash) ||
          !Number.isFinite(metadata.lastUsedAt) ||
          Date.now() - metadata.lastUsedAt < RETENTION_MS
        )
          continue
        rmSync(target, { recursive: true, force: true })
      } catch {
        /* Unknown, incomplete or busy directories are retained. */
      }
    }
  }

  private composition(home: string, plugins: boolean): string {
    return createHash('sha256')
      .update(readFileSync(join(home, 'provider-settings.yaml')))
      .update(readFileSync(join(home, 'capabilities.cordis.patch.yml')))
      .update(plugins ? pluginHomeDigest(home) : '')
      .digest('hex')
  }

  private coreProfileIntact(home: string): boolean {
    const profile = join(home, 'profiles', 'sdk')
    if (!existsSync(profile)) return true
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    if (
      JSON.stringify(manifest.dsh?.profile?.bundles) !==
        JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']) ||
      Object.keys(manifest.dependencies ?? {}).length ||
      Object.keys(manifest.devDependencies ?? {}).length
    )
      return false
    const document = parseDocument(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'))
    if (document.errors.length || JSON.stringify(document.toJS()) !== '[]') return false
    const modules = join(profile, 'node_modules')
    return (
      !existsSync(modules) || readdirSync(modules).every((name) => name === '.dsh-module-fallback')
    )
  }
}

export function buildProviderSettingsYaml(
  providers: readonly ModelProviderRuntimeConfig[]
): string {
  const lines = ['llm-pi-ai:', '  providers:']
  for (const provider of providers) {
    if (provider.id === 'deepseek-official') continue
    if (provider.id === 'custom') {
      lines.push(
        '    custom:',
        `      displayName: ${JSON.stringify(provider.name)}`,
        '      apiKeyEnv: MINDMESH_CUSTOM_API_KEY',
        '      api: openai-completions',
        `      baseURL: ${JSON.stringify(provider.baseUrl)}`,
        '      models:',
        `        - id: ${JSON.stringify(provider.model)}`,
        `          name: ${JSON.stringify(provider.model)}`,
        '          contextWindow: 131072',
        '          maxTokens: 8192'
      )
      continue
    }
    const definition = getModelProviderDefinition(provider.id)
    if (['moonshotai-cn', 'openai', 'anthropic'].includes(provider.id)) {
      lines.push(`    ${provider.id}:`, `      apiKeyEnv: ${definition?.environmentKey}`)
      continue
    }
    const models = MODEL_CATALOG.filter((model) => model.provider === provider.id)
    lines.push(
      `    ${provider.id}:`,
      `      displayName: ${JSON.stringify(provider.name)}`,
      `      apiKeyEnv: ${definition?.environmentKey}`,
      '      api: openai-completions',
      `      baseURL: ${JSON.stringify(definition?.baseUrl)}`,
      '      models:',
      ...models.flatMap((model) => [
        `        - id: ${JSON.stringify(model.id)}`,
        `          name: ${JSON.stringify(model.name)}`,
        `          contextWindow: ${model.contextWindow ?? 131072}`,
        '          maxTokens: 8192',
      ])
    )
  }
  return lines.length === 2 ? 'llm-pi-ai:\n  providers: {}\n' : `${lines.join('\n')}\n`
}
