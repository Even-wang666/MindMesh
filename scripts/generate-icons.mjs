import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '..')
const svg = await readFile(resolve(root, 'assets/branding/mindmesh-logo.svg'))
const resources = resolve(root, 'resources')
await mkdir(resources, { recursive: true })

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngPaths = []
for (const size of sizes) {
  const path = resolve(resources, `icon-${size}.png`)
  await sharp(svg).resize(size, size).png().toFile(path)
  pngPaths.push(path)
}
await sharp(svg).resize(512, 512).png().toFile(resolve(resources, 'icon.png'))
await writeFile(resolve(resources, 'icon.ico'), await pngToIco(pngPaths))
