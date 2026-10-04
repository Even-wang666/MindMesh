import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { prepareAgentCapabilities, toolCatalog } from '../capabilities'
import { getDshRuntimeInfo } from '../dsh-runtime'
import type { RuntimeRequest } from '../runtime-revision'
import { BundledPackageManager, DshCliRunner, stagingEnvironment } from './dsh-cli-runner'
import { pluginPackageDigests } from './plugin-inventory'

const installFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']

function yaml(text: string): unknown {
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length) throw new Error(`Invalid plugin configuration: ${document.errors[0].message}`)
  return document.toJS()
}

/** Replays sealed PR4 inputs; never resolves package ranges or copies staging storage. */
export async function materializePlugins(dataDirectory: string, home: string, request: RuntimeRequest, signal?: AbortSignal): Promise<void> {
  const plugins = request.plugins
  if (!plugins) return
  if (request.identity.flavor !== 'extended') throw new Error('Plugins require extended runtime')
  const artifact = plugins.artifact
  const artifactRoot = join(dataDirectory, 'plugin-artifacts')
  if (!artifact || !existsSync(artifactRoot) || lstatSync(artifact.directory).isSymbolicLink()
    || dirname(realpathSync(artifact.directory)) !== realpathSync(artifactRoot)) throw new Error('Validated plugin artifact missing or unsafe')
  const files: Record<string, string> = {}
  for (const name of ['dump-config.yml', 'capabilities.patch.yml', ...installFiles, 'composition.json']) {
    const path = join(artifact.directory, name)
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Unsafe plugin artifact file')
      files[name] = readFileSync(path, 'utf8')
    }
  }
  if (createHash('sha256').update(JSON.stringify(files)).digest('hex') !== artifact.digest) throw new Error('Plugin artifact digest mismatch')
  const composition = JSON.parse(files['composition.json'])
  const runtime = getDshRuntimeInfo()
  const expected = plugins.packages.map(({ packageName, version, configJson }) => ({ packageName, version, config: JSON.parse(configJson) }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName))
  if (artifact.revision !== plugins.desiredRevision || composition.revision !== plugins.desiredRevision
    || composition.runtimeVersion !== runtime.version || composition.pnpmVersion !== '11.7.0'
    || JSON.stringify(composition.enabled) !== JSON.stringify(expected)) throw new Error('Plugin artifact composition mismatch; validate the set again')
  let stagingRoot: string
  try {
    const storedPatch = yaml(files['capabilities.patch.yml'])
    const entry = z.object({ id: z.literal('skill-filesystem'), config: z.object({
      customSkillDirs: z.tuple([z.string().min(1).max(4096).refine((path) =>
        isAbsolute(path) || /^<STAGING_HOME>[\\/]/.test(path))]),
    }) }).parse(Array.isArray(storedPatch) ? storedPatch[0] : undefined)
    stagingRoot = dirname(entry.config.customSkillDirs[0])
  } catch (error) { throw new Error('插件能力配置无效，请重新验证插件。', { cause: error }) }
  const profile = join(home, 'profiles', 'sdk')
  mkdirSync(profile, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  for (const name of installFiles) {
    if (!files[name]) throw new Error(`Plugin install input missing: ${name}`)
    writeFileSync(join(profile, name), files[name])
  }
  const runner = new DshCliRunner(request.dshBin, new BundledPackageManager())
  const env = stagingEnvironment(home)
  const registry = composition.registry ?? 'https://registry.npmjs.org/'
  if (registry !== 'https://registry.npmjs.org/' && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(registry)) throw new Error('Invalid validated plugin registry')
  env.npm_config_registry = registry
  const run = (args: string[], name: string, initialize = false) => runner.run({ args, cwd: args[0] === '--mindmesh-pnpm' ? profile : home, env, signal,
    log: join(home, 'plugin-diagnostics', `${name}.log`), initialize })
  await run(['--mindmesh-pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--config.auto-install-peers=false', `--registry=${registry}`], 'install')
  if (JSON.stringify(pluginPackageDigests(join(profile, 'node_modules'))) !== JSON.stringify(composition.packageDigests)) throw new Error('Installed plugin manifests differ from validated set')
  const resolution = JSON.parse(await run(['--mindmesh-resolution', profile, home], 'resolution'))
  const sorted = (value: Record<string, unknown[]>) => JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, rows.map((row) => JSON.stringify(row)).sort()])))
  if (sorted(resolution) !== sorted(composition.resolution)) throw new Error('Plugin resolution differs from validated set')
  const installedDigest = pluginHomeDigest(home)
  // Compare the canonical full composition, separately from the actual Agent patch/Skills.
  const checkHome = join(home, 'plugin-validation')
  mkdirSync(checkHome)
  const patch = prepareAgentCapabilities({ ...request.agent, skills: [], tools: toolCatalog.filter((tool) => tool.id !== 'browser').map((tool) => tool.name) }, checkHome, checkHome)
  const normalize = (text: string, paths: string[]) => {
    for (const path of paths) text = text.replaceAll(JSON.stringify(path).slice(1, -1), '<STAGING_HOME>').replaceAll(path, '<STAGING_HOME>')
    return JSON.stringify(yaml(text))
  }
  if (normalize(readFileSync(patch, 'utf8'), [checkHome]) !== normalize(files['capabilities.patch.yml'], [stagingRoot])) throw new Error('Capability policy changed; validate plugins again')
  const dump = await run(['--profile', 'sdk', '--dump-config', '--patch', patch], 'canonical-config')
  if (normalize(dump, [checkHome, home]) !== normalize(files['dump-config.yml'], [stagingRoot])) throw new Error('Composed plugin config differs from validated set')
  const actualPatch = join(home, 'capabilities.cordis.patch.yml')
  yaml(await run(['--profile', 'sdk', '--dump-config', '--patch', actualPatch], 'agent-config'))
  await run(['--profile', 'sdk', '--patch', actualPatch], 'protocol', true)
  signal?.throwIfAborted()
  for (const name of installFiles) if (readFileSync(join(profile, name), 'utf8') !== files[name]) throw new Error(`Plugin mutated install input: ${name}`)
  if (pluginHomeDigest(home) !== installedDigest) throw new Error('Plugin mutated installed code during validation')
}

/** Detect altered plugin code before reusing a ready Home, including pnpm links. */
export function pluginHomeDigest(home: string): string {
  const profile = join(home, 'profiles', 'sdk'), modules = join(profile, 'node_modules')
  const hash = createHash('sha256'), seen = new Set<string>()
  for (const name of installFiles) hash.update(name).update(readFileSync(join(profile, name)))
  const visit = (path: string): void => {
    const actual = realpathSync(path)
    // An alias can be redirected to another already-visited package without changing its bytes.
    if (lstatSync(path).isSymbolicLink()) hash.update(relative(modules, path)).update(relative(modules, actual))
    if (seen.has(actual)) return
    seen.add(actual)
    if (!resolve(actual).startsWith(resolve(modules) + sep) && actual !== realpathSync(modules)) throw new Error('Plugin file points outside installed modules')
    if (lstatSync(actual).isDirectory()) {
      for (const entry of readdirSync(actual).sort()) if (entry !== '.dsh-module-fallback') visit(join(actual, entry))
    } else hash.update(relative(modules, actual)).update(readFileSync(actual))
  }
  visit(modules)
  return hash.digest('hex')
}
