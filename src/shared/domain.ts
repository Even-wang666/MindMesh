import type { Agent } from './contracts'

export const DEEPSEEK_API_KEY_MIN_LENGTH = 27
export const DEEPSEEK_API_KEY_MAX_LENGTH = 67
export const DEEPSEEK_API_KEY_EXAMPLE = 'sk-0123456789abcdefghijklmnopqrstuv'

export function getDeepSeekApiKeyError(value: string): string | null {
  const apiKey = value.trim()
  if (!apiKey) return '请输入 DeepSeek API Key'
  if (!apiKey.startsWith('sk-')) return 'DeepSeek API Key 必须以 sk- 开头'
  if (apiKey.length < DEEPSEEK_API_KEY_MIN_LENGTH || apiKey.length > DEEPSEEK_API_KEY_MAX_LENGTH) {
    return `完整长度应为 ${DEEPSEEK_API_KEY_MIN_LENGTH}-${DEEPSEEK_API_KEY_MAX_LENGTH} 个字符，当前 ${apiKey.length} 个`
  }
  if (!/^sk-[A-Za-z0-9_-]+$/.test(apiKey)) return 'sk- 后仅支持字母、数字、短横线和下划线'
  return null
}

export function parseMentions(content: string, members: Agent[]): Agent[] {
  const positions = members
    .map((agent) => ({ agent, index: content.indexOf(`@${agent.name}`) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)

  return positions.map((item) => item.agent)
}

export function buildPrivatePrompt(agent: Agent, content: string): string {
  return [
    `你是 ${agent.name}。`,
    `角色定位：${agent.role || '由用户定义的智能体'}`,
    '身份设定：',
    agent.persona,
    '请始终保持上述身份，并直接回应用户。',
    '',
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
