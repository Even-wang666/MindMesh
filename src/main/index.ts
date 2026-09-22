import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { MindMeshDatabase } from './database'
import { DeepSeekHarnessAdapter } from './harness-adapter'
import { ModelProviderSettings } from './model-provider-settings'
import { MindMeshServices } from './services'

let mainWindow: BrowserWindow | null = null
let services: MindMeshServices | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(current: MindMeshServices): void {
  ipcMain.handle('agents:list', () => current.listAgents())
  ipcMain.handle('agents:create', (_event, input) => current.createAgent(input))
  ipcMain.handle('agents:update', (_event, id, input) => current.updateAgent(id, input))
  ipcMain.handle('agents:remove', (_event, id) => current.removeAgent(id))
  ipcMain.handle('spaces:list', () => current.listSpaces())
  ipcMain.handle('spaces:create', (_event, input) => current.createSpace(input))
  ipcMain.handle('spaces:updateContext', (_event, id, context) => current.updateSpaceContext(id, context))
  ipcMain.handle('chat:messages', (_event, scope, scopeId) => current.messages(scope, scopeId))
  ipcMain.handle('chat:sendPrivate', (_event, agentId, content) => current.sendPrivate(agentId, content))
  ipcMain.handle('chat:sendSpace', (_event, spaceId, content) => current.sendSpace(spaceId, content))
  ipcMain.handle('runtime:status', () => current.harness.status())
  ipcMain.handle('settings:modelProviders', () => current.modelProviders())
  ipcMain.handle('settings:profile', () => current.userProfile())
  ipcMain.handle('settings:saveProfile', (_event, profile) => current.saveUserProfile(profile))
  ipcMain.handle('settings:saveModelProvider', (_event, input) => current.saveModelProvider(input))
  ipcMain.handle('settings:removeModelProvider', (_event, id) => current.removeModelProvider(id))
  ipcMain.handle('catalog:models', () => current.models())
  ipcMain.handle('catalog:skills', () => [
    { id: 'research', name: '研究分析', description: '整理资料、比较证据并形成结构化结论。', status: '已安装' },
    { id: 'report', name: '报告撰写', description: '将分析结果组织为清晰的专业报告。', status: '已安装' },
    { id: 'review', name: '代码审查', description: '检查代码质量、风险和可维护性。', status: '已安装' },
  ])
  ipcMain.handle('catalog:tools', () => [
    { id: 'files', name: '文件', description: '读取和管理工作区文件。', status: '可用' },
    { id: 'shell', name: 'Shell', description: '在本机执行受控命令。', status: '可用' },
    { id: 'web', name: '网页搜索', description: '检索公开网页资料。', status: '需要配置' },
  ])
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.mindmesh.desktop')
  const dataDir = join(app.getPath('userData'), 'mindmesh-data')
  const db = new MindMeshDatabase(join(dataDir, 'mindmesh.sqlite'))
  const providerSettings = new ModelProviderSettings(join(dataDir, 'model-services.json'))
  const harness = new DeepSeekHarnessAdapter(process.cwd(), dataDir, providerSettings)
  services = new MindMeshServices(db, harness, providerSettings, () => mainWindow?.webContents)
  registerIpc(services)
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
