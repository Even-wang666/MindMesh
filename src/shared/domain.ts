import type { Agent, Message } from './contracts'

type PromptMessage = Pick<Message, 'authorName' | 'content' | 'stopped'>

function formatPromptMessage(message: PromptMessage): string {
  const status = message.stopped ? '（回复已停止，内容可能不完整）' : ''
  return `${message.authorName}${status}：${message.content}`
}

export function parseMentions(content: string, members: Agent[]): Agent[] {
  const positions = members
    .map((agent) => {
      const mention = `@${agent.name}`
      let index = content.indexOf(mention)
      while (index >= 0 && /[\p{L}\p{N}_-]/u.test(content[index + mention.length] ?? '')) {
        index = content.indexOf(mention, index + mention.length)
      }
      return { agent, index }
    })
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)

  return positions.map((item) => item.agent)
}

export function buildPrivatePrompt(
  agent: Agent, content: string, history: PromptMessage[] = [],
): string {
  return [
    `你是 ${agent.name}。`,
    `角色定位：${agent.role || '由用户定义的智能体'}`,
    '身份设定：',
    agent.persona,
    '请始终保持上述身份，并直接回应用户。',
    '',
    ...(history.length ? ['此前对话：', ...history.map(formatPromptMessage), ''] : []),
    `用户：${content}`,
  ].join('\n')
}

export function buildSpacePrompt(
  agent: Agent,
  space: { name: string; context: string },
  messages: PromptMessage[],
): string {
  const transcript = messages.map(formatPromptMessage).join('\n')
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
