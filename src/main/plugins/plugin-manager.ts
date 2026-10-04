import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { parseDocument } from 'yaml'
import { prepareAgentCapabilities, toolCatalog } from '../capabilities'
import { getDshRuntimeInfo } from '../dsh-runtime'
import { buildProviderSettingsYaml } from '../runtime-home-materializer'
import { BundledPackageManager, DshCliRunner, stagingEnvironment } from './dsh-cli-runner'
import { pluginPackageDigests } from './plugin-inventory'
import { PluginSetManager, pluginSetRevision, validatePluginSpec, type InstalledPlugin, type PluginArtifact, type PluginSetSnapshot } from './plugin-set'

export type PluginChange = { kind: 'install' | 'update'; packageName: string; version: string }
  | { kind: 'remove' | 'enable' | 'disable'; packageName: string }

const ttlMs = 7 * 24 * 60 * 60 * 1000

/** Fresh full-set install and boot, isolated from user configuration (not an OS sandbox). */
export class PluginStaging {
  private readonly runner: DshCliRunner
  private readonly version: string
  constructor(private readonly dataDirectory: string, resourcesPath = process.resourcesPath, private readonly fixtureRegistry?: string) {
    if (fixtureRegistry && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(fixtureRegistry)) throw new Error('Fixture registry must be loopback')
    const runtime = getDshRuntimeInfo(resourcesPath)
    this.version = runtime.version
    this.runner = new DshCliRunner(runtime.dshBin, new BundledPackageManager(resourcesPath))
  }

  async validate(plugins: InstalledPlugin[], signal?: AbortSignal): Promise<PluginArtifact> {
    signal?.throwIfAborted()
    const root = join(this.dataDirectory, 'plugin-staging')
    mkdirSync(root, { recursive: true })
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name) && !lstatSync(path).isSymbolicLink()
        && Date.now() - lstatSync(path).mtimeMs > ttlMs) rmSync(path, { recursive: true, force: true })
    }
    const directory = join(root, randomUUID())
    const home = join(directory, 'home'), workspace = join(directory, 'workspace'), logs = join(directory, 'logs')
    for (const path of [home, workspace, logs, join(home, 'tmp')]) mkdirSync(path, { recursive: true })
    const env = stagingEnvironment(home)
    if (this.fixtureRegistry) env.npm_config_registry = this.fixtureRegistry
    const agent = { id: 'plugin-staging', name: 'Plugin compatibility', role: '', persona: '', provider: 'deepseek-official', model: 'deepseek-v4-flash', skills: [], tools: toolCatalog.filter((tool) => tool.id !== 'browser').map((tool) => tool.name), createdAt: '' }
    const patch = prepareAgentCapabilities(agent, home, home)
    writeFileSync(join(home, 'settings.yaml'), buildProviderSettingsYaml([]))
    const run = (args: string[], name: string, initialize = false) => this.runner.run({ args, cwd: workspace, env, log: join(logs, `${name}.log`), signal, initialize })
    try {
      // Initializes the shipped SDK profile without executing plugin JavaScript.
      await run(['--profile', 'sdk', '--dump-config', '--patch', patch], 'base-config')
      const enabled = plugins.filter((plugin) => plugin.enabled).sort((a, b) => a.packageName.localeCompare(b.packageName))
      if (enabled.length) await run(['plugin', '--profile', 'sdk', 'add', '--save-exact', '--ignore-scripts', '--config.auto-install-peers=false', `--registry=${this.fixtureRegistry ?? 'https://registry.npmjs.org/'}`, ...enabled.map((plugin) => `${plugin.packageName}@${plugin.version}`)], 'install')
      const profile = join(home, 'profiles', 'sdk')
      pluginPackageDigests(join(profile, 'node_modules'))
      for (const plugin of enabled) {
        const installed = JSON.parse(readFileSync(join(profile, 'node_modules', plugin.packageName, 'package.json'), 'utf8'))
        if (installed.name !== plugin.packageName || installed.version !== plugin.version || !installed.dsh?.bundle?.patch) throw new Error(`Plugin exact version or bundle missing: ${plugin.packageName}`)
      }
      const resolution = JSON.parse(await run(['--mindmesh-resolution', profile, home], 'resolution'))
      const installInputs = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'].map((file) => {
        const path = join(profile, file)
        return [file, existsSync(path) ? readFileSync(path, 'utf8') : null]
      }))
      const dump = await run(['--profile', 'sdk', '--dump-config', '--patch', patch], 'dump-config')
      const document = parseDocument(dump, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
      if (document.errors.length) throw new Error(`Invalid composed plugin config: ${document.errors[0].message}`)
      const ids = new Set<string>()
      const checkEntries = (entries: unknown): void => {
        if (!Array.isArray(entries)) throw new Error('Plugin config must be an entry list')
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') throw new Error('Invalid plugin config entry')
          const { id, config, name } = entry as { id?: string; config?: unknown; name?: string }
          if (id) { if (ids.has(id)) throw new Error(`Plugin set conflict: duplicate id ${id}`); ids.add(id) }
          if (name === '@deepseek-ai/cordis-plugin-group' && Array.isArray(config)) checkEntries(config)
        }
      }
      checkEntries(document.toJS())
      // SDK transport ignores non-JSON lines. Probe framing strictly before its own handshake.
      await run(['--profile', 'sdk', '--patch', patch], 'protocol', true)
      signal?.throwIfAborted()
      const sdk = new DeepSeekHarness({ dshBin: this.runner.dshBin, dshHome: home, processCwd: workspace,
        cwd: workspace, patches: [patch], env, initializeTimeoutMs: 30_000, shutdownTimeoutMs: 2_000 })
      const abort = (): void => { void sdk.close().catch(() => {}) }
      signal?.addEventListener('abort', abort, { once: true })
      try { await sdk.start(); signal?.throwIfAborted() } finally { signal?.removeEventListener('abort', abort); await sdk.close() }
      signal?.throwIfAborted()
      for (const [file, expected] of Object.entries(installInputs)) {
        const path = join(profile, file)
        if ((existsSync(path) ? readFileSync(path, 'utf8') : null) !== expected) throw new Error(`Plugin mutated validated install inputs: ${file}`)
      }
      // Retain only declarative, reproducible install inputs. No live Home/session storage.
      const revision = pluginSetRevision(plugins)
      const artifactDirectory = join(this.dataDirectory, 'plugin-artifacts', randomUUID())
      mkdirSync(artifactDirectory, { recursive: true })
      const files: Record<string, string> = { 'dump-config.yml': dump.replaceAll(home, '<STAGING_HOME>'), 'capabilities.patch.yml': readFileSync(patch, 'utf8').replaceAll(home, '<STAGING_HOME>') }
      for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
        const source = join(profile, file)
        if (existsSync(source)) files[file] = readFileSync(source, 'utf8')
      }
      files['composition.json'] = JSON.stringify({ runtimeVersion: this.version, pnpmVersion: '11.7.0', registry: this.fixtureRegistry ?? 'https://registry.npmjs.org/', revision, enabled: enabled.map(({ packageName, version, config }) => ({ packageName, version, config })), packageDigests: pluginPackageDigests(join(profile, 'node_modules')), resolution }, null, 2)
      const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
      for (const [name, content] of Object.entries(files)) writeFileSync(join(artifactDirectory, name), content)
      writeFileSync(join(directory, 'result.json'), JSON.stringify({ status: 'validated', revision, digest }))
      return { revision, directory: artifactDirectory, digest }
    } catch (error) {
      const message = String(error).replace(/(bearer\s+|api[_-]?key[=:]\s*)[^\s,]+/gi, '$1[REDACTED]').slice(-4096)
      writeFileSync(join(directory, 'result.json'), JSON.stringify({ status: signal?.aborted ? 'cancelled' : 'failed', message }))
      throw new Error(`Plugin staging failed: ${message}. Local diagnostics: ${directory}`, { cause: error })
    }
  }


}

/** Serializes all mutations; only a validated full candidate set can enter the DB. */
export class PluginManager {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly set: PluginSetManager, private readonly staging: PluginStaging) {}
  snapshot(): PluginSetSnapshot { return this.set.snapshot() }
  change(change: PluginChange, signal?: AbortSignal): Promise<PluginSetSnapshot> {
    const operation = this.queue.then(async () => {
      signal?.throwIfAborted()
      const before = this.set.snapshot(), plugins = structuredClone(before.plugins)
      const index = plugins.findIndex((plugin) => plugin.packageName === change.packageName)
      const now = new Date().toISOString()
      if (change.kind === 'install' || change.kind === 'update') {
        validatePluginSpec(change.packageName, change.version)
        if (change.kind === 'install' && index >= 0) throw new Error('Plugin already installed')
        if (change.kind === 'update' && index < 0) throw new Error('Plugin not installed')
        const plugin = { packageName: change.packageName, version: change.version, enabled: index < 0 ? true : plugins[index].enabled,
          config: index < 0 ? {} : plugins[index].config, installedAt: index < 0 ? now : plugins[index].installedAt, updatedAt: now }
        if (index < 0) plugins.push(plugin); else plugins[index] = plugin
      } else {
        if (index < 0) throw new Error('Plugin not installed')
        if (change.kind === 'remove') plugins.splice(index, 1)
        else { plugins[index].enabled = change.kind === 'enable'; plugins[index].updatedAt = now }
      }
      const artifact = await this.staging.validate(plugins, signal)
      signal?.throwIfAborted()
      return this.set.commit(before.generation, plugins, artifact)
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}
