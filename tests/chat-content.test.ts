import { describe, expect, it } from 'vitest'
import { MAX_CHAT_CONTENT_BYTES, getChatContentError } from '../src/shared/chat-content'

describe('chat content limits', () => {
  it('accepts the exact UTF-8 byte limit and rejects one byte more', () => {
    expect(getChatContentError('a'.repeat(MAX_CHAT_CONTENT_BYTES))).toBeNull()
    expect(getChatContentError('a'.repeat(MAX_CHAT_CONTENT_BYTES + 1))).toContain('64 KiB')
  })

  it('counts multibyte characters as UTF-8 bytes', () => {
    expect(getChatContentError('😀'.repeat(MAX_CHAT_CONTENT_BYTES / 4))).toBeNull()
    expect(getChatContentError(`${'😀'.repeat(MAX_CHAT_CONTENT_BYTES / 4)}a`)).toContain('64 KiB')
    expect(getChatContentError('你'.repeat(Math.floor(MAX_CHAT_CONTENT_BYTES / 3) + 1))).toContain(
      '64 KiB'
    )
  })

  it('rejects non-string values at the shared boundary', () => {
    expect(getChatContentError(undefined)).toBe('消息内容必须是字符串')
    expect(getChatContentError(42)).toBe('消息内容必须是字符串')
  })
})
