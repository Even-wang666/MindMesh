import { vi } from 'vitest'
import type { MindMeshServices } from '../src/main/services'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'
import { getAgentCapabilityHash } from '../src/main/agent-capability'

type Harness = ConstructorParameters<typeof MindMeshServices>[1]
type ProviderSettings = Pick<ModelProviderSettings, 'getProvider' | 'configuredProviders' | 'statuses' | 'save' | 'remove'>

export function mockProviderSettings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    getProvider: () => undefined,
    configuredProviders: () => [],
    statuses: () => [],
    save: () => [],
    remove: () => [],
    ...overrides,
  }
}

export function mockHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    run: vi.fn(async () => { throw new Error('Unexpected Harness run') }),
    stop: vi.fn(async () => false),
    prepareRun: (agent, permission) => {
      // Chat-flow fixtures isolate session bookkeeping from filesystem/SDK preparation.
      const hash = getAgentCapabilityHash(agent)
      return {
        agent, workspace: '', providers: [], skillIds: [], dshBin: '',
        identity: { key: hash, capabilityHash: hash, schemaVersion: 2, dshVersion: 'test',
          flavor: 'core', permission, workspaceIdentity: '', skillRevision: '' },
      }
    },
    status: vi.fn(() => ({ state: 'ready' as const, label: '', detail: '' })),
    forgetAgent: vi.fn(async () => undefined),
    forgetSpace: vi.fn(async () => undefined),
    workspacePath: '',
    setWorkspace: vi.fn(),
    invalidateWorkspace: vi.fn(async () => undefined),
    invalidateProvider: vi.fn(async () => undefined),
    cleanupUnusedHomes: vi.fn(),
    shutdownAll: vi.fn(async () => undefined),
    ...overrides,
  }
}
