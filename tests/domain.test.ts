import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/shared/contracts'
import { buildPrivatePrompt, buildSpacePrompt, parseMentions } from '../src/shared/domain'

const agents: Agent[] = [
  {
    id: 'researcher', name: 'Researcher', role: '研究分析专家', persona: '坚持证据优先。',
    provider: 'deepseek-official', model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '',
  },
  {
    id: 'developer', name: 'Developer', role: '软件工程师', persona: '给出可验证实现。',
    provider: 'deepseek-official', model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '',
  },
]

describe('parseMentions', () => {
  it('keeps the user mention order', () => {
    expect(parseMentions('@Developer 先实现，@Researcher 再验证', agents).map((agent) => agent.id))
      .toEqual(['developer', 'researcher'])
  })

  it('ignores agents outside the content', () => {
    expect(parseMentions('普通共享消息', agents)).toEqual([])
  })

  it('does not match a name inside a longer mention', () => {
    const dev = { ...agents[1], id: 'dev', name: 'Dev' }
    expect(parseMentions('@Developer 请处理', [dev, agents[1]])).toEqual([agents[1]])
  })
})

describe('context builders', () => {
  it('keeps private identity and user content', () => {
    const prompt = buildPrivatePrompt(agents[0], '分析这个市场')
    expect(prompt).toContain('你是 Researcher')
    expect(prompt).toContain('坚持证据优先')
    expect(prompt).toContain('分析这个市场')
  })

  it('adds space context without changing identity', () => {
    const prompt = buildSpacePrompt(
      agents[1],
      { name: 'MVP', context: '只实现核心路径' },
      [{ authorName: 'Researcher', content: '已有调研结论' }],
    )
    expect(prompt).toContain('你是 Developer')
    expect(prompt).toContain('只实现核心路径')
    expect(prompt).toContain('Researcher：已有调研结论')
  })

  it('labels stopped replies as incomplete in private history', () => {
    const prompt = buildPrivatePrompt(
      agents[0],
      '继续',
      [{ authorName: 'Researcher', content: '被打断的半句话', stopped: true }],
    )
    expect(prompt).toContain('Researcher（回复已停止，内容可能不完整）：被打断的半句话')
  })

  it('labels stopped replies as incomplete in shared space history', () => {
    const prompt = buildSpacePrompt(
      agents[1],
      { name: 'MVP', context: '' },
      [{ authorName: 'Researcher', content: '被打断的半句话', stopped: true }],
    )
    expect(prompt).toContain('Researcher（回复已停止，内容可能不完整）：被打断的半句话')
  })
})
