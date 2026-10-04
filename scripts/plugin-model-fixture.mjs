import { createServer } from 'node:http'

/** Replaces only the model HTTP boundary. DSH, tool dispatch and plugin JS are real. */
export async function startPluginModelFixture() {
  const requests = []
  let held
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    requests.push(input)
    if (held) {
      const notify = held; held = undefined
      await new Promise((resume) => notify(resume))
    }
    const userIndex = input.messages?.findLastIndex((message) => message.role === 'user') ?? -1
    const lastTool = input.messages?.slice(userIndex + 1).filter((message) => message.role === 'tool').at(-1)
    const names = (input.tools ?? []).map((tool) => tool.function.name)
    const present = names.includes('mindmesh_fixture_echo') || JSON.stringify(input.messages).includes('mindmesh_fixture_echo')
    const toolCall = !lastTool && present
    const name = names.includes('mindmesh_fixture_echo') ? 'mindmesh_fixture_echo' : 'run_code'
    const args = name === 'run_code' ? { code: 'return await tools.mindmesh_fixture_echo({});' } : {}
    const content = lastTool ? String(lastTool.content) : 'core-without-plugin'
    const message = toolCall ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content }
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = toolCall ? { role: 'assistant', tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) } : message
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    } else {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: input.model, choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    holdNext: () => new Promise((notify) => { held = notify }),
    close: () => new Promise((done) => server.close(done)) }
}
