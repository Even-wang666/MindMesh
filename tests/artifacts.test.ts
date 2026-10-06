import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { artifactFile, fileChangesFromToolResult } from '../src/main/artifacts'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import { mockHarness, mockProviderSettings } from './service-mocks'
import type { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'

describe('artifact evidence', () => {
  it('parses only known mutation confirmations and rejects prose, reads and malformed output', () => {
    const created = '<path>report.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>'
    expect(fileChangesFromToolResult('write', created)).toEqual([
      { path: 'report.md', type: 'generated_file' },
    ])
    expect(fileChangesFromToolResult('write', created.replace('Created', 'Updated'))[0].type).toBe(
      'modified_file'
    )
    for (const suffix of [' successfully.', '. All occurrences were successfully replaced.']) {
      expect(fileChangesFromToolResult('edit', `The file notes has been updated${suffix}`)).toEqual(
        [{ path: 'notes', type: 'modified_file' }]
      )
    }
    expect(fileChangesFromToolResult('read', created)).toEqual([])
    expect(fileChangesFromToolResult('pwsh', created)).toEqual([])
    expect(fileChangesFromToolResult('write', `I saved report.md.\n${created}`)).toEqual([])
    expect(fileChangesFromToolResult('write', created.replace('Created file', 'Failed'))).toEqual(
      []
    )
  })

  it('resolves regular local files and rejects URLs, network paths, directories and missing files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-artifact-path-'))
    try {
      writeFileSync(join(directory, '报告.md'), '# report')
      expect(artifactFile('报告.md', directory)).toMatchObject({
        name: '报告.md',
        mimeType: 'text/markdown',
      })
      for (const path of [
        'https://example.com/report',
        '\\\\server\\share\\file',
        '//server/share/file',
        '\\?\\C:\\file',
        directory,
        'missing.txt',
        'bad\0file',
      ]) {
        expect(() => artifactFile(path, directory)).toThrow()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('artifact persistence and execution ownership', () => {
  it('captures confirmed writes, deduplicates within a Run, and retains generations across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-artifact-'))
    const path = join(directory, 'data.db')
    const file = join(directory, 'report.md')
    let db = new MindMeshDatabase(path)
    const agent = db.listAgents()[0]
    const conversation = db.createConversation('private', agent.id)
    const run = vi.fn<DeepSeekHarnessAdapter['run']>(
      async (_agent, _prompt, sessionId, _text, _attachments, _runtime, _fresh, owner, emit) => {
        writeFileSync(file, 'new content')
        const base = {
          ...owner!,
          agentId: agent.id,
          sessionId: 'native',
          time: 1,
          seq: 1,
          callId: 'same-id',
        }
        emit?.({ ...base, type: 'tool:start', toolName: 'write', displayName: '写入文件' })
        emit?.({
          ...base,
          type: 'tool:output',
          text: 'Created file',
          isError: false,
          truncated: false,
          fileChanges: [{ path: file, type: 'generated_file' }],
        })
        emit?.({ ...base, type: 'tool:end', aborted: false })
        emit?.({ ...base, seq: 2, type: 'tool:start', toolName: 'edit', displayName: '编辑文件' })
        emit?.({
          ...base,
          seq: 3,
          type: 'tool:output',
          text: 'Updated',
          isError: false,
          truncated: false,
          fileChanges: [{ path: file, type: 'modified_file' }],
        })
        emit?.({ ...base, type: 'tool:end', aborted: false })
        // Failed output and a result without a known call are never captured.
        emit?.({
          ...base,
          type: 'tool:output',
          text: 'fake',
          isError: true,
          truncated: false,
          fileChanges: [{ path: file, type: 'modified_file' }],
        })
        return { text: 'finished', sessionId }
      }
    )
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      await service.sendPrivate(agent.id, 'task', [], { conversationId: conversation.id })
      const original = service.artifacts(conversation.id)[0]
      expect(service.artifacts(conversation.id)).toHaveLength(1)
      expect(original).toMatchObject({
        conversationId: conversation.id,
        agentId: agent.id,
        name: 'report.md',
        type: 'generated_file',
      })
      expect(service.messages('private', agent.id, conversation.id)[1].artifacts?.[0].id).toBe(
        original.id
      )
      expect(service.artifactPath(original.id)).toBe(artifactFile(file, directory).path)
      expect(() => service.artifactPath(file)).toThrow('成果不存在')
      await service.regenerate(conversation.id)
      const artifacts = service.artifacts(conversation.id)
      expect(artifacts).toHaveLength(2)
      expect(new Set(artifacts.map((a) => a.executionId)).size).toBe(2)
      expect(new Set(artifacts.map((a) => a.runId)).size).toBe(2)
      expect(service.artifacts(db.conversationIdFor('private', agent.id))).toEqual([])
      db.close()
      db = new MindMeshDatabase(path)
      expect(db.listArtifacts(conversation.id)).toEqual(artifacts)
      expect(readFileSync(file, 'utf8')).toBe('new content')
      rmSync(file)
      const reopened = new MindMeshServices(
        db,
        mockHarness(),
        mockProviderSettings(),
        () => undefined
      )
      expect(() => reopened.artifactPath(original.id)).toThrow()
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('migrates schema 10 with history and backup intact and cascades only metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-artifact-migration-'))
    const path = join(directory, 'data.db')
    const file = join(directory, 'saved.txt')
    let db = new MindMeshDatabase(path)
    try {
      const agent = db.listAgents()[0]
      const conversationId = db.conversationIdFor('private', agent.id)
      const trigger = db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'user',
        authorName: 'You',
        content: 'keep',
      })
      db.createExecution({ id: 'e', conversationId, triggerMessageId: trigger.id })
      db.createRun({
        id: 'r',
        executionId: 'e',
        conversationId,
        triggerMessageId: trigger.id,
        agentId: agent.id,
        provider: agent.provider,
        model: agent.model,
        permission: 'workspace',
        agentSnapshot: JSON.stringify({ name: 'Original author' }),
      })
      db.close()
      const raw = new DatabaseSync(path)
      raw.exec('DROP TABLE artifacts')
      raw.prepare("UPDATE app_meta SET value = '10' WHERE key = 'schema_version'").run()
      raw.close()
      db = new MindMeshDatabase(path)
      expect(db.listMessages(conversationId)[0].id).toBe(trigger.id)
      writeFileSync(file, 'keep physical file')
      db.addArtifact('e', { ...artifactFile(file, directory), type: 'generated_file' }, 'r')
      db.updateAgent(agent.id, { ...agent, name: 'Renamed author' })
      expect(db.listArtifacts(conversationId)[0].agentName).toBe('Original author')
      expect(() =>
        db.addArtifact('e', { ...artifactFile(file, directory), type: 'generated_file' }, 'unknown')
      ).toThrow()
      db.createExecution({ id: 'execution-only', conversationId, triggerMessageId: trigger.id })
      expect(() =>
        db.addArtifact(
          'execution-only',
          { ...artifactFile(file, directory), type: 'generated_file' },
          'r'
        )
      ).toThrow()
      db.addArtifact('execution-only', { ...artifactFile(file, directory), type: 'generated_file' })
      db.addArtifact('execution-only', { ...artifactFile(file, directory), type: 'modified_file' })
      expect(db.listArtifacts(conversationId)).toHaveLength(2)
      expect(db.listArtifacts(conversationId)[1]).toMatchObject({
        executionId: 'execution-only',
        conversationId,
        runId: null,
        agentId: null,
        type: 'generated_file',
      })
      const backup = new DatabaseSync(`${path}.before-schema-10.sqlite`)
      expect(
        backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()?.value
      ).toBe('10')
      backup.close()
      db.removeAgent(agent.id)
      expect(() => db.listArtifacts(conversationId)).toThrow()
      expect(readFileSync(file, 'utf8')).toBe('keep physical file')
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
