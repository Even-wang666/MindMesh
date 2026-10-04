import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../shared/contracts'
import { copySelectedSkillBundles, listSkillCatalog, resolveSelectedSkills } from './skills'

export const toolCatalog = [
  { id: 'web', name: '网页搜索', description: '检索公开网页资料。' },
  { id: 'files', name: '文件', description: '读取文件，并在设置中选择的工作目录内写入。' },
  { id: 'shell', name: 'Shell', description: '在本机执行受控命令。' },
  { id: 'browser', name: '浏览器', description: '打开网页、点击、填表、截图并抓取内容（Playwright）。' },
  { id: 'todo', name: '待办清单', description: '规划并跟踪多步任务。' },
  { id: 'goal', name: '目标管理', description: '在当前会话中维护长任务目标。' },
  { id: 'jobs', name: '后台任务', description: '在当前会话中查看和控制后台任务。' },
  { id: 'subagent', name: '子代理', description: '派生子代理并行处理独立子任务，并支持多子代理编排工作流。' },
]

export function prepareAgentCapabilities(agent: Agent, dataDirectory: string, dshHome: string): string {
  const selected = resolveSelectedSkills(agent.skills, dataDirectory)
  const selectedRoot = join(dshHome, 'selected-skills')
  copySelectedSkillBundles(selected, selectedRoot)

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
    // Plugin management and autonomous loop tools are outside MindMesh's tool catalog.
    disabled('tool-plugin-manager', true),
    disabled('tool-ralph', true),
    disabled('tool-skill', selected.length === 0),
    disabled('tool-fs', !tools.has('文件')),
    disabled('tool-fs-search', !tools.has('文件')),
    disabled('tool-bash', process.platform === 'win32' || !tools.has('Shell')),
    disabled('tool-pwsh', process.platform !== 'win32' || !tools.has('Shell')),
    disabled('tool-web', !tools.has('网页搜索')),
    disabled('tool-todo', !tools.has('待办清单')),
    disabled('tool-goal', !tools.has('目标管理')),
    disabled('tool-jobs', !tools.has('后台任务')),
    ...['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
      'tool-subagent-fork', 'tool-workflow'].map((id) => disabled(id, !tools.has('子代理'))),
  ]
  if (tools.has('浏览器')) patch.push(buildPlaywrightMcpInsert())
  const patchPath = join(dshHome, 'capabilities.cordis.patch.yml')
  writeFileSync(patchPath, patch.join('\n'))
  return patchPath
}

function buildPlaywrightMcpInsert(): string {
  const cli = playwrightCliPath()
  if (!cli) throw new Error('浏览器工具未安装，请重新安装 MindMesh')
  if (!playwrightBrowserAvailable()) throw new Error(process.platform === 'win32'
    ? '未检测到可用的 Microsoft Edge 浏览器'
    : '当前平台尚未配置 Playwright Chromium 浏览器')
  const args = [cli, '--headless', ...(process.platform === 'win32' ? ['--browser', 'msedge'] : [])]
  return [
    '- insert:',
    '    - id: mindmesh-browser',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: stdio',
    '        serverName: browser',
    '        command: !!js process.execPath',
    `        args: [${args.map((value) => JSON.stringify(value)).join(', ')}]`,
    '        cwd: !!js process.cwd()',
    '        toolCallTimeoutMs: 120000',
    '        failOnStartupError: true',
  ].join('\n')
}

export function playwrightCliPath(): string {
  const packaged = Boolean(process.resourcesPath
    && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp)
  const path = packaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@playwright', 'mcp', 'cli.js')
    : join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js')
  return existsSync(path) ? path : ''
}

export function playwrightBrowserAvailable(): boolean {
  if (!playwrightCliPath()) return false
  if (process.platform !== 'win32') return false
  return [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root))
    .some((root) => existsSync(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))
}
