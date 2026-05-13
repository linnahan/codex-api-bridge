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
const API_KEY = process.env.API_KEY || ''
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
    if (item.type !== 'message' || !item.role) continue
    const content = Array.isArray(item.content)
      ? item.content.map(extractText).join('')
      : (typeof item.content === 'string' ? item.content : '')
    if (content) msgs.push({ role: ROLE_MAP[item.role] || item.role, content })
  }
  return msgs
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

      const messages = buildMessages(msg)
      if (!messages.length) {
        ws.send(JSON.stringify({ type: 'error', error: { message: 'empty messages' } }))
        ws.close()
        return
      }

      const upstream = await callUpstream({
        model: msg.model || DEFAULT_MODEL,
        messages,
        max_tokens: msg.max_output_tokens ?? 4096,
        temperature: msg.temperature ?? 0.7,
        stream: true,
      })

      if (upstream.statusCode >= 400) {
        ws.send(JSON.stringify({ type: 'error', error: { message: `upstream ${upstream.statusCode}` } }))
        ws.close()
        return
      }

      const respId = `resp_${Date.now()}`
      const msgId = `msg_${Date.now()}`

      ws.send(JSON.stringify({
        type: 'response.created',
        response: { id: respId, object: 'response', status: 'in_progress' },
      }))
      ws.send(JSON.stringify({
        type: 'response.output_item.added',
        item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress' },
      }))
      ws.send(JSON.stringify({
        type: 'response.content_part.added',
        part: { type: 'text', text: '' },
        index: 0,
        item_id: msgId,
      }))

      let fullText = ''
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
            const delta = parsed.choices?.[0]?.delta?.content || ''
            if (delta) {
              fullText += delta
              ws.send(JSON.stringify({ type: 'response.text.delta', delta, index: 0, item_id: msgId }))
            }
          } catch { /* skip unparseable lines */ }
        }
      }

      ws.send(JSON.stringify({ type: 'response.text.done', text: fullText, index: 0, item_id: msgId }))
      ws.send(JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: msgId, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: fullText, annotations: [] }],
        },
      }))
      ws.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: respId, object: 'response', status: 'completed',
          output: [{
            id: msgId, type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: fullText, annotations: [] }],
          }],
        },
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
    const messages = buildMessages(body)
    if (body.stream) {
      const upstream = await callUpstream({
        model: body.model || DEFAULT_MODEL, messages,
        max_tokens: body.max_output_tokens ?? 4096,
        temperature: body.temperature ?? 0.7, stream: true,
      })
      if (upstream.statusCode >= 400) {
        res.writeHead(502)
        res.end(JSON.stringify({ error: `upstream ${upstream.statusCode}` }))
        return
      }
      const respId = `resp_${Date.now()}`
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const sse = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)
      sse('response.created', { type: 'response.created', response: { id: respId } })
      let ft = '', buf = ''
      for await (const chunk of upstream) {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:') || t === 'data: [DONE]') continue
          try {
            const d = JSON.parse(t.slice(5).trim())
            const del = d.choices?.[0]?.delta?.content || ''
            if (del) { ft += del; sse('response.text.delta', { type: 'response.text.delta', delta: del, index: 0 }) }
          } catch {}
        }
      }
      sse('response.text.done', { type: 'response.text.done', text: ft, index: 0 })
      sse('response.completed', { type: 'response.completed', response: { id: respId, output: [{ type: 'message', content: [{ type: 'output_text', text: ft }] }] } })
      res.end()
    } else {
      const upstream = await callUpstream({
        model: body.model || DEFAULT_MODEL, messages,
        max_tokens: body.max_output_tokens ?? 4096,
        temperature: body.temperature ?? 0.7, stream: false,
      })
      const chunks = []
      for await (const c of upstream) chunks.push(c)
      if (upstream.statusCode >= 400) {
        res.writeHead(502)
        res.end(JSON.stringify({ error: `upstream ${upstream.statusCode}` }))
        return
      }
      const chatResp = JSON.parse(Buffer.concat(chunks).toString())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `resp_${Date.now()}`, object: 'response', status: 'completed',
        output: [{
          id: `msg_${Date.now()}`, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: chatResp.choices?.[0]?.message?.content || '', annotations: [] }],
        }],
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
