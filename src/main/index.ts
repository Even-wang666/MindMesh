import { join } from 'node:path'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { MindMeshDatabase } from './database'
import { DeepSeekHarnessAdapter } from './harness-adapter'
import { ModelProviderSettings } from './model-provider-settings'
import { MindMeshServices } from './services'
import { listSkillCatalog, toolCatalog } from './capabilities'
import { appendRuntimeError } from './runtime-errors'
import { installNavigationGuards } from './navigation'

let mainWindow: BrowserWindow | null = null
let services: MindMeshServices | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    /* 最小窗口尺寸 = 三栏比例（导航 17.5% / 列表 22% / 内容 60.5%）能站住的下限。
       最窄的一栏是导航（占总宽 17.5%）：1200 时约 210px，扣掉两侧 16px 内距
       还剩约 178px，正好容下「36px 品牌标 + 字标」和「28px 图标 + 12px 间距 +
       四字标签（协作空间）」两种最长内容。再小（如 1100）三栏结构不崩，
       但导航栏开始出现文字贴边。
       ⚠️ 下调这个值之前，先看 styles.css 响应式段末尾记的两条：< 1200 的
          三栏可用性、以及折叠态那两条兄弟选择器是否仍然成立。
       ⚠️ 它同时是「响应式分区」退场的依据：窗口不可能窄到需要降级，
          所以三栏比例在所有可达尺寸下都是同一套默认值（styles.css 的
          --nav-share / --list-share）。 */
    minWidth: 1200,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F7F8F6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  installNavigationGuards(mainWindow.webContents)
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(current: MindMeshServices, dataDir: string): void {
  ipcMain.handle('agents:list', () => current.listAgents())
  ipcMain.handle('agents:create', (_event, input) => current.createAgent(input))
  ipcMain.handle('agents:update', (_event, id, input) => current.updateAgent(id, input))
  ipcMain.handle('agents:remove', (_event, id) => current.removeAgent(id))
  ipcMain.handle('spaces:list', () => current.listSpaces())
  ipcMain.handle('spaces:create', (_event, input) => current.createSpace(input))
  ipcMain.handle('spaces:update', (_event, id, input) => current.updateSpace(id, input))
  ipcMain.handle('spaces:remove', (_event, id) => current.removeSpace(id))
  ipcMain.handle('spaces:updateContext', (_event, id, context) => current.updateSpaceContext(id, context))
  ipcMain.handle('chat:messages', (_event, scope, scopeId) => current.messages(scope, scopeId))
  ipcMain.handle('chat:sendPrivate', (_event, agentId, content) => current.sendPrivate(agentId, content))
  ipcMain.handle('chat:sendSpace', (_event, spaceId, content) => current.sendSpace(spaceId, content))
  ipcMain.handle('runtime:status', () => current.runtimeStatus())
  ipcMain.handle('settings:modelProviders', () => current.modelProviders())
  ipcMain.handle('settings:workspace', () => current.harness.workspacePath)
  ipcMain.handle('settings:chooseWorkspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return current.harness.workspacePath
    const path = realpathSync(result.filePaths[0])
    if (!statSync(path).isDirectory()) throw new Error('请选择文件夹')
    if (path === current.harness.workspacePath) return path
    await current.changeWorkspace(path)
    return path
  })
  ipcMain.handle('settings:profile', () => current.userProfile())
  ipcMain.handle('settings:saveProfile', (_event, profile) => current.saveUserProfile(profile))
  ipcMain.handle('settings:saveModelProvider', (_event, input) => current.saveModelProvider(input))
  ipcMain.handle('settings:removeModelProvider', (_event, id) => current.removeModelProvider(id))
  ipcMain.handle('catalog:models', () => current.models())
  ipcMain.handle('catalog:skills', () => listSkillCatalog(dataDir).map(({ id, name, description }) =>
    ({ id, name, description, status: '已安装' })))
  ipcMain.handle('catalog:tools', () => toolCatalog.map((tool) => ({
    ...tool, status: tool.id === 'web' && !current.modelProviders().some((provider) => provider.id === 'deepseek-official' && provider.configured)
      ? '需要配置' : '可用',
  })))
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.mindmesh.desktop')
  const dataDir = join(app.getPath('userData'), 'mindmesh-data')
  const db = new MindMeshDatabase(join(dataDir, 'mindmesh.sqlite'))
  const providerSettings = new ModelProviderSettings(join(dataDir, 'model-services.json'))
  const savedWorkspace = db.getWorkspacePath()
  const defaultWorkspace = app.isPackaged ? join(dataDir, 'workspace') : process.cwd()
  if (app.isPackaged) mkdirSync(defaultWorkspace, { recursive: true })
  const workspace = savedWorkspace && existsSync(savedWorkspace) && statSync(savedWorkspace).isDirectory()
    ? savedWorkspace : defaultWorkspace
  const harness = new DeepSeekHarnessAdapter(workspace, dataDir, providerSettings)
  try { harness.cleanupUnusedHomes(db.referencedCapabilityHashes()) }
  catch { /* Cache cleanup must not prevent the app from starting. */ }
  services = new MindMeshServices(db, harness, providerSettings, () => mainWindow?.webContents,
    (scope, agentId, error) => appendRuntimeError(join(dataDir, 'runtime-errors.jsonl'), scope, agentId, error))
  registerIpc(services, dataDir)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void services?.harness.shutdownAll()
  services?.db.close()
})
