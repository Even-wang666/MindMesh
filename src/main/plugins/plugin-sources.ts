import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { create } from 'tar'
import { withGitHubSkillBundle } from '../skill-github'
import { validatePluginSpec, type InstalledPlugin } from './plugin-set'
import { pluginMetadataError } from './plugin-availability'

function sourceDirectory(dataDirectory: string, packageName: string, version: string): string {
  validatePluginSpec(packageName, version)
  return join(
    dataDirectory,
    'plugin-sources',
    createHash('sha256')
      .update(JSON.stringify([packageName, version]))
      .digest('hex')
  )
}

export function pluginSourceArchive(
  dataDirectory: string,
  packageName: string,
  version: string
): string | undefined {
  const directory = sourceDirectory(dataDirectory, packageName, version)
  const file = join(directory, 'package.tgz')
  if (!existsSync(file)) return undefined
  if (statSync(file).size > 32 * 1024 * 1024) throw new Error('GitHub 插件归档过大')
  const receipt = JSON.parse(readFileSync(join(directory, 'source.json'), 'utf8'))
  if (
    receipt.packageName !== packageName ||
    receipt.version !== version ||
    receipt.integrity !==
      `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
  )
    throw new Error('GitHub 插件归档已改变，请重新导入。')
  return file
}

/** Archive the exact requested commit; neither npm package names nor branch tips replace its code. */
export async function prepareGitHubPlugin(
  url: string,
  dataDirectory: string,
  installed: readonly InstalledPlugin[],
  signal: AbortSignal
): Promise<{ packageName: string; version: string }> {
  return withGitHubSkillBundle(
    url,
    undefined,
    async (source, receipt) => {
      const file = join(source, 'package.json')
      if (!existsSync(file) || statSync(file).size > 1024 * 1024)
        throw new Error('GitHub 目录缺少有效的 package.json，请选择插件所在目录。')
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      validatePluginSpec(manifest.name, manifest.version)
      if (
        ['preinstall', 'install', 'postinstall', 'prepare'].some((name) => manifest.scripts?.[name])
      )
        throw new Error('插件依赖安装或构建脚本，当前不支持自动执行，请提供已构建的插件。')
      const incompatible = pluginMetadataError(manifest, manifest.name, manifest.version, installed)
      if (incompatible) throw new Error(incompatible)
      const entry =
        manifest.main ??
        (typeof manifest.exports === 'string'
          ? manifest.exports
          : typeof manifest.exports?.['.'] === 'string'
            ? manifest.exports['.']
            : manifest.exports
              ? undefined
              : 'index.js')
      const paths = [['DSH bundle', manifest.dsh.bundle.patch]]
      if (entry !== undefined) paths.push(['入口文件', entry])
      for (const [name, value] of paths) {
        if (typeof value !== 'string' || isAbsolute(value))
          throw new Error(`插件 ${name} 路径无效。`)
        const path = resolve(source, value)
        const delta = relative(source, path)
        if (delta.startsWith('..') || isAbsolute(delta))
          throw new Error(`插件 ${name} 不能指向目录外部。`)
        if (!existsSync(path) || !statSync(path).isFile())
          throw new Error(`插件缺少 ${name}：${value}。请使用包含构建产物的仓库或目录。`)
      }
      // The commit suffix prevents equal upstream version numbers from replacing different source code.
      const location = createHash('sha256')
        .update(JSON.stringify([receipt.repository, receipt.path]))
        .digest('hex')
        .slice(0, 12)
      const version = `${manifest.version.split('+')[0]}+github.${receipt.commit}.${location}`
      validatePluginSpec(manifest.name, version)
      const directory = sourceDirectory(dataDirectory, manifest.name, version)
      if (!pluginSourceArchive(dataDirectory, manifest.name, version)) {
        mkdirSync(directory, { recursive: true })
        writeFileSync(file, JSON.stringify({ ...manifest, version }))
        const archive = join(directory, 'package.pending.tgz')
        await create({ file: archive, gzip: true, cwd: source, prefix: 'package' }, ['.'])
        signal.throwIfAborted()
        writeFileSync(
          join(directory, 'source.json'),
          JSON.stringify({
            ...receipt,
            packageName: manifest.name,
            version,
            declaredVersion: manifest.version,
            integrity: `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`,
          })
        )
        renameSync(archive, join(directory, 'package.tgz'))
      }
      return { packageName: manifest.name, version }
    },
    signal
  )
}
