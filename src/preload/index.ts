import { contextBridge, ipcRenderer } from 'electron'
import type { ChatDelta, MindMeshApi } from '../shared/contracts'

const api: MindMeshApi = {
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    create: (input) => ipcRenderer.invoke('agents:create', input),
    remove: (id) => ipcRenderer.invoke('agents:remove', id),
  },
  spaces: {
    list: () => ipcRenderer.invoke('spaces:list'),
    create: (input) => ipcRenderer.invoke('spaces:create', input),
  },
  chat: {
    messages: (scope, scopeId) => ipcRenderer.invoke('chat:messages', scope, scopeId),
    sendPrivate: (agentId, content) => ipcRenderer.invoke('chat:sendPrivate', agentId, content),
    sendSpace: (spaceId, content) => ipcRenderer.invoke('chat:sendSpace', spaceId, content),
    onDelta: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatDelta): void => listener(payload)
      ipcRenderer.on('chat:delta', handler)
      return () => ipcRenderer.removeListener('chat:delta', handler)
    },
  },
  catalog: {
    skills: () => ipcRenderer.invoke('catalog:skills'),
    tools: () => ipcRenderer.invoke('catalog:tools'),
    models: () => ipcRenderer.invoke('catalog:models'),
  },
  runtime: {
    status: () => ipcRenderer.invoke('runtime:status'),
  },
  settings: {
    modelProvider: () => ipcRenderer.invoke('settings:modelProvider'),
    saveApiKey: (apiKey) => ipcRenderer.invoke('settings:saveApiKey', apiKey),
    removeApiKey: () => ipcRenderer.invoke('settings:removeApiKey'),
  },
}

contextBridge.exposeInMainWorld('mindmesh', api)
