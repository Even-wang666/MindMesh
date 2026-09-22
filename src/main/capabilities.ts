import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../shared/contracts'

const builtInSkills = [
  { id: 'research', name: '研究分析', description: '整理资料、比较证据并形成结构化结论。', body: '先明确问题和证据范围；区分事实、推断和未知；给出可核查的来源与结论。' },
  { id: 'report', name: '报告撰写', description: '将分析结果组织为清晰的专业报告。', body: '先明确读者、目的和结论；用标题组织依据、限制与建议；保持简洁，避免没有证据的断言。' },
  { id: 'review', name: '代码审查', description: '检查代码质量、风险和可维护性。', body: '先定位具体变更与预期行为；优先报告可复现的正确性问题、安全风险和缺失的关键验证，并给出文件位置。' },
]

export const toolCatalog = [
  { id: 'web', name: '网页搜索', description: '检索公开网页资料。' },
  { id: 'files', name: '文件', description: '读取文件，并在设置中选择的工作目录内写入。' },
  { id: 'shell', name: 'Shell', description: '在本机执行受控命令。' },
]

type SkillItem = { id: string; name: string; description: string; path: string }

export function listSkillCatalog(dataDirectory: string): SkillItem[] {
  const root = join(dataDirectory, 'skills')
  mkdirSync(root, { recursive: true })
  for (const skill of builtInSkills) {
    const directory = join(root, skill.id)
    const path = join(directory, 'SKILL.md')
    if (existsSync(path)) continue
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`)
  }
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const path = join(root, entry.name, 'SKILL.md')
    if (!existsSync(path)) return []
    const source = readFileSync(path, 'utf8')
    if (source.length > 65_536) return []
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1]
    const name = /^name:\s*(.+)$/m.exec(header ?? '')?.[1]?.trim()
    const description = /^description:\s*(.+)$/m.exec(header ?? '')?.[1]?.trim()
    return name && description ? [{ id: entry.name, name, description, path }] : []
  })
}

export function prepareAgentCapabilities(agent: Agent, dataDirectory: string, dshHome: string): string {
  const catalog = listSkillCatalog(dataDirectory)
  const selected = agent.skills.map((name) => {
    const skill = catalog.find((item) => item.name === name)
    if (!skill) throw new Error(`技能「${name}」未安装`)
    return skill
  })
  const selectedRoot = join(dshHome, 'selected-skills')
  mkdirSync(selectedRoot, { recursive: true })
  for (const skill of selected) writeFileSync(join(selectedRoot, `${skill.id}.md`), readFileSync(skill.path))

  const unknownTools = agent.tools.filter((name) => !toolCatalog.some((item) => item.name === name))
  if (unknownTools.length) throw new Error(`工具「${unknownTools[0]}」不可用`)
  const tools = new Set(agent.tools)
  const disabled = (id: string, value: boolean) => `- id: ${id}\n  disabled: ${value}\n`
  const patch = [
    '- id: skill-filesystem',
    '  config:',
    '    includeDefaultRoots: false',
    '    customSkillDirs:',
    `      - ${JSON.stringify(selectedRoot)}`,
    '    watch: false',
    disabled('tool-skill', selected.length === 0),
    disabled('tool-fs', !tools.has('文件')),
    disabled('tool-fs-search', !tools.has('文件')),
    disabled('tool-bash', process.platform === 'win32' || !tools.has('Shell')),
    disabled('tool-pwsh', process.platform !== 'win32' || !tools.has('Shell')),
    disabled('tool-web', !tools.has('网页搜索')),
    ...['tool-jobs', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
      'tool-subagent-fork', 'tool-workflow', 'tool-todo', 'tool-goal'].map((id) => disabled(id, true)),
  ].join('\n')
  const patchPath = join(dshHome, 'capabilities.cordis.patch.yml')
  writeFileSync(patchPath, patch)
  return patchPath
}
