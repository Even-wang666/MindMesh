import { createHash } from 'node:crypto'
import type { Agent } from '../shared/contracts'

export function getAgentCapabilityHash(agent: Agent): string {
  return createHash('sha256')
    .update(JSON.stringify([agent.provider, agent.model, agent.persona, agent.skills, agent.tools]))
    .digest('hex')
}
