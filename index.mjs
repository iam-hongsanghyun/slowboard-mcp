#!/usr/bin/env node
/**
 * slowboard-mcp: a local MCP server for Slow Board's read-only API.
 *
 * It runs on your own machine, started by Claude Code or Claude Desktop, and talks
 * to them over stdin/stdout. When Claude calls a tool it makes one short HTTPS
 * request to /api/v1 and returns. Nothing stays open on the server side: an MCP
 * hosted on Vercel over SSE held a function open for as long as the client stayed
 * connected, and every idle minute of that was billed compute. Here there is no
 * hosted MCP at all -- each tool call costs one API call, and a key may make 120 a
 * minute.
 *
 * Answers are short text rather than raw JSON, because every character a tool
 * returns is read by the model: lists give titles and a line of excerpt, one thing
 * is given whole but cut at `max_chars` with an offset to continue, and a canvas
 * is its elements' text, not its event log.
 *
 * No dependencies: Node 18 or later, for the built-in fetch.
 *
 *   BOARD_API_KEY   your key, from the API page (required)
 *   BOARD_API_URL   defaults to https://slow-board.vercel.app
 */

import { createInterface } from 'node:readline'

const KEY = process.env.BOARD_API_KEY ?? ''
const BASE = (process.env.BOARD_API_URL ?? 'https://slow-board.vercel.app').replace(/\/+$/, '')
const VERSION = '1.0.0'
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

// ── the API ─────────────────────────────────────────────────────────────────

class ApiError extends Error {}

async function api(path, query = {}) {
  if (!/^cmk_[0-9a-f]{64}$/i.test(KEY)) {
    throw new ApiError('BOARD_API_KEY is not set, or is not a key. Make one on the API page and put it in this server\'s env.')
  }
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(body.error ?? `The API answered ${res.status}.`)
  return body
}

// ── turning answers into short text ─────────────────────────────────────────

const day = (iso) => (iso ? String(iso).slice(0, 10) : '')
const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** Cut long text at a boundary and say how to get the rest. */
function window(text, offset, max) {
  const start = Math.max(0, offset | 0)
  const slice = text.slice(start, start + max)
  const end = start + slice.length
  return end < text.length
    ? `${slice}\n\n[Cut at ${end} of ${text.length} characters. Call again with offset=${end} for the rest.]`
    : slice
}

function boardsText(s) {
  const lines = [`Organisation: ${s.organisation?.name ?? ''}`, '', 'Boards (use the slug in other tools):']
  for (const b of s.boards ?? []) {
    const n = (count, one, many) => (count ? `${count} ${count === 1 ? one : many}` : null)
    const counts = [
      n(b.discussions, 'discussion', 'discussions') ?? 'no discussions',
      n(b.canvases, 'canvas', 'canvases'),
      n(b.kanbans, 'kanban', 'kanbans'),
      n(b.conversations, 'conversation', 'conversations'),
    ].filter(Boolean).join(', ')
    lines.push(`- ${b.slug} (${b.name}): ${counts}${b.purpose ? ` -- ${oneLine(b.purpose, 100)}` : ''}`)
  }
  if (s.direct_conversations) lines.push('', `Direct conversations you are in: ${s.direct_conversations} (list_conversations).`)
  return lines.join('\n')
}

function itemsText(r) {
  const lines = [`Board: ${r.board?.slug} (${r.board?.name})`, '']
  for (const i of r.items ?? []) {
    const kw = i.keywords?.length ? ` [${i.keywords.join(', ')}]` : ''
    lines.push(`#${i.number} ${i.kind}: ${i.title}${kw} -- ${i.by ?? 'someone'}, active ${day(i.updated_at)}`)
    if (i.excerpt) lines.push(`    ${oneLine(i.excerpt, 140)}`)
  }
  if (!r.items?.length) lines.push('Nothing here.')
  if (r.next_before) lines.push('', `More: call again with before=${r.next_before}`)
  return lines.join('\n')
}

function linesText(messages, nextBefore) {
  const out = (messages ?? []).map((m) => `${m.by ?? 'someone'} (${String(m.posted_at).slice(0, 16).replace('T', ' ')}): ${m.body || '(a file)'}`)
  if (nextBefore) out.unshift(`[Older lines exist: call again with before=${nextBefore}]`, '')
  return out.join('\n')
}

function itemText(it) {
  if (it.merged_into) return `#${it.number} was merged into #${it.merged_into}. Fetch that one instead.`
  const head = [`#${it.number} ${it.kind}: ${it.title}`]
  if (it.keywords?.length) head.push(`Keywords: ${it.keywords.join(', ')}`)

  if (it.kind === 'discussion') {
    const parts = [...head, `By ${it.by ?? 'someone'}, ${day(it.created_at)}${it.edited_at ? `, edited ${day(it.edited_at)}` : ''}`, '', it.body ?? '']
    for (const r of it.replies ?? []) {
      parts.push('', `--- Reply by ${r.by ?? 'someone'}, ${day(r.posted_at)}${r.reply_to ? ' (answering another reply)' : ''}`)
      if (r.title) parts.push(`## ${r.title}`)
      parts.push(r.body ?? '')
    }
    if (it.decisions?.length) {
      parts.push('', 'Decisions:')
      for (const d of it.decisions) parts.push(`- ${d.withdrawn_at ? '(withdrawn) ' : ''}${d.summary} -- ${d.by ?? 'someone'}, ${day(d.decided_at)}`)
    }
    if (it.actions?.length) {
      parts.push('', 'Action points:')
      for (const a of it.actions) parts.push(`- [${a.state}] ${a.body}${a.assignee ? ` -- ${a.assignee}` : ''}${a.due_on ? `, by ${a.due_on}` : ''}${a.blocked_reason ? ` (blocked: ${a.blocked_reason})` : ''}`)
    }
    if (it.files?.length) {
      parts.push('', 'Files (open in the app, signed in):')
      for (const f of it.files) parts.push(`- ${f.name} (${f.mime}, ${f.bytes} bytes) ${f.url ?? ''}`)
    }
    return parts.join('\n')
  }

  if (it.kind === 'conversation' || it.kind === 'direct') {
    return [...head, '', linesText(it.messages, it.next_before)].join('\n')
  }

  if (it.kind === 'kanban') {
    const parts = [...head, '']
    for (const c of it.columns ?? []) {
      parts.push(`## ${c.title || 'Untitled'} (${c.cards.length})`)
      for (const card of c.cards) parts.push(`- ${oneLine(card.text, 300) || 'Untitled'}${card.keywords?.length ? ` [${card.keywords.join(', ')}]` : ''}`)
      parts.push('')
    }
    return parts.join('\n')
  }

  if (it.kind === 'canvas') {
    const els = it.elements ?? []
    const byId = new Map(els.map((e) => [e.id, e]))
    const label = (id) => oneLine(byId.get(id)?.text, 60) || id
    const parts = [...head, `${els.length} elements.`, '', 'Text on it:']
    for (const e of els) if (e.type !== 'connector' && e.text?.trim()) parts.push(`- ${oneLine(e.text, 300)}${e.keywords?.length ? ` [${e.keywords.join(', ')}]` : ''}`)
    const links = els.filter((e) => e.type === 'connector' && e.from && e.to)
    if (links.length) {
      parts.push('', 'Arrows:')
      for (const l of links) parts.push(`- ${label(l.from)} -> ${label(l.to)}${l.text ? ` (${oneLine(l.text, 60)})` : ''}`)
    }
    return parts.join('\n')
  }
  return JSON.stringify(it)
}

function conversationsText(r) {
  const list = r.conversations ?? []
  if (!list.length) return 'No direct conversations.'
  return list
    .map((c) => `- ${c.id}: ${c.title} -- ${(c.members ?? []).join(', ')}, last ${day(c.last_message_at)}`)
    .join('\n')
}

// ── the tools ───────────────────────────────────────────────────────────────

const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'integer', minimum: 1, description })

const TOOLS = [
  {
    name: 'list_boards',
    description: 'The organisation and its boards: slug, name, and how many discussions, canvases, kanbans and conversations each holds. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => boardsText(await api('/api/v1')),
  },
  {
    name: 'list_items',
    description: 'What is on one board, most recently active first: number, kind, title, a line of excerpt. Use the number with get_item.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug from list_boards.'),
        kind: { type: 'string', enum: ['discussion', 'canvas', 'kanban', 'conversation'], description: 'Only this kind.' },
        limit: int('How many, default 20, at most 200.'),
        before: str('The cursor from a previous answer, for the next page.'),
      },
      required: ['board'],
      additionalProperties: false,
    },
    run: async ({ board, kind, limit = 20, before }) =>
      itemsText(await api(`/api/v1/boards/${encodeURIComponent(board)}`, { kind, limit, before })),
  },
  {
    name: 'get_item',
    description:
      'One thing on a board, whole: a discussion with its replies, decisions, action points and files; a conversation\'s lines; a kanban\'s columns and cards; a canvas\'s text and arrows. Long answers are cut; pass offset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The number shown as #41 on the board.'),
        max_chars: int('Cut the answer at this many characters, default 12000.'),
        offset: { type: 'integer', minimum: 0, description: 'Where to continue a cut answer from.' },
        before: str('For a conversation: the cursor for older lines.'),
        limit: int('For a conversation: how many lines, default 150.'),
      },
      required: ['board', 'number'],
      additionalProperties: false,
    },
    run: async ({ board, number, max_chars = 12000, offset = 0, before, limit = 150 }) =>
      window(itemText(await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, { before, limit })), offset, max_chars),
  },
  {
    name: 'list_conversations',
    description: 'Your direct conversations: id, title, members, when it last moved. Use the id with get_conversation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => conversationsText(await api('/api/v1/conversations')),
  },
  {
    name: 'get_conversation',
    description: 'One direct conversation, line by line, newest page. Pass before for older lines.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('The conversation id from list_conversations.'),
        limit: int('How many lines, default 150.'),
        before: str('The cursor for older lines.'),
        max_chars: int('Cut the answer at this many characters, default 12000.'),
        offset: { type: 'integer', minimum: 0, description: 'Where to continue a cut answer from.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id, limit = 150, before, max_chars = 12000, offset = 0 }) =>
      window(itemText(await api(`/api/v1/conversations/${encodeURIComponent(id)}`, { limit, before })), offset, max_chars),
  },
]

// ── the protocol: JSON-RPC 2.0, one message per line on stdin/stdout ────────

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        send({
          id,
          result: {
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'board', version: VERSION },
            instructions:
              'Read-only access to the board app. Start with list_boards, then list_items for a board, then get_item for the numbers that matter. Answers are cut at max_chars; ask for more with offset only when you need it.',
          },
        })
        return
      }
      case 'ping':
        if (isRequest) send({ id, result: {} })
        return
      case 'tools/list':
        // Everything but `run`, which is this file's, not the protocol's.
        send({ id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } })
        return
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name)
        if (!tool) {
          send({ id, error: { code: -32602, message: `No tool called ${params?.name}.` } })
          return
        }
        try {
          const text = await tool.run(params?.arguments ?? {})
          send({ id, result: { content: [{ type: 'text', text }] } })
        } catch (e) {
          // A refusal the model can read and act on, not a protocol error.
          const text = e instanceof ApiError ? e.message : `The request failed: ${e?.message ?? e}`
          send({ id, result: { content: [{ type: 'text', text }], isError: true } })
        }
        return
      }
      default:
        if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (e) {
    if (isRequest) send({ id, error: { code: -32603, message: String(e?.message ?? e) } })
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  void handle(msg)
})
rl.on('close', () => process.exit(0))
