// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpaceWizard } from '../src/renderer/src/Wizards'
import type { Agent, MindMeshApi, Space } from '../src/shared/contracts'

afterEach(cleanup)
const agents: Agent[] = ['A', 'B', 'C'].map((name) => ({
  id: name,
  name,
  role: '',
  persona: name,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  skills: [],
  tools: [],
  createdAt: '',
}))
const space: Space = {
  id: 's',
  name: 'Workflow',
  description: '',
  context: '',
  memberIds: ['C', 'A', 'B'],
  executionMode: 'sequential',
  createdAt: '',
}

describe('Space workflow configuration', () => {
  it('supports keyboard ordering, disables parallel, and saves workflow order', async () => {
    const update = vi.fn(async () => space)
    Object.defineProperty(window, 'mindmesh', {
      configurable: true,
      value: { spaces: { update } } as unknown as MindMeshApi,
    })
    render(
      <SpaceWizard
        agents={agents}
        initialSpace={space}
        onClose={vi.fn()}
        onSaved={vi.fn(async () => {})}
      />
    )
    expect(screen.getByRole('radio', { name: /并行执行/ })).toBeDisabled()
    const order = screen.getByRole('list', { name: '成员执行顺序' })
    expect(
      within(order)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-member-id'))
    ).toEqual(['C', 'A', 'B'])
    const handle = screen.getByRole('button', { name: '调整 A 的执行顺序' })
    handle.focus()
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(
      within(order)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-member-id'))
    ).toEqual(['A', 'C', 'B'])
    expect(handle).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('s', {
        name: 'Workflow',
        description: '',
        context: '',
        memberIds: ['A', 'C', 'B'],
        executionMode: 'sequential',
      })
    )
  })

  it('supports pointer drag ordering through the same saved member list', () => {
    render(
      <SpaceWizard
        agents={agents}
        initialSpace={space}
        onClose={vi.fn()}
        onSaved={vi.fn(async () => {})}
      />
    )
    const dataTransfer = { setData: vi.fn(), getData: () => 'B', effectAllowed: 'move' }
    fireEvent.dragStart(screen.getByRole('button', { name: '调整 B 的执行顺序' }), { dataTransfer })
    fireEvent.dragOver(
      screen.getByRole('list', { name: '成员执行顺序' }).querySelector('[data-member-id="C"]')!,
      { dataTransfer }
    )
    fireEvent.drop(
      screen.getByRole('list', { name: '成员执行顺序' }).querySelector('[data-member-id="C"]')!,
      { dataTransfer }
    )
    expect(
      within(screen.getByRole('list', { name: '成员执行顺序' }))
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-member-id'))
    ).toEqual(['B', 'C', 'A'])
  })
})
