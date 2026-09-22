import { contextBridge, ipcRenderer } from 'electron'
import type { ChatDelta, ChatProgress, MindMeshApi } from '../shared/contracts'

const api: MindMeshApi = {
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    create: (input) => ipcRenderer.invoke('agents:create', input),
    update: (id, input) => ipcRenderer.invoke('agents:update', id, input),
    remove: (id) => ipcRenderer.invoke('agents:remove', id),
  },
  spaces: {
    list: () => ipcRenderer.invoke('spaces:list'),
    create: (input) => ipcRenderer.invoke('spaces:create', input),
    updateContext: (id, context) => ipcRenderer.invoke('spaces:updateContext', id, context),
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
    onProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatProgress): void => listener(payload)
      ipcRenderer.on('chat:progress', handler)
      return () => ipcRenderer.removeListener('chat:progress', handler)
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
    profile: () => ipcRenderer.invoke('settings:profile'),
    saveProfile: (profile) => ipcRenderer.invoke('settings:saveProfile', profile),
    modelProviders: () => ipcRenderer.invoke('settings:modelProviders'),
    saveModelProvider: (input) => ipcRenderer.invoke('settings:saveModelProvider', input),
    removeModelProvider: (id) => ipcRenderer.invoke('settings:removeModelProvider', id),
  },
}

contextBridge.exposeInMainWorld('mindmesh', api)
