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
 *   BOARD_API_KEY   your key, from the board's Settings, API (required)
 *   BOARD_API_URL   defaults to https://slow-board.vercel.app
 */

import { createInterface } from 'node:readline'

const KEY = process.env.BOARD_API_KEY ?? ''
const BASE = (process.env.BOARD_API_URL ?? 'https://slow-board.vercel.app').replace(/\/+$/, '')
const VERSION = '1.0.0'
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

// ── the API ─────────────────────────────────────────────────────────────────

class ApiError extends Error {}

async function api(path, query = {}, body) {
  if (!/^cmk_[0-9a-f]{64}$/i.test(KEY)) {
    throw new ApiError('BOARD_API_KEY is not set, or is not a key. Make one in the board\'s Settings, under API, and put it in this server\'s env.')
  }
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const answer = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(answer.error ?? `The API answered ${res.status}.`)
  return answer
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
    // Ids in brackets, so draw can move, rename or remove what is already there.
    for (const c of it.columns ?? []) {
      parts.push(`## ${c.title || 'Untitled'} [${c.id}] (${c.cards.length})`)
      for (const card of c.cards) parts.push(`- [${card.id}] ${oneLine(card.text, 300) || 'Untitled'}${card.keywords?.length ? ` [${card.keywords.join(', ')}]` : ''}`)
      parts.push('')
    }
    return parts.join('\n')
  }

  if (it.kind === 'canvas') {
    const els = it.elements ?? []
    const byId = new Map(els.map((e) => [e.id, e]))
    const label = (id) => oneLine(byId.get(id)?.text, 60) || id
    // Each element with its id and box, so draw can connect to it, move it, or
    // place new things beside it. World units; x grows right, y grows down.
    const parts = [...head, `${els.length} elements.`, '', 'Elements [id] type at x,y wxh:']
    for (const e of els) {
      if (e.type === 'connector') continue
      const words = e.text?.trim() ? ` "${oneLine(e.text, 200)}"` : ''
      parts.push(`- [${e.id}] ${e.shape && e.type === 'shape' ? e.shape : e.type}${words} at ${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.w)}x${Math.round(e.h)}${e.keywords?.length ? ` [${e.keywords.join(', ')}]` : ''}${e.via_api ? ' (via API)' : ''}`)
    }
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

  // ── writing: needs a key made with "Allow writing" ─────────────────────────
  {
    name: 'create_discussion',
    description: 'Start a new discussion on a board, as the key\'s owner (marked via API). Choose the board by slug; body is Markdown. Answers with its number.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug from list_boards.'),
        title: str('The discussion\'s title.'),
        body: str('Its contents, in Markdown.'),
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to file it under.' },
      },
      required: ['board', 'title', 'body'],
      additionalProperties: false,
    },
    run: async ({ board, title, body, keywords }) => {
      const r = await api(`/api/v1/boards/${encodeURIComponent(board)}`, {}, { type: 'discussion', title, body, keywords })
      return `Made discussion #${r.number} on ${r.board}.`
    },
  },
  {
    name: 'create_surface',
    description: 'Make a new canvas or kanban on a board, named as you say. Answers with its number; then draw on it.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        kind: { type: 'string', enum: ['canvas', 'kanban'], description: 'A canvas (shapes, text, arrows) or a kanban (columns of cards).' },
        title: str('Its name, three characters or more.'),
      },
      required: ['board', 'kind', 'title'],
      additionalProperties: false,
    },
    run: async ({ board, kind, title }) => {
      const r = await api(`/api/v1/boards/${encodeURIComponent(board)}`, {}, { type: kind, title })
      return `Made ${r.kind} #${r.number} on ${r.board}. Draw on it with draw(board, ${r.number}, ops).`
    },
  },
  {
    name: 'reply',
    description: 'Reply to a discussion, as the key\'s owner (marked via API). Markdown body; title optional.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The discussion\'s number.'),
        body: str('The reply, in Markdown.'),
        title: str('An optional heading for a long reply.'),
      },
      required: ['board', 'number', 'body'],
      additionalProperties: false,
    },
    run: async ({ board, number, body, title }) => {
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'reply', body, title })
      return `Replied on #${number}.`
    },
  },
  {
    name: 'send_message',
    description: 'Write a line in a conversation, as the key\'s owner (marked via API): a board conversation by board and number, or a direct conversation by its id.',
    inputSchema: {
      type: 'object',
      properties: {
        body: str('The line.'),
        board: str('For a board conversation: the board slug.'),
        number: int('For a board conversation: its number.'),
        conversation_id: str('For a direct conversation: the id from list_conversations.'),
      },
      required: ['body'],
      additionalProperties: false,
    },
    run: async ({ body, board, number, conversation_id }) => {
      if (conversation_id) {
        await api(`/api/v1/conversations/${encodeURIComponent(conversation_id)}`, {}, { body })
        return 'Sent.'
      }
      if (!board || !number) throw new ApiError('Give board and number for a board conversation, or conversation_id for a direct one.')
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'message', body })
      return `Sent in #${number}.`
    },
  },
  {
    name: 'add_task',
    description: 'Add an action point -- who does what by when -- to a discussion, conversation, canvas or kanban by its number. The assignee is a person\'s name as the board shows it, or their email.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The number of the thing it belongs to.'),
        body: str('What needs doing.'),
        assignee: str('Who has it, by name or email. Optional.'),
        due: str('By when, YYYY-MM-DD. Optional.'),
      },
      required: ['board', 'number', 'body'],
      additionalProperties: false,
    },
    run: async ({ board, number, body, assignee, due }) => {
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'task', body, assignee, due })
      return `Added the action point to #${number}.`
    },
  },
  {
    name: 'draw',
    description: [
      'Draw on a canvas or kanban directly: real shapes, text, arrows, columns and cards that people can then move and edit -- not a picture.',
      'Canvas ops: {op:"shape", ref, text, shape?:"process"|"decision"|"terminator"|"data"|"ellipse"|"document"|"frame", x?, y?, w?:220, h?:110, fill?:"#rrggbb"}, {op:"text", ref, text, x, y, size?:16},',
      '{op:"connect", from, to, text?, dashed?, ends?:"arrow"|"none"|"double", route?:"elbow"|"straight"}, {op:"update", id, text?, x?, y?, w?, h?, fill?}, {op:"delete", id}, {op:"tag", id, keywords}.',
      'Kanban ops: {op:"column", ref, title}, {op:"card", ref, column (id, ref or title), text, keywords?}, {op:"move_card", card, column, index?}, {op:"update", id, text}, {op:"delete", id}.',
      'from/to/id/column take an element id from get_item or a ref made earlier in the same call. Shapes without x,y are laid out left to right by their arrows, beside what is already there.',
      'Coordinates are world units, x right, y down; boxes are about 220x110, so space them ~300 apart. Read the surface with get_item first to see what is there.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The canvas or kanban number.'),
        ops: { type: 'array', items: { type: 'object' }, description: 'The operations, in order. At most 200.' },
      },
      required: ['board', 'number', 'ops'],
      additionalProperties: false,
    },
    run: async ({ board, number, ops }) => {
      const r = await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'draw', ops })
      const refs = Object.entries(r.created ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
      return [`Drew on ${r.kind} #${number}: ${r.appended ?? 0} changes.`, refs ? `Refs: ${refs}` : '', ...(r.done ?? []).slice(0, 40).map((d) => `- ${d}`)].filter(Boolean).join('\n')
    },
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
              'Access to the board app, as the key\'s owner. Read: list_boards, list_items, get_item. Write (with a key allowed to write; everything written is marked via API): create_discussion, create_surface, reply, send_message, add_task, draw. Pick the board by slug and the thing by its number. To draw, read the surface with get_item first. Answers are cut at max_chars; ask for more with offset only when you need it.',
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
