const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

// Fail closed even when electron-builder is invoked directly instead of package:win.
module.exports = async ({ packager, electronVersion }) => {
  const project = packager.projectDir
  const root = join(project, '.runtime', 'verified-plugins')
  if (!existsSync(join(root, 'catalog.json')))
    throw new Error('Run pnpm prepare:plugins before packaging')
  const bundle = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  const candidates = JSON.parse(
    readFileSync(join(project, 'resources/plugins/candidates.json'), 'utf8')
  )
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  if (
    bundle.schema !== 1 ||
    bundle.platform !== 'win32' ||
    bundle.arch !== process.arch ||
    bundle.electronVersion !== (electronVersion ?? manifest.devDependencies.electron) ||
    bundle.runtimeVersion !== manifest.dependencies['@deepseek-ai/dsh'] ||
    bundle.plugins.length !== candidates.length ||
    !bundle.plugins.length
  )
    throw new Error('Verified plugin release context is stale; run pnpm prepare:plugins')
  for (const candidate of candidates)
    if (
      !bundle.plugins.some(
        (plugin) =>
          plugin.packageName === candidate.packageName &&
          plugin.version === candidate.version &&
          plugin.integrity === candidate.integrity
      )
    )
      throw new Error('Unvalidated plugin candidate change')
  for (let mask = 1; mask < 2 ** candidates.length; mask++) {
    const names = candidates
      .filter((_, i) => mask & (1 << i))
      .map((p) => p.packageName)
      .sort()
    if (
      !bundle.checkedSets.some((set) => JSON.stringify([...set].sort()) === JSON.stringify(names))
    )
      throw new Error('Missing complete-set plugin release validation')
  }
  for (const name of ['store', 'cache', 'licenses'])
    if (!existsSync(join(root, name))) throw new Error(`Missing offline plugin payload: ${name}`)
}
