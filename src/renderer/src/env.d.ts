import type { MindMeshApi } from '../../shared/contracts'

declare global {
  interface Window {
    mindmesh: MindMeshApi
  }
}

export {}

