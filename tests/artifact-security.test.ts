import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const filesystem = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}))
vi.mock('node:fs', () => filesystem)
import { artifactFile } from '../src/main/artifacts'

beforeEach(() => {
  vi.clearAllMocks()
  filesystem.lstatSync.mockImplementation((path: string) => ({
    isSymbolicLink: () => path.endsWith('junction'),
  }))
  filesystem.realpathSync.mockImplementation((path: string) => path)
  filesystem.statSync.mockReturnValue({ isFile: () => true })
})

describe('artifact filesystem boundary', () => {
  it('rejects a relative path in a UNC workspace before filesystem access', () => {
    expect(() => artifactFile('report.md', '\\\\server\\share')).toThrow('无效的成果路径')
    expect(filesystem.lstatSync).not.toHaveBeenCalled()
    expect(filesystem.realpathSync).not.toHaveBeenCalled()
    expect(filesystem.statSync).not.toHaveBeenCalled()
  })

  it('rejects a symlink or junction ancestor before resolving or accessing its target', () => {
    expect(() => artifactFile(join(tmpdir(), 'junction', 'report.md'), '')).toThrow(
      '成果路径不能经过符号链接'
    )
    expect(filesystem.realpathSync).not.toHaveBeenCalled()
    expect(filesystem.statSync).not.toHaveBeenCalled()
    expect(filesystem.lstatSync.mock.calls.some(([path]) => path.endsWith('report.md'))).toBe(false)
  })
})
