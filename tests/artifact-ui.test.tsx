// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, Execution, MindMeshApi } from '../src/shared/contracts'
import { ArtifactList, ExecutionOutputs } from '../src/renderer/src/ArtifactList'
import { visibleGenerationItems } from '../src/renderer/src/ConversationControls'

afterEach(cleanup)
const file: Artifact = {
  id: 'a',
  conversationId: 'c',
  executionId: 'e1',
  runId: 'r1',
  agentId: 'agent',
  agentName: 'Researcher',
  name: 'report.md',
  path: 'C:\\workspace\\report.md',
  type: 'generated_file',
  mimeType: 'text/markdown',
  createdAt: '',
}

describe('run outputs', () => {
  it('reveals only a recorded ID and reports missing files', async () => {
    const revealArtifact = vi.fn(async () => {
      throw new Error('not found')
    })
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: { chat: { revealArtifact } } as unknown as MindMeshApi,
    })
    render(<ArtifactList title="本轮成果" artifacts={[file]} />)
    expect(screen.getByText('新建文件')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('在文件夹中显示 report.md'))
    expect(revealArtifact).toHaveBeenCalledWith('a')
    await screen.findByRole('alert')
  })

  it('groups Space outputs by execution and agent while displaying the selected generation', () => {
    const executions: Execution[] = [1, 2].map((generationIndex) => ({
      id: `e${generationIndex}`,
      conversationId: 'c',
      triggerMessageId: 'u',
      generationIndex,
      status: 'completed',
      regeneratedFromExecutionId: generationIndex === 1 ? null : 'e1',
    }))
    const outputs = [
      file,
      { ...file, id: 'b', executionId: 'e2', name: 'report-v2.md' },
      {
        ...file,
        id: 'd',
        executionId: 'e2',
        agentId: 'developer',
        agentName: 'Developer',
        name: 'app.ts',
        type: 'modified_file' as const,
      },
    ]
    render(<ExecutionOutputs artifacts={visibleGenerationItems(outputs, executions, {})} />)
    expect(screen.queryByText('report.md')).toBeNull()
    expect(screen.getByText('report-v2.md')).toBeTruthy()
    expect(screen.getByText('Researcher')).toBeTruthy()
    expect(screen.getByText('Developer')).toBeTruthy()
    expect(screen.getByText('本次协作成果 · 2 项')).toBeTruthy()
    expect(visibleGenerationItems(outputs, executions, { u: 'e1' })).toEqual([file])
  })
})
