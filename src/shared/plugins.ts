export type PluginAction = 'check' | 'install' | 'update' | 'remove' | 'enable' | 'disable'
export type PluginPhase =
  | 'queued'
  | 'preparing'
  | 'installing'
  | 'checking'
  | 'booting'
  | 'sealing'
  | 'committing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type PluginCompatibility = 'unknown' | 'compatible' | 'incompatible' | 'needs-approval'
export type PluginOperation = {
  requestId: string
  key: string
  action: PluginAction
  phase: PluginPhase
  message?: string
  diagnostics?: string
}
export type PluginRequest = {
  requestId: string
  key: string
  action: PluginAction
  version?: string
}
export type GitHubPluginRequest = { requestId: string; url: string }
export type LocalPluginResult = {
  key: string
  version: string
  compatibility: PluginCompatibility
  diagnostics?: string
}
export type PluginState = {
  available?: { key: string; version: string }[]
  preparing?: boolean
  installed: {
    packageName: string
    version: string
    enabled: boolean
    configuration: 'default' | 'configured'
  }[]
  results: LocalPluginResult[]
  operation: PluginOperation | null
}
