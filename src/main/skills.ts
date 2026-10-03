import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import parseSpdxExpression from 'spdx-expression-parse'
import { parse } from 'yaml'
import type { SkillInstallProgress } from '../shared/contracts'
import { parseSkillReference } from '../shared/skill-reference'
import { withGitHubSkillBundle } from './skill-github'
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES } from './skill-limits'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_FILE_BYTES = 65_536
const DISPLAY_NAME_KEY = 'mindmesh.displayName'
const BUNDLED_RECEIPT = '.mindmesh-bundled.json'
const INSTALL_RECEIPT = '.mindmesh-install.json'

export type SkillInvocationPolicy = 'auto' | 'user-invocable' | 'disabled'

export type SkillManifest = {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata: Record<string, unknown>
  allowedTools?: string
  argumentHint?: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  invocationPolicy: SkillInvocationPolicy
  raw: Record<string, unknown>
}

export type SkillCatalogItem = {
  id: string
  name: string
  description: string
  status: '已安装' | '仅手动调用' | '已禁用' | '不可用'
  available: boolean
  diagnostic?: string
  source: string
  integrity: 'verified' | 'modified' | 'untracked'
  license?: string
  licenseSpdx?: boolean
  limitations: string[]
  path: string
  directory: string
  manifest?: SkillManifest
}

type BundledManifest = { version: number; skills: string[] }

export type InstalledSkillReceipt = {
  source: { kind: 'local'; path: string } | {
    kind: 'github'
    url: string
    repository: string
    commit: string
    path: string
  }
  installedAt: string
  contentHash: string
  license: { declared?: string; spdx?: string }
}

export function seedBundledSkills(sourceRoot: string, dataDirectory: string): void {
  const bundled = readBundledManifest(sourceRoot)
  const destinationRoot = join(dataDirectory, 'skills')
  mkdirSync(destinationRoot, { recursive: true })
  const previous = readJsonFile<{ version?: number; skills?: Array<{ name?: string }> }>(join(destinationRoot, BUNDLED_RECEIPT))
  const refreshAll = previous?.version !== bundled.version
  const previouslyManaged = new Set(previous?.skills?.map((item) => item.name).filter((name): name is string => Boolean(name)) ?? [])

  const receipts = bundled.skills.flatMap((name) => {
    if (!SKILL_NAME.test(name)) throw new Error(`内置技能名称无效：${name}`)
    const source = containedPath(sourceRoot, name)
    const parsed = readSkillBundle(source)
    if (!parsed.manifest || parsed.id !== name) {
      throw new Error(`内置技能「${name}」无效：${parsed.diagnostic ?? 'manifest 无效'}`)
    }
    const destination = containedPath(destinationRoot, name)
    const exists = existsSync(destination)
    const mayReplace = !exists || previouslyManaged.has(name)
      || (previous === undefined && isLegacyBundledSkill(destination, parsed.manifest))
    if (refreshAll && !mayReplace) return []
    if ((refreshAll && mayReplace) || !exists) replaceDirectory(source, destination)
    return [{
      name,
      source: 'bundled',
      contentHash: hashDirectory(source),
      license: licenseReceipt(parsed.manifest.license),
    }]
  })

  writeJsonAtomically(join(destinationRoot, BUNDLED_RECEIPT), {
    version: bundled.version,
    installedAt: new Date().toISOString(),
    skills: receipts,
  })
}

export function listSkillCatalog(dataDirectory: string): SkillCatalogItem[] {
  const root = join(dataDirectory, 'skills')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => readSkillBundle(join(root, entry.name)))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function installSkillBundle(sourceDirectory: string, dataDirectory: string): SkillCatalogItem {
  const source = resolve(sourceDirectory)
  return installSkillBundleWithReceipt(source, dataDirectory, { kind: 'local', path: source })
}

export async function installSkillFromGitHub(
  input: string,
  dataDirectory: string,
  onProgress?: (progress: SkillInstallProgress) => void,
): Promise<SkillCatalogItem> {
  return withGitHubSkillBundle(input, onProgress,
    (source, receipt) => installSkillBundleWithReceipt(source, dataDirectory, receipt))
}

function installSkillBundleWithReceipt(
  source: string,
  dataDirectory: string,
  receiptSource: InstalledSkillReceipt['source'],
): SkillCatalogItem {
  const candidate = readSkillBundle(source)
  if (!candidate.manifest) throw new Error(`无法安装技能：${candidate.diagnostic ?? 'bundle 无效'}`)
  const root = join(dataDirectory, 'skills')
  mkdirSync(root, { recursive: true })
  const bundled = readJsonFile<{ skills?: Array<{ name?: string }> }>(join(root, BUNDLED_RECEIPT))
  if (bundled?.skills?.some((item) => item.name === candidate.id)) {
    throw new Error(`不能覆盖内置技能「${candidate.name}」`)
  }

  const destination = containedPath(root, candidate.id)
  if (existsSync(destination) && !readInstalledReceipt(destination)) {
    throw new Error(`不能覆盖来源不明的技能「${candidate.name}」`)
  }
  const temporary = join(root, `.${candidate.id}-${randomUUID()}`)
  cpSync(source, temporary, { recursive: true, errorOnExist: true })
  const receipt: InstalledSkillReceipt = {
    source: receiptSource,
    installedAt: new Date().toISOString(),
    contentHash: hashDirectory(source),
    license: licenseReceipt(candidate.manifest.license),
  }
  writeFileSync(join(temporary, INSTALL_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`)
  try { replacePreparedDirectory(temporary, destination) }
  catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  return readSkillBundle(destination)
}

export function copySelectedSkillBundles(skills: SkillCatalogItem[], destinationRoot: string): void {
  const parent = resolve(destinationRoot, '..')
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.${basename(destinationRoot)}-${randomUUID()}`)
  mkdirSync(temporary)
  try {
    for (const skill of skills) {
      if (!skill.available) throw new Error(`技能「${skill.name}」不可用：${skill.diagnostic ?? 'manifest 无效'}`)
      assertNoSymbolicLinks(skill.directory)
      cpSync(skill.directory, join(temporary, skill.id), { recursive: true, errorOnExist: true })
    }
    replacePreparedDirectory(temporary, destinationRoot)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function resolveSelectedSkills(values: string[], dataDirectory: string): SkillCatalogItem[] {
  const catalog = listSkillCatalog(dataDirectory)
  return values.map((value) => {
    const reference = parseSkillReference(value)
    const legacyMatches = reference ? [] : catalog.filter((item) => item.available && item.name === value)
    if (legacyMatches.length > 1) throw new Error(`技能「${value}」有多个版本，请编辑智能体并重新选择`)
    const skill = reference ? catalog.find((item) => item.id === reference.id) : legacyMatches[0]
    if (!skill) throw new Error(`技能「${reference?.name ?? value}」未安装`)
    if (!skill.available) throw new Error(`技能「${reference?.name ?? value}」不可用：${skill.diagnostic}`)
    return skill
  })
}

export function selectedSkillsRevision(values: string[], dataDirectory: string): string {
  return skillBundlesRevision(resolveSelectedSkills(values, dataDirectory).map((skill) => skill.directory))
}

export function skillBundlesRevision(directories: string[]): string {
  if (directories.length === 0) return ''
  const hash = createHash('sha256')
  for (const directory of [...directories].sort((left, right) => basename(left).localeCompare(basename(right)))) {
    hash.update(basename(directory)).update(hashDirectory(directory))
  }
  return hash.digest('hex')
}

function readSkillBundle(directory: string): SkillCatalogItem {
  const id = basename(directory)
  const path = join(directory, 'SKILL.md')
  const invalid = (diagnostic: string): SkillCatalogItem => ({
    id,
    name: id,
    description: diagnostic,
    status: '不可用',
    available: false,
    diagnostic,
    source: '未托管',
    integrity: 'untracked',
    limitations: [],
    path,
    directory,
  })

  if (!existsSync(path)) return invalid('缺少 SKILL.md')
  let bundleFiles: string[]
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return invalid('SKILL.md 必须是普通文件')
    if (stat.size > MAX_SKILL_FILE_BYTES) return invalid('SKILL.md 超过 64 KiB')
    bundleFiles = collectBundleFiles(directory)
  } catch (error) {
    return invalid(`bundle 无法读取：${errorMessage(error)}`)
  }

  let frontmatter: Record<string, unknown>
  try {
    const source = readFileSync(path, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
    if (!match) return invalid('缺少 YAML frontmatter')
    const value = parse(match[1])
    if (!isRecord(value)) return invalid('frontmatter 必须是对象')
    frontmatter = value
  } catch (error) {
    return invalid(`YAML 解析失败：${errorMessage(error)}`)
  }

  const name = stringField(frontmatter, 'name')
  const description = stringField(frontmatter, 'description')
  if (!name || !description) return invalid('frontmatter 必须包含 name 和 description')
  if (name.length > 64 || !SKILL_NAME.test(name)) return invalid('name 必须是 1–64 位 kebab-case')
  if (name !== id) return invalid(`name 必须与目录名一致（应为 ${id}）`)
  if (description.length > 1024) return invalid('description 超过 1024 字符')

  const metadata = isRecord(frontmatter.metadata) ? frontmatter.metadata : {}
  const disableModelInvocation = booleanField(frontmatter, 'disable-model-invocation')
  const userInvocable = booleanField(frontmatter, 'user-invocable')
  const legacyInvocationKey = ['disableModelInvocation', 'modelInvocable', 'userInvocable']
    .find((key) => Object.hasOwn(frontmatter, key))
  if (legacyInvocationKey) return invalid(`不支持字段 ${legacyInvocationKey}，请使用 DSH canonical invocation 字段`)
  if (disableModelInvocation === 'invalid' || userInvocable === 'invalid') {
    return invalid('invocation 字段必须是布尔值')
  }
  const invocationPolicy: SkillInvocationPolicy = disableModelInvocation === true
    ? userInvocable === false ? 'disabled' : 'user-invocable'
    : 'auto'
  const displayName = stringValue(metadata[DISPLAY_NAME_KEY]) ?? name
  const manifest: SkillManifest = {
    name,
    description,
    metadata,
    invocationPolicy,
    raw: frontmatter,
    ...optionalString(frontmatter, 'license', 'license'),
    ...optionalString(frontmatter, 'compatibility', 'compatibility'),
    ...optionalString(frontmatter, 'allowed-tools', 'allowedTools'),
    ...optionalString(frontmatter, 'argument-hint', 'argumentHint'),
    ...optionalString(frontmatter, 'whenToUse', 'whenToUse'),
    ...(typeof disableModelInvocation === 'boolean' ? { disableModelInvocation } : {}),
    ...(typeof userInvocable === 'boolean' ? { userInvocable } : {}),
  }
  const disabled = invocationPolicy === 'disabled'
  const bundledReceipt = readJsonFile<{ skills?: Array<{ name?: string; contentHash?: string; license?: InstalledSkillReceipt['license'] }> }>(join(dirname(directory), BUNDLED_RECEIPT))
    ?.skills?.find((item) => item.name === id)
  const installedReceipt = readInstalledReceipt(directory)
  const receipt = bundledReceipt ?? installedReceipt
  const contentHash = receipt ? hashDirectory(directory) : undefined
  const limitations = skillLimitations(manifest, bundleFiles)
  return {
    id,
    name: displayName,
    description,
    status: disabled ? '已禁用' : invocationPolicy === 'user-invocable' ? '仅手动调用' : '已安装',
    available: !disabled,
    ...(disabled ? { diagnostic: '该技能禁止模型调用和用户调用' } : {}),
    source: bundledReceipt ? 'MindMesh 内置'
      : installedReceipt?.source.kind === 'github'
        ? `GitHub：${installedReceipt.source.repository}@${installedReceipt.source.commit.slice(0, 7)}`
        : installedReceipt ? `本地导入：${basename(installedReceipt.source.path)}` : '手动放入',
    integrity: receipt ? receipt.contentHash === contentHash ? 'verified' : 'modified' : 'untracked',
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.license && receipt?.license ? { licenseSpdx: Boolean(receipt.license.spdx) } : {}),
    limitations,
    path,
    directory,
    manifest,
  }
}

function readBundledManifest(sourceRoot: string): BundledManifest {
  const value = readJsonFile<unknown>(join(sourceRoot, 'manifest.json'))
  if (!isRecord(value) || !Number.isInteger(value.version) || Number(value.version) < 1
    || !Array.isArray(value.skills) || !value.skills.every((item) => typeof item === 'string')) {
    throw new Error('内置技能 manifest.json 无效')
  }
  return { version: Number(value.version), skills: value.skills as string[] }
}

function replaceDirectory(source: string, destination: string): void {
  assertNoSymbolicLinks(source)
  const parent = resolve(destination, '..')
  const temporary = join(parent, `.${basename(destination)}-${randomUUID()}`)
  cpSync(source, temporary, { recursive: true, errorOnExist: true })
  try { replacePreparedDirectory(temporary, destination) }
  catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function replacePreparedDirectory(prepared: string, destination: string): void {
  const backup = `${destination}.backup-${randomUUID()}`
  const hadDestination = existsSync(destination)
  if (hadDestination) renameSync(destination, backup)
  try {
    renameSync(prepared, destination)
    if (hadDestination) rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (hadDestination && existsSync(backup) && !existsSync(destination)) renameSync(backup, destination)
    throw error
  }
}

function assertNoSymbolicLinks(root: string): void {
  collectBundleFiles(root)
}

function hashDirectory(root: string): string {
  const hash = createHash('sha256')
  for (const path of collectBundleFiles(root).filter((path) => basename(path) !== INSTALL_RECEIPT)) {
    hash.update(relative(root, path).split(sep).join('/')).update(readFileSync(path))
  }
  return hash.digest('hex')
}

function collectBundleFiles(root: string): string[] {
  const files: string[] = []
  const directories = [root]
  let bytes = 0
  while (directories.length > 0) {
    const directory = directories.pop()!
    const handle = opendirSync(directory)
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        const path = join(directory, entry.name)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) throw new Error(`技能 bundle 不允许符号链接：${path}`)
        if (stat.isDirectory()) directories.push(path)
        else if (stat.isFile()) {
          if (entry.name === INSTALL_RECEIPT) continue
          files.push(path)
          bytes += stat.size
          if (files.length > MAX_BUNDLE_FILES) throw new Error(`技能 bundle 超过 ${MAX_BUNDLE_FILES} 个文件`)
          if (bytes > MAX_BUNDLE_BYTES) throw new Error('技能 bundle 超过 16 MiB')
        } else throw new Error(`技能 bundle 包含不支持的文件：${path}`)
      }
    } finally { handle.closeSync() }
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)))
}

function containedPath(root: string, child: string): string {
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, child)
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) throw new Error(`路径越界：${child}`)
  return target
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const backup = `${path}.${randomUUID()}.backup`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  const hadPath = existsSync(path)
  try {
    if (hadPath) renameSync(path, backup)
    renameSync(temporary, path)
    if (hadPath) rmSync(backup, { force: true })
  } catch (error) {
    if (hadPath && existsSync(backup) && !existsSync(path)) renameSync(backup, path)
    throw error
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

function readInstalledReceipt(directory: string): InstalledSkillReceipt | undefined {
  const value = readJsonFile<unknown>(join(directory, INSTALL_RECEIPT))
  if (!isRecord(value) || !isInstalledSource(value.source) || typeof value.installedAt !== 'string'
    || typeof value.contentHash !== 'string' || !isRecord(value.license)) return undefined
  return value as InstalledSkillReceipt
}

function isInstalledSource(value: unknown): value is InstalledSkillReceipt['source'] {
  if (!isRecord(value)) return false
  if (value.kind === 'local') return typeof value.path === 'string'
  return value.kind === 'github' && typeof value.url === 'string' && typeof value.repository === 'string'
    && /^[a-f0-9]{40}$/.test(String(value.commit)) && typeof value.path === 'string'
}

function licenseReceipt(declared?: string): InstalledSkillReceipt['license'] {
  if (!declared) return {}
  try {
    parseSpdxExpression(declared)
    return { declared, spdx: declared }
  } catch { return { declared } }
}

function isLegacyBundledSkill(directory: string, replacement: SkillManifest): boolean {
  const path = join(directory, 'SKILL.md')
  if (!existsSync(path)) return false
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, 'utf8'))
    const legacy = match ? parse(match[1]) : undefined
    const displayName = stringValue(replacement.metadata[DISPLAY_NAME_KEY])
    return isRecord(legacy) && legacy.name === displayName && legacy.description === replacement.description
  } catch { return false }
}

function skillLimitations(manifest: SkillManifest, files: string[]): string[] {
  const limitations: string[] = []
  if (manifest.allowedTools) limitations.push(`声明了实验性 allowed-tools：${manifest.allowedTools}；仍以智能体授权为准`)
  if (manifest.compatibility) limitations.push(`作者兼容性声明：${manifest.compatibility}`)
  if (process.platform === 'win32' && files.some((path) => path.toLowerCase().endsWith('.sh'))) {
    limitations.push('包含 Bash 脚本；当前 Windows runtime 仅保证资源可读，不保证直接执行')
  }
  return limitations
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) as T }
  catch { return undefined }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  return stringValue(source[key])
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(source: Record<string, unknown>, key: string, output: string): Record<string, string> {
  const value = stringField(source, key)
  return value ? { [output]: value } : {}
}

function booleanField(source: Record<string, unknown>, key: string): boolean | 'invalid' | undefined {
  if (!Object.hasOwn(source, key)) return undefined
  const value = source[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  return 'invalid'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
