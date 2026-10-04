import { spawn, execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { redactPluginDiagnostic } from './plugin-diagnostics'

export class BundledPackageManager {
  readonly cli: string
  readonly resolutionProbe: string
  constructor(resourcesPath = process.resourcesPath) {
    const packaged =
      resourcesPath && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp
    const manifestPath = packaged
      ? join(resourcesPath, 'package-manager', 'pnpm', 'package.json')
      : join(process.cwd(), 'node_modules', 'pnpm', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.name !== 'pnpm' || manifest.version !== '11.7.0')
      throw new Error('Bundled pnpm version mismatch (expected 11.7.0)')
    this.cli = join(dirname(manifestPath), 'bin', 'pnpm.mjs')
    this.resolutionProbe = packaged
      ? join(resourcesPath, 'plugin-resolution-probe.mjs')
      : join(process.cwd(), 'scripts', 'plugin-resolution-probe.mjs')
    if (!existsSync(this.cli)) throw new Error('Bundled pnpm CLI missing')
  }
}

export function stagingEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // Whitelist OS process prerequisites only; no inherited credentials, NODE_OPTIONS or npm config.
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG'])
    if (process.env[key]) env[key] = process.env[key]
  return {
    ...env,
    PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'appdata'),
    LOCALAPPDATA: join(home, 'localappdata'),
    TMP: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    TMPDIR: join(home, 'tmp'),
    DSH_HOME: home,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_TELEMETRY_DISABLED: '1',
    CI: '1',
    DEEPSEEK_API_KEY: 'mindmesh-staging-placeholder',
    npm_config_ignore_scripts: 'true',
    npm_config_manage_package_manager_versions: 'false',
    npm_config_registry: 'https://registry.npmjs.org/',
  }
}

export type CliRun = {
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  log: string
  signal?: AbortSignal
  timeoutMs?: number
  initialize?: boolean
}

/** Owns process lifetime, output bounds and protocol framing. Never invokes a shell. */
export class DshCliRunner {
  constructor(
    readonly dshBin: string,
    readonly packageManager: BundledPackageManager
  ) {}

  async run(options: CliRun): Promise<string> {
    options.signal?.throwIfAborted()
    mkdirSync(dirname(options.log), { recursive: true })
    try {
      appendFileSync(options.log, '')
    } catch (error) {
      throw new Error('Plugin diagnostic log write failed', { cause: error })
    }
    const secrets = Object.entries(options.env).flatMap(([name, value]) =>
      /key|token|secret|password/i.test(name) && value ? [value] : []
    )
    const redact = (value: unknown): string => redactPluginDiagnostic(value, secrets)
    const launcher = join(dirname(options.log), 'dsh-launch.mjs')
    writeFileSync(
      launcher,
      `import { runCli } from ${JSON.stringify(pathToFileURL(this.dshBin).href)};\nprocess.argv = [process.execPath, ${JSON.stringify(this.dshBin)}, ...process.argv.slice(2)];\nawait runCli({packageManager:{command:process.execPath,args:[${JSON.stringify(this.packageManager.cli)}],env:process.env}});\n`
    )
    return new Promise((resolve, reject) => {
      const args =
        options.args[0] === '--mindmesh-resolution'
          ? [this.packageManager.resolutionProbe, this.dshBin, ...options.args.slice(1)]
          : options.args[0] === '--mindmesh-pnpm'
            ? [this.packageManager.cli, ...options.args.slice(1)]
            : [launcher, ...options.args]
      const child = spawn(process.execPath, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = '',
        stderr = '',
        lineBuffer = '',
        initialized = false,
        failure: Error | null = null
      let bytes = 0
      // Keep stdout/stderr separate until close: credentials may span arbitrary chunks.
      // The existing shared output limit bounds these buffers to 4 MiB in total.
      const stdoutLog: Buffer[] = [],
        stderrLog: Buffer[] = []
      let termination: Promise<void> = Promise.resolve()
      const stop = (error: Error): void => {
        if (failure) return
        failure = error
        if (child.pid && process.platform === 'win32')
          termination = new Promise((done) =>
            execFile(
              join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
              ['/PID', String(child.pid!), '/T', '/F'],
              { windowsHide: true },
              () => done()
            )
          )
        else child.kill('SIGKILL')
      }
      const abort = (): void => stop(new Error('Plugin staging cancelled'))
      const timer = setTimeout(
        () => stop(new Error('Plugin staging timed out')),
        options.timeoutMs ?? 120_000
      )
      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (buffer: Buffer) => {
        const chunk = buffer.toString('utf8')
        bytes += buffer.length
        if (bytes > 4 * 1024 * 1024) {
          stop(new Error('Plugin output limit exceeded'))
          return
        }
        stdoutLog.push(buffer)
        if (output.length < 512 * 1024) output += chunk
        if (!options.initialize) return
        lineBuffer += chunk
        let newline: number
        while ((newline = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, newline).trim()
          lineBuffer = lineBuffer.slice(newline + 1)
          if (!line) continue
          try {
            const frame = JSON.parse(line)
            if (
              !frame ||
              frame.jsonrpc !== '2.0' ||
              !(
                typeof frame.method === 'string' ||
                ('id' in frame && ('result' in frame || 'error' in frame))
              )
            )
              throw new Error('Malformed JSON-RPC frame')
            if (frame.id === 'mindmesh-staging') {
              if (frame.error)
                stop(new Error(`SDK initialize failed: ${redact(JSON.stringify(frame.error))}`))
              else {
                initialized = true
                child.stdin.end()
              }
            }
          } catch {
            stop(new Error('Plugin polluted SDK stdout'))
          }
        }
      })
      child.stderr.on('data', (buffer: Buffer) => {
        bytes += buffer.length
        if (bytes > 4 * 1024 * 1024) {
          stop(new Error('Plugin output limit exceeded'))
          return
        }
        stderrLog.push(buffer)
        stderr += buffer.toString('utf8')
      })
      child.on('error', (error) => {
        failure = error
      })
      child.stdin.on('error', () => {})
      child.on('close', async (code) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        await termination
        try {
          appendFileSync(
            options.log,
            redact(Buffer.concat(stdoutLog).toString('utf8')) +
              redact(Buffer.concat(stderrLog).toString('utf8'))
          )
        } catch (error) {
          reject(new Error('Plugin diagnostic log write failed', { cause: error }))
          return
        }
        if (failure) reject(new Error(redact(failure.message), { cause: failure }))
        else if (code !== 0)
          reject(
            new Error(
              `DSH exited ${code}: ${redact(stderr).slice(-16_384)}\n${redact(output).slice(-4096)}`
            )
          )
        else if (options.initialize && (!initialized || lineBuffer.trim()))
          reject(new Error('SDK initialize incomplete or stdout polluted'))
        else if (
          /inactive|did not activate|skipped bundle|installation rejected|Ignored build scripts|ERR_PNPM_IGNORED_BUILDS/i.test(
            stderr + output
          )
        )
          reject(
            new Error(`Plugin compatibility validation failed: ${redact(stderr).slice(-4096)}`)
          )
        else resolve(output)
      })
      if (options.initialize)
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'mindmesh-staging',
            method: 'initialize',
            params: { cwd: options.cwd, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          }) + '\n'
        )
      else child.stdin.end()
      if (options.signal?.aborted) abort()
    })
  }
}
