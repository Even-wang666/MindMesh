export const MAX_CHAT_CONTENT_BYTES = 64 * 1024

export function getChatContentError(content: unknown): string | null {
  if (typeof content !== 'string') return '消息内容必须是字符串'
  return new TextEncoder().encode(content).byteLength > MAX_CHAT_CONTENT_BYTES
    ? '消息内容不能超过 64 KiB'
    : null
}

export function validateChatContent(content: unknown): asserts content is string {
  const error = getChatContentError(content)
  if (error) throw new Error(error)
}
