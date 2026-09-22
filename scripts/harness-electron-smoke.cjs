const { app } = require('electron')
const { mkdirSync } = require('node:fs')
const { resolve } = require('node:path')

async function main() {
  await app.whenReady()
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
  const workspace = resolve(__dirname, '..')
  const dshHome = resolve(workspace, '.runtime', 'harness-electron-smoke')
  mkdirSync(dshHome, { recursive: true })
  const harness = new DeepSeekHarness({
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    cwd: workspace,
    processCwd: workspace,
    dshHome,
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    maxTokens: 4096,
    initializeTimeoutMs: 30_000,
  })
  try {
    await harness.start()
    console.log('Electron Harness SDK handshake: OK')
  } finally {
    await harness.close()
    app.quit()
  }
}

main().catch((error) => {
  console.error(String(error).replaceAll(process.env.DEEPSEEK_API_KEY ?? '__absent__', '<REDACTED>'))
  app.exit(1)
})
