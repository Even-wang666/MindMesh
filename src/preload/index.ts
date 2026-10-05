import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatDelta,
  ChatProgress,
  MindMeshApi,
  SkillInstallProgress,
} from '../shared/contracts'
import { validateChatContent } from '../shared/chat-content'
import type { PluginOperation } from '../shared/plugins'

const api: MindMeshApi = {
  plugins: {
    state: () => ipcRenderer.invoke('plugins:state'),
    change: (request) => ipcRenderer.invoke('plugins:change', request),
    importGitHub: (request) => ipcRenderer.invoke('plugins:importGitHub', request),
    cancel: (requestId) => ipcRenderer.invoke('plugins:cancel', requestId),
    onProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PluginOperation): void =>
        listener(payload)
      ipcRenderer.on('plugins:progress', handler)
      return () => ipcRenderer.removeListener('plugins:progress', handler)
    },
  },
  marketplace: {
    list: (kind, refresh = false) => ipcRenderer.invoke('marketplace:list', kind, refresh),
    installAgent: (key, revision) => ipcRenderer.invoke('marketplace:installAgent', key, revision),
    installTeam: (key, revision) => ipcRenderer.invoke('marketplace:installTeam', key, revision),
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    create: (input) => ipcRenderer.invoke('agents:create', input),
    update: (id, input) => ipcRenderer.invoke('agents:update', id, input),
    remove: (id) => ipcRenderer.invoke('agents:remove', id),
  },
  spaces: {
    list: () => ipcRenderer.invoke('spaces:list'),
    create: (input) => ipcRenderer.invoke('spaces:create', input),
    update: (id, input) => ipcRenderer.invoke('spaces:update', id, input),
    remove: (id) => ipcRenderer.invoke('spaces:remove', id),
    updateContext: (id, context) => ipcRenderer.invoke('spaces:updateContext', id, context),
  },
  chat: {
    messages: (scope, scopeId) => ipcRenderer.invoke('chat:messages', scope, scopeId),
    sendPrivate: (agentId, content, attachments, options) => {
      validateChatContent(content)
      return ipcRenderer.invoke('chat:sendPrivate', agentId, content, attachments, options)
    },
    sendSpace: (spaceId, content, attachments, options) => {
      validateChatContent(content)
      return ipcRenderer.invoke('chat:sendSpace', spaceId, content, attachments, options)
    },
    stop: (scope, scopeId) => ipcRenderer.invoke('chat:stop', scope, scopeId),
    onDelta: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatDelta): void =>
        listener(payload)
      ipcRenderer.on('chat:delta', handler)
      return () => ipcRenderer.removeListener('chat:delta', handler)
    },
    onProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatProgress): void =>
        listener(payload)
      ipcRenderer.on('chat:progress', handler)
      return () => ipcRenderer.removeListener('chat:progress', handler)
    },
  },
  catalog: {
    skills: () => ipcRenderer.invoke('catalog:skills'),
    pickSkillDir: () => ipcRenderer.invoke('catalog:pickSkillDir'),
    installSkill: (path) => ipcRenderer.invoke('catalog:installSkill', path),
    installSkillFromGitHub: (url) => ipcRenderer.invoke('catalog:installSkillFromGitHub', url),
    onInstallProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SkillInstallProgress): void =>
        listener(payload)
      ipcRenderer.on('catalog:installProgress', handler)
      return () => ipcRenderer.removeListener('catalog:installProgress', handler)
    },
    tools: () => ipcRenderer.invoke('catalog:tools'),
    models: () => ipcRenderer.invoke('catalog:models'),
  },
  runtime: {
    status: () => ipcRenderer.invoke('runtime:status'),
  },
  settings: {
    workspace: () => ipcRenderer.invoke('settings:workspace'),
    pickWorkspace: () => ipcRenderer.invoke('settings:pickWorkspace'),
    chooseWorkspace: (path) => ipcRenderer.invoke('settings:chooseWorkspace', path),
    profile: () => ipcRenderer.invoke('settings:profile'),
    saveProfile: (profile) => ipcRenderer.invoke('settings:saveProfile', profile),
    modelProviders: () => ipcRenderer.invoke('settings:modelProviders'),
    saveModelProvider: (input) => ipcRenderer.invoke('settings:saveModelProvider', input),
    removeModelProvider: (id) => ipcRenderer.invoke('settings:removeModelProvider', id),
  },
}

contextBridge.exposeInMainWorld('mindmesh', api)
