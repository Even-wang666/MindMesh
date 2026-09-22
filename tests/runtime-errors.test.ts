import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendRuntimeError } from '../src/main/runtime-errors'

describe('runtime error log', () => {
  it('records diagnostic metadata without API keys, prompts, or raw messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-error-log-'))
    const path = join(directory, 'errors.jsonl')
    try {
      const error = Object.assign(new Error('secret-key and private prompt'), { code: 'ECONNRESET', status: 503 })
      appendRuntimeError(path, 'space', 'agent-1', error)
      const source = readFileSync(path, 'utf8')
      expect(JSON.parse(source)).toMatchObject({ scope: 'space', agentId: 'agent-1', code: 'ECONNRESET', status: 503 })
      expect(source).not.toContain('secret-key')
      expect(source).not.toContain('private prompt')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
