// Tool display mapping: the spike captured DSH tool names verbatim from the
// wire (`pwsh`, `job_output`). They must map to user-facing labels and
// present-tense action phrases, and unknown names must degrade to the raw id.

import { describe, expect, it } from 'vitest'
import { toolDisplayName, toolStatusPhrase } from '../src/shared/tool-display'

describe('toolDisplayName', () => {
  it('maps known DSH tool names to user-facing labels', () => {
    expect(toolDisplayName('pwsh')).toBe('执行命令')
    expect(toolDisplayName('bash')).toBe('执行命令')
    expect(toolDisplayName('job_output')).toBe('查看后台任务输出')
    expect(toolDisplayName('web_search')).toBe('搜索网页')
    expect(toolDisplayName('read')).toBe('读取文件')
  })

  it('falls back to the raw id for unknown tools', () => {
    expect(toolDisplayName('some_future_tool')).toBe('some_future_tool')
  })
})

describe('toolStatusPhrase', () => {
  it('produces a present-tense action phrase', () => {
    expect(toolStatusPhrase('pwsh')).toBe('正在执行命令')
    expect(toolStatusPhrase('read')).toBe('正在读取文件')
  })

  it('degrades for unknown tools', () => {
    expect(toolStatusPhrase('some_future_tool')).toBe('正在some_future_tool')
  })
})
