import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pluginAvailable } from './plugin-availability'
import { parseMarketplaceKey } from '../../shared/marketplace'
import type { MarketplaceItem } from '../../shared/marketplace'
import type {
  LocalPluginResult,
  PluginOperation,
  PluginRequest,
  PluginState,
} from '../../shared/plugins'
import { MarketplaceCatalogService, type MarketplaceProvider } from '../marketplace'
import { getDshRuntimeInfo } from '../dsh-runtime'
import { RUNTIME_SCHEMA_VERSION } from '../runtime-revision'
import { PluginManager, type PluginChange } from './plugin-manager'
import { validatePluginSpec } from './plugin-set'
import { redactPluginDiagnostic } from './plugin-diagnostics'

export const PLUGIN_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'

export class DshPluginCatalogProvider implements MarketplaceProvider {
  readonly kind = 'plugins' as const
  readonly source = 'dsh'
  constructor(private readonly url = PLUGIN_CATALOG_URL) {
    if (url !== PLUGIN_CATALOG_URL && !/^http:\/\/127\.0\.0\.1:\d+\/plugins\.json$/.test(url))
      throw new Error('Invalid catalog endpoint')
  }
  async load(): Promise<unknown> {
    const response = await fetch(this.url, {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    })
    if (!response.ok || !response.body) throw new Error('Plugin catalog unavailable')
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 16 * 1024 * 1024) throw new Error('Plugin catalog too large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!Array.isArray(payload.plugins) || payload.plugins.length > 10_000)
      throw new Error('Invalid plugin catalog')
    return payload.plugins.flatMap((row: Record<string, unknown>) => {
      if (!row || typeof row !== 'object') return []
      const packageName = typeof row.npm === 'string' ? row.npm : undefined
      const version = typeof row.version === 'string' ? row.version : undefined
      const repository =
        typeof row.url === 'string' &&
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(row.url)
          ? row.url
          : undefined
      const sourceId = packageName || repository
      if (!sourceId) return []
      const description =
        row.description && typeof row.description === 'object'
          ? (row.description as Record<string, unknown>)
          : {}
      const warnings = ['第三方代码；目录信息不代表安全认证。']
      if (Array.isArray(row.capabilities) && row.capabilities.length)
        warnings.push(
          `上游声明能力：${row.capabilities
            .slice(0, 8)
            .filter((value) => typeof value === 'string')
            .join('、')}`
        )
      return [
        {
          sourceId,
          name: row.name,
          description: description.zh || description.en || row.description,
          revision: version,
          plugin: { packageName, version, warnings },
        },
      ]
    })
  }
}

type CachedResult = LocalPluginResult & { context: string }
const terminal = new Set(['succeeded', 'failed', 'cancelled'])

/** Catalog input never becomes argv; every action goes through full-set staging. */
export class PluginMarketplaceService {
  private operation: PluginOperation | null = null
  private controller: AbortController | null = null
  private task: Promise<PluginOperation> | null = null
  private closing = false
  private preparation: Promise<void> | null = null
  private preparationSignature = ''
  private readonly preparationController = new AbortController()
  private readonly available = new Map<
    string,
    { version: string; context: string; allowed: boolean; checkedAt: number }
  >()
  private readonly results = new Map<string, CachedResult>()
  private readonly resultFile: string
  constructor(
    dataDir: string,
    private readonly catalog: MarketplaceCatalogService,
    private readonly manager: PluginManager,
    private readonly notify: (operation: PluginOperation) => void = () => {},
    private readonly runtimeVersion = getDshRuntimeInfo().version,
    private readonly registry = 'https://registry.npmjs.org/'
  ) {
    this.resultFile = join(dataDir, 'marketplace-cache', 'plugin-compatibility.json')
    try {
      const file = join(dataDir, 'marketplace-cache', 'plugin-availability.json')
      if (statSync(file).size <= 8 * 1024 * 1024) {
        const rows = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(rows) && rows.length <= 10_000)
          for (const row of rows) {
            const identity = parseMarketplaceKey(row.key)
            if (identity.kind !== 'plugins' || identity.source !== 'dsh') continue
            validatePluginSpec(identity.sourceId, row.version)
            if (
              typeof row.context === 'string' &&
              row.context.length <= 4096 &&
              typeof row.allowed === 'boolean' &&
              Number.isFinite(row.checkedAt) &&
              Date.now() >= row.checkedAt &&
              Date.now() - row.checkedAt < 15 * 60_000
            )
              this.available.set(row.key, {
                version: row.version,
                context: row.context,
                allowed: row.allowed,
                checkedAt: row.checkedAt,
              })
          }
      }
    } catch {
      /* Metadata cache affects discovery only, never installation authorization. */
    }
    try {
      if (statSync(this.resultFile).size > 4 * 1024 * 1024) return
      const cached: unknown = JSON.parse(readFileSync(this.resultFile, 'utf8'))
      if (!Array.isArray(cached) || cached.length > 500) return
      for (const row of cached) {
        if (
          !row ||
          typeof row.key !== 'string' ||
          typeof row.version !== 'string' ||
          typeof row.context !== 'string' ||
          !['unknown', 'compatible', 'incompatible', 'needs-approval'].includes(row.compatibility)
        )
          continue
        const identity = parseMarketplaceKey(row.key)
        if (identity.kind !== 'plugins' || identity.source !== 'dsh') continue
        validatePluginSpec(identity.sourceId, row.version)
        this.results.set(row.key, {
          key: row.key,
          version: row.version,
          context: row.context,
          compatibility: row.compatibility,
          diagnostics:
            typeof row.diagnostics === 'string'
              ? redactPluginDiagnostic(row.diagnostics).slice(-4096)
              : undefined,
        })
      }
    } catch {
      /* Invalid local compatibility data is never an install grant. */
    }
  }
  private context(): string {
    return JSON.stringify([
      this.runtimeVersion,
      RUNTIME_SCHEMA_VERSION,
      2,
      process.platform,
      process.arch,
      process.versions.node,
      this.manager.snapshot().revision,
    ])
  }
  state(): PluginState {
    const context = this.context()
    return {
      available: [...this.available]
        .filter(
          ([key, row]) =>
            row.allowed &&
            row.context === context &&
            Date.now() - row.checkedAt < 15 * 60_000 &&
            !(
              this.results.get(key)?.context === context &&
              this.results.get(key)?.version === row.version &&
              ['incompatible', 'needs-approval'].includes(this.results.get(key)!.compatibility)
            )
        )
        .map(([key, row]) => ({ key, version: row.version })),
      preparing: !!this.preparation,
      installed: this.manager
        .snapshot()
        .plugins.map(({ packageName, version, enabled, config }) => ({
          packageName,
          version,
          enabled,
          configuration: Object.keys(config).length ? 'configured' : 'default',
        })),
      results: [...this.results.values()]
        .filter((row) => row.context === context)
        .map(({ context: _context, ...row }) => row),
      operation: this.operation,
    }
  }
  async prepareCatalog(): Promise<void> {
    if (this.closing || this.preparation) return
    const catalog = await this.catalog.list('plugins'),
      context = this.context()
    if (this.closing || this.preparation) return
    const signature = JSON.stringify([catalog.fetchedAt, context])
    if (signature === this.preparationSignature) return
    this.preparationSignature = signature
    this.preparation = this.prepare(catalog.items, context)
      .catch(() => {})
      .finally(() => {
        try {
          const file = join(dirname(this.resultFile), 'plugin-availability.json')
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(
            `${file}.tmp`,
            JSON.stringify([...this.available].map(([key, row]) => ({ key, ...row })))
          )
          renameSync(`${file}.tmp`, file)
        } catch {
          /* Discovery remains usable without a writable cache. */
        }
        this.preparation = null
        this.notifyPreparation()
      })
  }
  private notifyPreparation(): void {
    try {
      this.notify({
        requestId: randomUUID(),
        key: '["plugins","dsh","catalog"]',
        action: 'check',
        phase: 'succeeded',
      })
    } catch {
      /* A closed renderer cannot interrupt catalog preparation. */
    }
  }
  private async prepare(items: MarketplaceItem[], context: string): Promise<void> {
    const pending = items.filter((item) => item.plugin?.packageName && item.plugin.version)
    let index = 0
    // Bound network concurrency; no plugin code or desired-state mutation runs here.
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (!this.closing && index < pending.length) {
          const item = pending[index++],
            version = item.plugin!.version!
          const cached = this.available.get(item.key)
          if (
            cached?.context === context &&
            cached.version === version &&
            Date.now() - cached.checkedAt < 15 * 60_000
          )
            continue
          const rejected = this.results.get(item.key)
          if (
            rejected?.context === context &&
            rejected.version === version &&
            ['incompatible', 'needs-approval'].includes(rejected.compatibility)
          )
            continue
          try {
            const allowed = await pluginAvailable(
              item.plugin!.packageName!,
              version,
              this.manager.snapshot().plugins,
              this.preparationController.signal,
              this.registry
            )
            this.available.set(item.key, { version, context, allowed, checkedAt: Date.now() })
            if (this.available.size > 10_000)
              this.available.delete(this.available.keys().next().value!)
          } catch {
            this.available.delete(item.key)
          }
          this.notifyPreparation()
        }
      })
    )
  }
  private report(operation: PluginOperation): void {
    this.operation = operation
    try {
      this.notify(operation)
    } catch {
      /* A closed renderer cannot invalidate a mutation. */
    }
  }
  private remember(result: CachedResult): void {
    this.results.delete(result.key)
    this.results.set(result.key, result)
    if (this.results.size > 500) this.results.delete(this.results.keys().next().value!)
    try {
      mkdirSync(dirname(this.resultFile), { recursive: true })
      writeFileSync(`${this.resultFile}.tmp`, JSON.stringify([...this.results.values()]))
      renameSync(`${this.resultFile}.tmp`, this.resultFile)
    } catch {
      /* A successful database commit is independent of a display cache. */
    }
  }
  change(input: unknown): Promise<PluginOperation> {
    if (this.closing || (this.operation && !terminal.has(this.operation.phase)))
      throw new Error('插件操作正在进行，请稍后重试。')
    const row = input as PluginRequest
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.requestId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(row.requestId) ||
      typeof row.key !== 'string' ||
      row.key.length > 2048 ||
      !['check', 'install', 'update', 'remove', 'enable', 'disable'].includes(row.action) ||
      (row.version !== undefined && (typeof row.version !== 'string' || row.version.length > 100))
    )
      throw new Error('插件操作参数无效。')
    const identity = parseMarketplaceKey(row.key)
    if (identity.kind !== 'plugins' || identity.source !== 'dsh') throw new Error('插件来源无效。')
    validatePluginSpec(identity.sourceId, row.version ?? '0.0.0')
    // Copy only the validated fields; callers cannot mutate an operation while it waits.
    const request: PluginRequest = {
      requestId: row.requestId,
      key: row.key,
      action: row.action,
      version: row.version,
    }
    this.controller = new AbortController()
    this.report({ ...request, phase: 'queued' })
    this.task = this.run(request, identity.sourceId, this.controller.signal)
    return this.task
  }
  private async run(
    request: PluginRequest,
    packageName: string,
    signal: AbortSignal
  ): Promise<PluginOperation> {
    let targetVersion = request.version
    const before = this.manager.snapshot(),
      context = this.context()
    try {
      const installed = before.plugins.find((plugin) => plugin.packageName === packageName)
      let change: PluginChange
      if (['check', 'install', 'update'].includes(request.action)) {
        const catalog = await this.catalog.list('plugins')
        const item = catalog.items.find((entry) => entry.key === request.key)
        if (
          !item?.plugin?.packageName ||
          item.plugin.packageName !== packageName ||
          item.plugin.version !== targetVersion
        )
          throw new Error('目录版本已改变，请刷新后重试。')
        if (
          request.action !== 'check' &&
          !(await pluginAvailable(
            packageName,
            targetVersion!,
            before.plugins,
            signal,
            this.registry
          ))
        )
          throw new Error('该插件当前无法安装。')
        change = {
          kind:
            request.action === 'check'
              ? installed
                ? 'update'
                : 'install'
              : (request.action as 'install' | 'update'),
          packageName,
          version: targetVersion!,
        }
      } else {
        if (!installed) throw new Error('插件未安装。')
        targetVersion = installed.version
        change = { kind: request.action as 'remove' | 'enable' | 'disable', packageName }
      }
      await this.manager.change(change, signal, {
        validateOnly: request.action === 'check',
        progress: (phase) => this.report({ ...request, phase }),
      })
      if (
        request.action === 'check' ||
        request.action === 'install' ||
        request.action === 'enable' ||
        (request.action === 'update' && installed?.enabled)
      ) {
        this.remember({
          key: request.key,
          version: targetVersion!,
          context: this.context(),
          compatibility: 'compatible',
        })
      }
      this.report({
        ...request,
        phase: 'succeeded',
        message:
          request.action === 'check'
            ? '本机兼容检查通过；安装时仍会重新验证完整集合。'
            : '插件操作完成。',
      })
    } catch (error) {
      const diagnostics = redactPluginDiagnostic(error).slice(-4096)
      const compatibility = /build script requires approval/i.test(diagnostics)
        ? 'needs-approval'
        : /network|fetch|ENOTFOUND|timed out|timeout|metadata unavailable|目录|版本已改变/i.test(
              diagnostics
            )
          ? 'unknown'
          : 'incompatible'
      if (
        !signal.aborted &&
        ['check', 'install', 'update'].includes(request.action) &&
        targetVersion
      ) {
        this.available.delete(request.key)
        this.remember({
          key: request.key,
          version: targetVersion,
          context,
          compatibility,
          diagnostics,
        })
      }
      this.report({
        ...request,
        phase: signal.aborted ? 'cancelled' : 'failed',
        message: signal.aborted
          ? '操作已取消，已安装集合保持不变。'
          : '插件操作失败，已安装集合保持不变。请查看诊断并重试。',
        diagnostics,
      })
    }
    return this.operation!
  }
  cancel(requestId: unknown): boolean {
    if (
      typeof requestId !== 'string' ||
      !this.operation ||
      this.operation.requestId !== requestId ||
      terminal.has(this.operation.phase)
    )
      return false
    this.controller?.abort()
    return true
  }
  async shutdown(): Promise<void> {
    this.closing = true
    this.preparationController.abort()
    this.controller?.abort()
    await this.task?.catch(() => {})
    await this.preparation
  }
}
