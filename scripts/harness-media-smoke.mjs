import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for the live media smoke')
const home = mkdtempSync(join(tmpdir(), 'mindmesh-upgrade-image-'))
const patch = join(home, 'image.patch.yml')
writeFileSync(patch, '- id: tool-plugin-manager\n  disabled: true\n')
const harness = new DeepSeekHarness({ profile: 'sdk', patches: [patch], provider: 'deepseek-official', model: 'deepseek-v4-flash',
  cwd: home, processCwd: home, dshHome: home, reasoningEffort: 'high', initializeTimeoutMs: 30_000,
  env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
    DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' } })
let reasoningBlocks = 0
try {
  const data = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const result = await harness.run([{ type: 'text', text: '这张纯色图片主要是什么颜色？只回复颜色名称。' }, { type: 'image', mimeType: 'image/png', data: data.toString('base64') }], {
    onNotification(notification) {
      const event = notification.params?.event
      if (event?.type === 'assistant/message') reasoningBlocks += event.data.message.content.filter((block) => block.type === 'reasoning' && block.text.trim()).length
    },
  })
  assert.match(result.finalResponse, /红|red/i)
  assert.ok(reasoningBlocks > 0, 'Reasoning notification missing')
  console.log('Live image recognition and high-effort reasoning notifications: OK')
} finally {
  try { await harness.close() }
  finally {
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected smoke directory')
    rmSync(home, { recursive: true, force: true })
  }
}
