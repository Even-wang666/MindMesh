import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { create } from 'tar'

/** Local npm protocol fixtures; installs still use real pnpm and DSH. */
export async function startPluginFixtureRegistry(root) {
  const packages = new Map()
  const versions = ['1.0.0', '1.0.1', '2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0', '7.0.0']
  const names = [
    'mindmesh-fixture-plugin',
    'mindmesh-fixture-conflict',
    'mindmesh-fixture-build',
    'mindmesh-fixture-peer',
  ]
  for (const name of names)
    for (const version of name === names[0] ? versions : ['1.0.0']) {
      const dir = join(root, name, version)
      mkdirSync(join(dir, 'package'), { recursive: true })
      writeFileSync(
        join(dir, 'package', 'package.json'),
        JSON.stringify({
          name,
          version,
          main: 'index.cjs',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
          ...(version === '4.0.0' || name === names[2]
            ? {
                scripts: {
                  postinstall: `node -e "require('fs').writeFileSync('${join(root, 'script-ran').replaceAll('\\', '/')}', 'bad')"`,
                },
              }
            : {}),
          ...(version === '6.0.0' ? { dependencies: { 'mindmesh-fixture-build': '1.0.0' } } : {}),
          peerDependencies: {
            '@deepseek-ai/cordis': version === '7.0.0' ? '^3.0.0' : '^4.0.0',
            ...(name === names[3] ? { 'mindmesh-fixture-plugin': '1.0.0' } : {}),
          },
        })
      )
      const tool = `exports.inject = ['tools']; exports.apply = (ctx) => { ctx.tools.register({ name: 'mindmesh_fixture_echo', description: 'Return the fixture version', parameters: {type:'object',properties:{},additionalProperties:false}, output: {schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]}, execute:async()=>{require('fs').writeFileSync(${JSON.stringify(join(root, 'tool-called-' + version))}, 'called');return 'fixture:${version}';} }); };`
      writeFileSync(
        join(dir, 'package', 'index.cjs'),
        version === '2.0.0'
          ? "console.log('polluted'); exports.apply = () => {}"
          : version === '3.0.0'
            ? "exports.apply = () => { throw new Error('fixture startup failure') }"
            : name === names[0] && version.startsWith('1.')
              ? tool
              : 'exports.apply = () => {}'
      )
      const row = `    - id: ${name === names[3] ? 'mindmesh-peer' : 'mindmesh-fixture'}\n      name: ${name}\n`
      writeFileSync(
        join(dir, 'package', 'cordis.patch.yml'),
        '- insert:\n' + row + (version === '5.0.0' ? row : '')
      )
      const file = join(dir, 'package.tgz')
      await create({ gzip: true, cwd: dir, file }, ['package'])
      packages.set(`${name}@${version}`, readFileSync(file))
    }
  let url = ''
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    const name = path.split('/')[1]
    if (path.endsWith('.tgz')) {
      const version = path.split('/').pop().replace('.tgz', '')
      response.end(packages.get(`${name}@${version}`))
      return
    }
    if (names.includes(name)) {
      response.setHeader('Content-Type', 'application/json')
      const metadata = {
        name,
        'dist-tags': { latest: name === names[0] ? '1.0.1' : '1.0.0' },
        versions: Object.fromEntries(
          (name === names[0] ? versions : ['1.0.0']).map((version) => [
            version,
            {
              name,
              version,
              ...(version === '6.0.0'
                ? { dependencies: { 'mindmesh-fixture-build': '1.0.0' } }
                : {}),
              dist: {
                tarball: `${url}${name}/${version}.tgz`,
                integrity:
                  'sha512-' +
                  createHash('sha512')
                    .update(packages.get(`${name}@${version}`))
                    .digest('base64'),
              },
            },
          ])
        ),
      }
      response.end(JSON.stringify(metadata.versions[path.split('/')[2]] ?? metadata))
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}/`
  return { url, close: () => new Promise((resolve) => server.close(() => resolve())) }
}
