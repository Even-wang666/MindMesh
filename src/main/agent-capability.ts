import { createHash } from 'node:crypto'
import type { Agent } from '../shared/contracts'

export function getAgentCapabilityHash(agent: Agent, skillRevision = ''): string {
  const base = createHash('sha256')
    .update(JSON.stringify([agent.provider, agent.model, agent.persona, agent.skills, agent.tools, agent.reasoningEffort ?? '']))
    .digest('hex')
  return skillRevision ? `${base}:${skillRevision}` : base
}

export function getAgentCapabilityBaseHash(capabilityHash: string): string {
  return capabilityHash.split(':', 1)[0]
}
