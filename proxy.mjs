#!/usr/bin/env node

/**
 * Codex API Bridge — Translate OpenAI Responses API (WebSocket) to Chat Completions API (HTTP)
 *
 * Codex CLI v0.116+ only supports the Responses API (/v1/responses, WebSocket).
 * Many third-party providers only support the Chat Completions API (/v1/chat/completions, HTTP).
 * This proxy bridges the gap so you can use Codex with any OpenAI-compatible provider.
 *
 * Environment variables:
 *   TARGET_URL       - Upstream Chat Completions endpoint (default: http://localhost:8080/v1/chat/completions)
 *   API_KEY          - API key for the upstream provider
 *   PROXY_PORT       - Local port to listen on (default: 18789)
 *   MODEL            - Default model name (default: gpt-3.5-turbo)
 */

import http from 'node:http'
import https from 'node:https'
import { WebSocketServer } from 'ws'

const UPSTREAM_URL = new URL(process.env.TARGET_URL || 'http://localhost:8080/v1/chat/completions')
const API_KEY = process.env.API_KEY || process.env.OPENAI_API_KEY || ''
const PORT = parseInt(process.env.PROXY_PORT || '18789')
const DEFAULT_MODEL = process.env.MODEL || 'gpt-3.5-turbo'

const ROLE_MAP = {
  developer: 'system',
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  tool: 'tool',
}

function extractText(part) {
  if (typeof part === 'string') return part
  if (part.type === 'text' || part.type === 'input_text') return part.text || ''
  return ''
}

function buildMessages(msg) {
  const msgs = []
  for (const item of msg.input || []) {
    if (item.type === 'message' && item.role) {
      const content = Array.isArray(item.content)
        ? item.content.map(extractText).join('')
        : (typeof item.content === 'string' ? item.content : '')

      // Assistant messages with embedded tool_calls
      if (item.role === 'assistant' && item.tool_calls?.length) {
        const entry = { role: 'assistant', content: content || null }
        entry.tool_calls = item.tool_calls.map(tc => {
          const fn = tc.function || {}
          return {
            id: tc.id,
            type: 'function',
            function: {
              name: fn.name || tc.name || '',
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(tc.input || {}),
            },
          }
        })
        msgs.push(entry)
        continue
      }

      // Tool role messages
      if (item.role === 'tool') {
        if (content || item.tool_call_id) {
          msgs.push({ role: 'tool', content: content || '', tool_call_id: item.tool_call_id })
        }
        continue
      }

      // Regular messages
      if (content) msgs.push({ role: ROLE_MAP[item.role] || item.role, content })
      continue
    }

    // Function_call / tool_use items in input (from previous assistant tool calls)
    if (item.type === 'function_call' || item.type === 'tool_use') {
      const args = typeof item.arguments === 'string'
        ? item.arguments
        : JSON.stringify(item.input || {})
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.id || `fc_${msgs.length}_${Date.now()}`,
          type: 'function',
          function: { name: item.name || '', arguments: args },
        }],
      })
      continue
    }
  }
  return msgs
}

// Merge consecutive messages of the same role.
// Some providers (e.g. China Mobile MaaS) reject requests with multiple
// consecutive system messages. Codex sends both `instructions` and
// `developer`-role input items, both mapped to `system`.
function normalizeMessages(msgs) {
  if (!msgs.length) return msgs
  const result = [{ role: msgs[0].role, content: msgs[0].content || '' }]
  if (msgs[0].tool_call_id) result[0].tool_call_id = msgs[0].tool_call_id
  if (msgs[0].tool_calls) result[0].tool_calls = msgs[0].tool_calls

  for (let i = 1; i < msgs.length; i++) {
    const prev = result[result.length - 1]
    const curr = msgs[i]
    if (prev.role === curr.role && prev.role !== 'assistant') {
      prev.content = (prev.content || '') + '\n\n' + (curr.content || '')
      if (curr.tool_call_id && !prev.tool_call_id) prev.tool_call_id = curr.tool_call_id
    } else {
      const entry = { role: curr.role, content: curr.content || '' }
      if (curr.tool_call_id) entry.tool_call_id = curr.tool_call_id
      if (curr.tool_calls) entry.tool_calls = curr.tool_calls
      result.push(entry)
    }
  }
  return result
}

function isToolChoiceSpecific(choice) {
  return choice && typeof choice === 'object' && choice.name
}

function callUpstream(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    }
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`

    const lib = UPSTREAM_URL.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        hostname: UPSTREAM_URL.hostname,
        port: UPSTREAM_URL.port || (UPSTREAM_URL.protocol === 'https:' ? 443 : 80),
        path: UPSTREAM_URL.pathname,
        method: 'POST',
        headers,
      },
      resolve
    )
    req.on('error', reject)
    req.end(data)
  })
}

// ---------- WebSocket handler ----------

function handleWS(ws) {
  let done = false

  ws.on('message', async (raw) => {
    if (done) return
    done = true

    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type !== 'response.create') return

      let messages = buildMessages(msg)
      if (msg.instructions) messages.unshift({ role: 'system', content: msg.instructions })
      messages = normalizeMessages(messages)

      if (!messages.length) {
        ws.send(JSON.stringify({ type: 'error', error: { message: 'empty messages' } }))
        ws.close()
        return
      }

      const upstreamBody = {
        model: msg.model || DEFAULT_MODEL,
        messages,
        max_tokens: msg.max_output_tokens ?? 4096,
        temperature: msg.temperature ?? 0.7,
        stream: true,
      }
      if (msg.tools?.length) upstreamBody.tools = msg.tools
      if (msg.tool_choice) {
        upstreamBody.tool_choice = isToolChoiceSpecific(msg.tool_choice)
          ? { type: msg.tool_choice.type || 'function', function: { name: msg.tool_choice.name } }
          : msg.tool_choice
      }

      const upstream = await callUpstream(upstreamBody)

      if (upstream.statusCode >= 400) {
        ws.send(JSON.stringify({ type: 'error', error: { message: `upstream ${upstream.statusCode}` } }))
        ws.close()
        return
      }

      const respId = `resp_${Date.now()}`
      const textMsgId = `msg_${Date.now()}`
      let textItemSent = false
      let fullText = ''

      const toolCalls = {}

      ws.send(JSON.stringify({
        type: 'response.created',
        response: { id: respId, object: 'response', status: 'in_progress' },
      }))

      let lineBuf = ''
      for await (const chunk of upstream) {
        lineBuf += chunk.toString()
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:') || t === 'data: [DONE]') continue
          try {
            const parsed = JSON.parse(t.slice(5).trim())
            const choice = parsed.choices?.[0]?.delta || parsed.choices?.[0]

            const delta = choice?.content || ''
            if (delta) {
              if (!textItemSent) {
                textItemSent = true
                ws.send(JSON.stringify({
                  type: 'response.output_item.added',
                  item: { id: textMsgId, type: 'message', role: 'assistant', status: 'in_progress' },
                }))
                ws.send(JSON.stringify({
                  type: 'response.content_part.added',
                  part: { type: 'text', text: '' },
                  index: 0,
                  item_id: textMsgId,
                }))
              }
              fullText += delta
              ws.send(JSON.stringify({ type: 'response.text.delta', delta, index: 0, item_id: textMsgId }))
            }

            const tcDelta = choice?.tool_calls
            if (tcDelta) {
              for (const tc of tcDelta) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = {
                    id: tc.id || `fc_${Date.now()}_${tc.index}`,
                    name: '',
                    arguments: '',
                    item_id: `tooluse_${Date.now()}_${tc.index}`,
                    started: false,
                  }
                }
                const tcState = toolCalls[tc.index]

                if (tc.function?.name) tcState.name = tc.function.name

                if (!tcState.started) {
                  tcState.started = true
                  ws.send(JSON.stringify({
                    type: 'response.output_item.added',
                    item: { id: tcState.item_id, type: 'function_call', status: 'in_progress' },
                  }))
                }

                if (tc.function?.arguments) {
                  tcState.arguments += tc.function.arguments
                  ws.send(JSON.stringify({
                    type: 'response.function_call_arguments.delta',
                    delta: tc.function.arguments,
                    index: tc.index,
                    item_id: tcState.item_id,
                  }))
                }
              }
            }
          } catch { /* skip unparseable lines */ }
        }
      }

      // Complete text item
      if (textItemSent || fullText) {
        ws.send(JSON.stringify({ type: 'response.text.done', text: fullText, index: 0, item_id: textMsgId }))
        ws.send(JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: textMsgId, type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: fullText, annotations: [] }],
          },
        }))
      }

      // Complete tool call items
      for (const idx in toolCalls) {
        const tc = toolCalls[idx]
        ws.send(JSON.stringify({
          type: 'response.function_call_arguments.done',
          arguments: tc.arguments,
          index: Number(idx),
          item_id: tc.item_id,
        }))
        ws.send(JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: tc.item_id, type: 'function_call', status: 'completed',
            name: tc.name, arguments: tc.arguments,
          },
        }))
      }

      // Build output array for response.completed
      const output = []
      if (textItemSent || (!Object.keys(toolCalls).length && !textItemSent)) {
        output.push({
          id: textMsgId, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: fullText, annotations: [] }],
        })
      }
      for (const idx in toolCalls) {
        const tc = toolCalls[idx]
        output.push({
          id: tc.item_id, type: 'function_call', status: 'completed',
          name: tc.name, arguments: tc.arguments,
        })
      }

      ws.send(JSON.stringify({
        type: 'response.completed',
        response: { id: respId, object: 'response', status: 'completed', output },
      }))

      await new Promise(r => setTimeout(r, 50))
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: { message: err.message } }))
    }
    ws.close()
  })
}

// ---------- HTTP handler ----------

async function handleHTTP(body, res) {
  try {
    let messages = buildMessages(body)
    if (body.instructions) messages.unshift({ role: 'system', content: body.instructions })
    messages = normalizeMessages(messages)

    const bodyTemplate = {
      model: body.model || DEFAULT_MODEL,
      messages,
      max_tokens: body.max_output_tokens ?? 4096,
      temperature: body.temperature ?? 0.7,
    }
    if (body.tools?.length) bodyTemplate.tools = body.tools
    if (body.tool_choice) {
      bodyTemplate.tool_choice = isToolChoiceSpecific(body.tool_choice)
        ? { type: body.tool_choice.type || 'function', function: { name: body.tool_choice.name } }
        : body.tool_choice
    }

    if (body.stream) {
      bodyTemplate.stream = true
      const upstream = await callUpstream(bodyTemplate)
      if (upstream.statusCode >= 400) {
        res.writeHead(502)
        res.end(JSON.stringify({ error: `upstream ${upstream.statusCode}` }))
        return
      }
      const respId = `resp_${Date.now()}`
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const sse = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)
      sse('response.created', { type: 'response.created', response: { id: respId } })

      let fullText = '', buf = ''
      for await (const chunk of upstream) {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:') || t === 'data: [DONE]') continue
          try {
            const d = JSON.parse(t.slice(5).trim())
            const del = (d.choices?.[0]?.delta || d.choices?.[0])?.content || ''
            if (del) { fullText += del; sse('response.text.delta', { type: 'response.text.delta', delta: del, index: 0 }) }
          } catch {}
        }
      }
      sse('response.text.done', { type: 'response.text.done', text: fullText, index: 0 })
      sse('response.completed', {
        type: 'response.completed',
        response: { id: respId, output: [{ type: 'message', content: [{ type: 'output_text', text: fullText }] }] },
      })
      res.end()
    } else {
      bodyTemplate.stream = false
      const upstream = await callUpstream(bodyTemplate)
      const chunks = []
      for await (const c of upstream) chunks.push(c)
      if (upstream.statusCode >= 400) {
        res.writeHead(502)
        res.end(JSON.stringify({ error: `upstream ${upstream.statusCode}` }))
        return
      }
      const chatResp = JSON.parse(Buffer.concat(chunks).toString())
      const choice = chatResp.choices?.[0]?.message
      const output = []

      if (choice?.tool_calls?.length) {
        for (const tc of choice.tool_calls) {
          const fn = tc.function || {}
          output.push({
            id: tc.id, type: 'function_call', status: 'completed',
            name: fn.name || '', arguments: fn.arguments || '',
          })
        }
      }

      output.push({
        id: `msg_${Date.now()}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: choice?.content || '', annotations: [] }],
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `resp_${Date.now()}`, object: 'response', status: 'completed', output,
      }))
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

// ---------- Server ----------

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', name: 'codex-api-bridge' }))
    return
  }
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      handleHTTP(body, res)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }))
    }
  })
})

const wss = new WebSocketServer({ server, path: '/v1/responses' })
wss.on('connection', handleWS)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[codex-api-bridge] Listening on http://127.0.0.1:${PORT}/v1/responses`)
  console.log(`[codex-api-bridge] Target: ${UPSTREAM_URL.href}`)
})
