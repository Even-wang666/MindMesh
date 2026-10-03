import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshDirectDependencies, inspectRuntimeDependencies, resolvePackageManifest, valid } from './runtime-dependencies.mjs'

const root = resolve(import.meta.dirname, '..')
const projectPath = join(root, 'package.json')
const project = JSON.parse(readFileSync(projectPath, 'utf8'))
const direct = dshDirectDependencies(project)
const roots = []
const rows = []
const errors = []
for (const [name, requested] of direct) {
  if (!valid(requested)) errors.push(`${name}: direct version must be exact (${requested})`)
  const path = resolvePackageManifest(name, projectPath)
  if (!path) { errors.push(`${name}: not installed`); continue }
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.version !== requested) errors.push(`${name}: requested ${requested}, installed ${manifest.version}`)
  roots.push(path)
  rows.push(`| ${name} | ${requested} | ${manifest.version} | ${Object.entries(manifest.peerDependencies ?? {}).map(([peer, range]) => `${peer}: ${range}`).join('<br>') || '—'} |`)
}
const graph = inspectRuntimeDependencies(roots)
errors.push(...graph.errors)
console.log(`DSH/Cordis direct dependencies: ${direct.length}; runtime instances: ${graph.packages.size}; required failures: ${errors.length}`)
errors.forEach((error) => console.error(error))
if (errors.length) process.exitCode = 1
else if (process.argv.includes('--write')) {
  const runtime = [...new Set([...graph.packages.values()].filter((p) => p.name.startsWith('@deepseek-ai/')).map((p) => `${p.name}@${p.version}`))].sort()
  writeFileSync(join(root, 'docs', 'dsh-version-matrix.md'), [
    '# DSH 兼容版本矩阵', '',
    '生成命令：`corepack pnpm@11.7.0 check:dsh-deps --write`。数据来自实际安装发行包的 package.json（包含发布版本及 peer 要求），不使用 latest 标签。', '',
    `Direct: ${direct.length}；传递运行实例: ${graph.packages.size}；required dependency/peer 校验失败: 0。`, '',
    '校验所有 direct exact version，并分别遍历实际解析出的传递 dependencies/peerDependencies；本机缺失的 optional dependency/peer 单独记录。Windows 打包闭包另由 `check:package-deps` 验证，禁止回退到工作区 node_modules，并要求本机已安装的 optional 运行依赖（含平台 native payload）随包分发。', '',
    '| 包 | Requested | Installed | Published peerDependencies |', '| --- | --- | --- | --- |', ...rows, '',
    '## 实际解析的 DSH/Cordis 运行闭包', '', ...runtime.map((entry) => `- \`${entry}\``), '',
    '## 本机缺失的可选依赖', '', ...graph.optionalMissing.map((entry) => `- \`${entry}\``), '',
  ].join('\n'))
}
