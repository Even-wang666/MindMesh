const { app } = require('electron')

async function main() {
  await app.whenReady()
  await import('./harness-smoke.mjs')
  console.log('Electron Harness SDK handshake and shutdown: OK')
  app.quit()
}

main().catch((error) => {
  console.error(String(error).replaceAll(process.env.DEEPSEEK_API_KEY ?? '__absent__', '<REDACTED>'))
  app.exit(1)
})
