import type { Agent } from './contracts'

export function parseMentions(content: string, members: Agent[]): Agent[] {
  const positions = members
    .map((agent) => ({ agent, index: content.indexOf(`@${agent.name}`) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)

  return positions.map((item) => item.agent)
}

export function buildPrivatePrompt(
  agent: Agent, content: string, history: Array<{ authorName: string; content: string }> = [],
): string {
  return [
    `你是 ${agent.name}。`,
    `角色定位：${agent.role || '由用户定义的智能体'}`,
    '身份设定：',
    agent.persona,
    '请始终保持上述身份，并直接回应用户。',
    '',
    ...(history.length ? ['此前对话：', ...history.map((message) => `${message.authorName}：${message.content}`), ''] : []),
    `用户：${content}`,
  ].join('\n')
}

export function buildSpacePrompt(
  agent: Agent,
  space: { name: string; context: string },
  messages: Array<{ authorName: string; content: string }>,
): string {
  const transcript = messages.map((message) => `${message.authorName}：${message.content}`).join('\n')
  return [
    `你是 ${agent.name}。`,
    `角色定位：${agent.role || '由用户定义的智能体'}`,
    '身份设定：',
    agent.persona,
    `你正在协作空间「${space.name}」中参与讨论。`,
    '空间背景：',
    space.context || '暂无补充背景。',
    '请保持自己的身份，并基于共享对话继续工作。',
    '',
    '共享对话：',
    transcript,
  ].join('\n')
}
