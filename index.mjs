#!/usr/bin/env node
/**
 * slowboard-mcp: a local MCP server for Slow Board's API.
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
const VERSION = '1.3.0'
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

const edited = (x) => (x.edited_via_api ? ' (edited via API)' : x.edited_at ? ' (edited)' : '')

// Every line, reply and action point carries its id in brackets, so the edit
// tools can name it.
function linesText(messages, nextBefore) {
  const out = (messages ?? []).map((m) => `[${m.id}] ${m.by ?? 'someone'} (${String(m.posted_at).slice(0, 16).replace('T', ' ')}): ${m.body || '(a file)'}${edited(m)}`)
  if (nextBefore) out.unshift(`[Older lines exist: call again with before=${nextBefore}]`, '')
  return out.join('\n')
}

function actionsText(actions) {
  if (!actions?.length) return []
  return ['', 'Action points:', ...actions.map((a) => `- [${a.id}] [${a.state}] ${a.body}${a.assignee ? ` -- ${a.assignee}` : ''}${a.due_on ? `, by ${a.due_on}` : ''}${a.blocked_reason ? ` (blocked: ${a.blocked_reason})` : ''}`)]
}

function itemText(it) {
  if (it.merged_into) return `#${it.number} was merged into #${it.merged_into}. Fetch that one instead.`
  const head = [`#${it.number} ${it.kind}: ${it.title}`]
  if (it.keywords?.length) head.push(`Keywords: ${it.keywords.join(', ')}`)

  if (it.kind === 'discussion') {
    const parts = [...head, `By ${it.by ?? 'someone'}, ${day(it.created_at)}${it.edited_at ? `, edited ${day(it.edited_at)}${it.edited_via_api ? ' via API' : ''}` : ''}`, '', it.body ?? '']
    for (const r of it.replies ?? []) {
      parts.push('', `--- Reply [${r.id}] by ${r.by ?? 'someone'}, ${day(r.posted_at)}${r.reply_to ? ' (answering another reply)' : ''}${edited(r)}`)
      if (r.title) parts.push(`## ${r.title}`)
      parts.push(r.body ?? '')
    }
    if (it.decisions?.length) {
      parts.push('', 'Decisions:')
      for (const d of it.decisions) parts.push(`- ${d.withdrawn_at ? '(withdrawn) ' : ''}${d.summary} -- ${d.by ?? 'someone'}, ${day(d.decided_at)}`)
    }
    parts.push(...actionsText(it.actions))
    if (it.files?.length) {
      parts.push('', 'Files (open in the app, signed in):')
      for (const f of it.files) parts.push(`- ${f.name} (${f.mime}, ${f.bytes} bytes) ${f.url ?? ''}`)
    }
    return parts.join('\n')
  }

  if (it.kind === 'conversation' || it.kind === 'direct') {
    return [...head, '', linesText(it.messages, it.next_before), ...actionsText(it.actions)].join('\n')
  }

  if (it.kind === 'kanban') {
    const parts = [...head, '']
    // Ids in brackets, so draw can move, rename or remove what is already there.
    for (const c of it.columns ?? []) {
      parts.push(`## ${c.title || 'Untitled'} [${c.id}] (${c.cards.length})`)
      for (const card of c.cards) parts.push(`- [${card.id}] ${oneLine(card.text, 300) || 'Untitled'}${card.keywords?.length ? ` [${card.keywords.join(', ')}]` : ''}`)
      parts.push('')
    }
    parts.push(...actionsText(it.actions))
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
    parts.push(...actionsText(it.actions))
    return parts.join('\n')
  }
  return JSON.stringify(it)
}

// Where a result lives, as the other tools take it.
function whereOf(x) {
  if (x.conversation_id) return `direct conversation ${x.conversation_id}`
  if (x.board && x.number != null) return `${x.board} #${x.number}`
  return x.board ?? ''
}

function searchText(r) {
  const lines = [`Search: "${r.q}"${r.board ? ` on ${r.board}` : ''}`]
  if (r.keywords?.length) lines.push(`Keywords containing it: ${r.keywords.map((k) => `${k.keyword} (${k.uses})`).join(', ')} -- get_keyword lists what is filed under one.`)
  lines.push('')
  const results = r.results ?? []
  if (!results.length) lines.push('No matches.')
  for (const h of results) {
    const id = h.id ? ` [${h.id}]` : ''
    const head = h.kind === 'file' ? `file${id}: ${h.title} (${h.mime}, matched in the ${h.matched})` : `${h.kind}${id} in ${whereOf(h)}: ${h.title ?? ''}`
    lines.push(`- ${head} -- ${h.by ? `${h.by}, ` : ''}${day(h.at)}`)
    if (h.snippet && h.snippet !== h.title) lines.push(`    ${oneLine(h.snippet, 240)}`)
  }
  return lines.join('\n')
}

function recentText(r) {
  const items = r.items ?? []
  const lines = [`Since ${String(r.since).slice(0, 16).replace('T', ' ')}: ${items.length} ${items.length === 1 ? 'thing' : 'things'} moved.`, '']
  for (const i of items) {
    lines.push(`- ${i.new ? 'new ' : ''}${i.kind} ${whereOf(i)}: ${i.title} -- ${i.by ?? 'someone'}, active ${String(i.updated_at).slice(0, 16).replace('T', ' ')}`)
    if (i.excerpt) lines.push(`    ${oneLine(i.excerpt, 140)}`)
  }
  if (r.more) lines.push('', 'More moved than shown: narrow with board, or a later since.')
  return lines.join('\n')
}

function actionsListText(r) {
  const list = r.actions ?? []
  if (!list.length) return 'No action points.'
  return list
    .map((a) => `- [${a.id}] [${a.state}] ${a.body}${a.assignee ? ` -- ${a.assignee}` : ' -- nobody'}${a.due_on ? `, by ${a.due_on}` : ''}${a.blocked_reason ? ` (blocked: ${a.blocked_reason})` : ''} -- on ${a.place ? `${a.place.kind} ${whereOf(a.place)}: ${a.place.title}` : 'somewhere this key cannot see'}`)
    .join('\n')
}

function decisionsText(r) {
  const list = r.decisions ?? []
  if (!list.length) return 'No decisions recorded.'
  return list
    .map((d) => `- ${d.withdrawn_at ? `(withdrawn ${day(d.withdrawn_at)}) ` : ''}${d.summary} -- ${d.by ?? 'someone'}, ${day(d.decided_at)}, on ${d.discussion.board} #${d.discussion.number}: ${d.discussion.title}`)
    .join('\n')
}

function fileText(f, offset) {
  const lines = [`File [${f.id}]: ${f.name} (${f.mime}, ${f.bytes} bytes), ${f.by ?? 'someone'}, ${day(f.created_at)}`]
  if (f.place) lines.push(`On ${f.place.kind} ${whereOf(f.place)}: ${f.place.title}`)
  if (f.keywords?.length) lines.push(`Keywords: ${f.keywords.join(', ')}`)
  lines.push(`Open in the app (signed in): ${f.url}`, '')
  if (!f.text_length) lines.push('No text was extracted from this file (an image, or a format the board does not read).')
  else {
    lines.push(`Text (${offset}-${offset + (f.text?.length ?? 0)} of ${f.text_length} characters):`, '', f.text ?? '')
    if (f.next_offset != null) lines.push('', `[More: call read_file again with offset=${f.next_offset}.]`)
  }
  return lines.join('\n')
}

function conversationsText(r) {
  const list = r.conversations ?? []
  if (!list.length) return 'No direct conversations.'
  return list
    .map((c) => `- ${c.id}: ${c.title} -- ${(c.members ?? []).join(', ')}, last ${day(c.last_message_at)}`)
    .join('\n')
}

// ── the warehouse (0058): raw captures, records, the index ──────────────────

const via = (x) => (x.via_api ? ' via API' : '')

function indexText(ix) {
  const lines = [`Index of ${ix.board} (${ix.name})`, '']
  const counts = ix.records?.counts ?? []
  if (counts.length) {
    lines.push('Records by type and state: ' + counts.map((c) => `${c.type} ${c.state} ${c.count}`).join('; '), '')
  }
  const proposed = ix.records?.proposed ?? []
  lines.push(`Waiting for review (${proposed.length}) -- a person accepts or rejects these on screen:`)
  for (const r of proposed) lines.push(`- #${r.number} [${r.type}] ${r.title} -- ${r.author}${via(r)}, ${day(r.updated_at)}`)
  if (!proposed.length) lines.push('- nothing')
  const accepted = ix.records?.accepted ?? []
  lines.push('', `Accepted (${accepted.length}):`)
  for (const r of accepted) lines.push(`- #${r.number} [${r.type}] ${r.title}`)
  if (!accepted.length) lines.push('- nothing yet')
  const caps = ix.captures ?? []
  lines.push('', `Raw material, newest first (${caps.length}):`)
  for (const c of caps) lines.push(`- #${c.number} [${c.kind}] ${c.title} -- ${c.author}${via(c)}, ${day(c.created_at)}${c.records ? `, ${c.records} record(s) made from it` : ''}`)
  if (!caps.length) lines.push('- nothing yet')
  const dec = ix.decisions ?? []
  if (dec.length) {
    lines.push('', 'Decided:')
    for (const d of dec) lines.push(`- ${oneLine(d.summary, 160)} (#${d.number})`)
  }
  const acts = ix.actions ?? []
  if (acts.length) {
    lines.push('', 'Still to do:')
    for (const a of acts) lines.push(`- ${oneLine(a.body, 140)}${a.assignee ? ` -- ${a.assignee}` : ''}${a.due_on ? `, due ${a.due_on}` : ''}${a.state === 'blocked' ? ' (blocked)' : ''}`)
  }
  const kw = ix.keywords ?? []
  if (kw.length) lines.push('', 'Keywords: ' + kw.map((k) => `${k.keyword} (${k.count})`).join(', '))
  return lines.join('\n')
}

function capturesText(s) {
  const list = s.captures ?? []
  if (!list.length) return `No captures on ${s.board}.`
  return list
    .map((c) => `- #${c.number} [${c.kind}] ${c.title} -- ${c.author}${via(c)}, ${day(c.created_at)}, ${c.length} chars${c.records ? `, ${c.records} record(s)` : ''}${c.source ? `, from ${c.source}` : ''}\n  ${oneLine(c.excerpt, 200)}`)
    .join('\n')
}

function captureText(c) {
  const head = [
    `#${c.number} [${c.kind}] ${c.title}`,
    `${c.author}${via(c)}, captured ${day(c.created_at)}${c.occurred_at ? `, happened ${day(c.occurred_at)}` : ''}${c.source ? `, from ${c.source}` : ''}`,
    c.keywords?.length ? `Keywords: ${c.keywords.join(', ')}` : null,
    (c.records ?? []).length ? `Records made from it: ${c.records.map((r) => `#${r.number} ${r.type} "${r.title}" (${r.state})`).join('; ')}` : 'No records made from it yet.',
    '',
  ].filter((x) => x !== null)
  const tail = c.next_offset ? `\n\n[More: call get_capture again with offset=${c.next_offset}. ${c.length} characters in all.]` : ''
  return head.join('\n') + c.body + tail
}

function recordsText(s) {
  const list = s.records ?? []
  if (!list.length) return `No records on ${s.board} match.`
  return list
    .map((r) => `- #${r.number} [${r.type}] ${r.title} -- ${r.state}, ${r.author}${via(r)}, ${day(r.updated_at)}${r.capture ? `, from capture #${r.capture}` : ''}${r.keywords?.length ? ` {${r.keywords.join(', ')}}` : ''}`)
    .join('\n')
}

function recordText(r) {
  const lines = [
    `#${r.number} [${r.type}] ${r.title} -- ${r.state}`,
    `${r.author}${via(r)}, filed ${day(r.created_at)}, changed ${day(r.updated_at)}`,
  ]
  if (r.review) lines.push(`Reviewed by ${r.review.by}, ${day(r.review.at)}${r.review.note ? `: ${r.review.note}` : ''}`)
  if (r.capture) lines.push(`Made from capture #${r.capture.number} "${r.capture.title}"`)
  if (r.supersedes) lines.push(`Replaces #${r.supersedes}`)
  if (r.superseded_by) lines.push(`Replaced by #${r.superseded_by}`)
  if (r.keywords?.length) lines.push(`Keywords: ${r.keywords.join(', ')}`)
  lines.push('', 'Data:', JSON.stringify(r.data ?? {}, null, 2))
  if (r.body) lines.push('', 'Body:', r.body)
  return lines.join('\n')
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

  // ── across boards: the board as an archive ─────────────────────────────────
  {
    name: 'search',
    description:
      'Search everything the key can read for words: discussions (title and body), replies, canvases and kanbans (name and excerpt), conversations, lines, and files (name and the words inside). Korean works. Each hit gives where it is (board #number, or a reply/line/file id) and the text around the match; open one with get_item or read_file.',
    inputSchema: {
      type: 'object',
      properties: {
        q: str('The words, two characters or more. Matched as written, not as a pattern.'),
        board: str('Only this board (slug).'),
        kind: { type: 'string', enum: ['discussion', 'reply', 'canvas', 'kanban', 'conversation', 'line', 'file'], description: 'Only this kind.' },
        limit: int('Hits per kind, default 10, at most 50.'),
      },
      required: ['q'],
      additionalProperties: false,
    },
    run: async ({ q, board, kind, limit }) => searchText(await api('/api/v1/search', { q, board, kind, limit })),
  },
  {
    name: 'recent',
    description: 'What moved since a time, across every board the key reaches and your direct conversations: what is new and what changed. Use it to catch up.',
    inputSchema: {
      type: 'object',
      properties: {
        since: str('An ISO date or time, like 2026-09-20. Default: a week ago.'),
        board: str('Only this board (slug).'),
        limit: int('How many, default 50, at most 200.'),
      },
      additionalProperties: false,
    },
    run: async ({ since, board, limit }) => recentText(await api('/api/v1/recent', { since, board, limit })),
  },
  {
    name: 'list_actions',
    description: 'Action points across boards -- who does what by when -- each with where it lives and its [id] for update_task. By default only what is still to do.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'blocked', 'done', 'dropped', 'all'], description: 'Default: open and blocked.' },
        assignee: str('"me", or a person\'s name or email.'),
        board: str('Only this board (slug).'),
        limit: int('How many, default 100.'),
      },
      additionalProperties: false,
    },
    run: async ({ state, assignee, board, limit }) => actionsListText(await api('/api/v1/actions', { state, assignee, board, limit })),
  },
  {
    name: 'list_decisions',
    description: 'The decision log: what was decided, by whom, when, and on which discussion. Newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('Only this board (slug).'),
        withdrawn: { type: 'boolean', description: 'Include decisions that were later withdrawn.' },
        limit: int('How many, default 100.'),
      },
      additionalProperties: false,
    },
    run: async ({ board, withdrawn, limit }) => decisionsText(await api('/api/v1/decisions', { board, withdrawn: withdrawn ? 1 : undefined, limit })),
  },
  {
    name: 'list_keywords',
    description: 'Every keyword things are filed under, with how many carry it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await api('/api/v1/keywords')
      return (r.keywords ?? []).length ? r.keywords.map((k) => `${k.keyword} (${k.uses})`).join(', ') : 'No keywords yet.'
    },
  },
  {
    name: 'get_keyword',
    description: 'Everything filed under one keyword: discussions, canvases, kanbans, conversations and files.',
    inputSchema: { type: 'object', properties: { keyword: str('The keyword.') }, required: ['keyword'], additionalProperties: false },
    run: async ({ keyword }) => {
      const r = await api(`/api/v1/keywords/${encodeURIComponent(keyword)}`)
      const items = r.items ?? []
      if (!items.length) return `Nothing is filed under "${r.keyword}".`
      return [`Filed under "${r.keyword}":`, ...items.map((i) => (i.kind === 'file' ? `- file [${i.id}]: ${i.title}` : `- ${i.kind} ${whereOf(i)}: ${i.title}`))].join('\n')
    },
  },
  {
    name: 'read_file',
    description: 'A file\'s details and the words extracted from inside it (a PDF\'s or a text file\'s), by the id search, get_item or get_keyword gives. Long text comes in windows; pass offset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('The file id.'),
        offset: { type: 'integer', minimum: 0, description: 'Where to continue from, in characters.' },
        max_chars: int('How much text, default 12000.'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id, offset = 0, max_chars = 12000 }) => fileText(await api(`/api/v1/files/${encodeURIComponent(id)}`, { offset, limit: max_chars }), offset),
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
      'Changing the text of, or deleting, an element someone else made is refused; moving, resizing, tagging and moving cards are allowed.',
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

  // ── editing: the same writing key; only what the owner could edit on screen ──
  {
    name: 'edit_discussion',
    description: 'Edit one of the owner\'s own discussions: title, body or keywords (marked edited via API). Other people\'s are refused, even for a curator. Give only what changes; the rest stays. Earlier versions are kept.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The discussion\'s number.'),
        title: str('A new title.'),
        body: str('The whole new body, in Markdown.'),
        keywords: { type: 'array', items: { type: 'string' }, description: 'The full new keyword list.' },
      },
      required: ['board', 'number'],
      additionalProperties: false,
    },
    run: async ({ board, number, title, body, keywords }) => {
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'edit', title, body, keywords })
      return `Edited #${number}.`
    },
  },
  {
    name: 'edit_reply',
    description: 'Edit one of the owner\'s replies on a discussion, by the reply id get_item shows in brackets.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The discussion\'s number.'),
        reply_id: str('The reply\'s id, from get_item.'),
        body: str('The whole new reply, in Markdown.'),
        title: str('A new heading; an empty string removes it.'),
      },
      required: ['board', 'number', 'reply_id'],
      additionalProperties: false,
    },
    run: async ({ board, number, reply_id, body, title }) => {
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'edit_reply', reply_id, body, title })
      return `Edited the reply on #${number}.`
    },
  },
  {
    name: 'edit_message',
    description: 'Edit one of the owner\'s lines, by the id get_item or get_conversation shows in brackets: in a board conversation (board and number) or a direct one (conversation_id).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: str('The line\'s id.'),
        body: str('The new line.'),
        board: str('For a board conversation: the board slug.'),
        number: int('For a board conversation: its number.'),
        conversation_id: str('For a direct conversation: its id.'),
      },
      required: ['message_id', 'body'],
      additionalProperties: false,
    },
    run: async ({ message_id, body, board, number, conversation_id }) => {
      if (conversation_id) {
        await api(`/api/v1/conversations/${encodeURIComponent(conversation_id)}`, {}, { action: 'edit', message_id, body })
        return 'Edited the line.'
      }
      if (!board || !number) throw new ApiError('Give board and number for a board conversation, or conversation_id for a direct one.')
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'edit_message', message_id, body })
      return `Edited the line in #${number}.`
    },
  },
  {
    name: 'update_task',
    description: 'Change an action point, by the id get_item shows in brackets: its state (open, blocked -- which needs blocked_reason --, done, dropped), what it says, who has it, or by when. Give only what changes. assignee "" unassigns; due "" clears the date.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug the action point is on.'),
        number: int('The number of the thing it belongs to.'),
        task_id: str('The action point\'s id.'),
        state: { type: 'string', enum: ['open', 'blocked', 'done', 'dropped'], description: 'Its new state.' },
        blocked_reason: str('What is blocking it; required when state is blocked.'),
        body: str('What needs doing, reworded.'),
        assignee: str('Who has it now, by name or email; "" for nobody.'),
        due: str('By when, YYYY-MM-DD; "" to clear.'),
      },
      required: ['board', 'number', 'task_id'],
      additionalProperties: false,
    },
    run: async ({ board, number, task_id, state, blocked_reason, body, assignee, due }) => {
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, {
        action: 'update_task', task_id, state, blocked_reason, body,
        assignee: assignee === '' ? null : assignee,
        due: due === '' ? null : due,
      })
      return `Updated the action point on #${number}.`
    },
  },
  {
    name: 'rename_surface',
    description: 'Rename a canvas or kanban. (Its contents are edited with draw: update, delete, move_card.)',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The canvas or kanban number.'),
        title: str('The new name, three characters or more.'),
      },
      required: ['board', 'number', 'title'],
      additionalProperties: false,
    },
    run: async ({ board, number, title }) => {
      await api(`/api/v1/boards/${encodeURIComponent(board)}/items/${number}`, {}, { action: 'rename', title })
      return `Renamed #${number}.`
    },
  },
  {
    name: 'board_index',
    description: 'A board\'s index: records by type and state, proposals waiting for review, accepted records, recent raw material and what came of it, decisions, open actions, keywords. Read this first to get your bearings on a board before capturing or filing.',
    inputSchema: { type: 'object', properties: { board: str('The board slug.') }, required: ['board'], additionalProperties: false },
    run: async ({ board }) => indexText(await api(`/api/v1/boards/${encodeURIComponent(board)}/index`)),
  },
  {
    name: 'capture',
    description: 'Put raw material into a board as it came: a meeting transcript, notes, a document\'s text, a link, a chat excerpt, or your own working note (kind "agent"). Kept as written; records made later point back to it. Answers with its number.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        title: str('A short title.'),
        body: str('The material itself, as it came.'),
        kind: { type: 'string', enum: ['transcript', 'note', 'document', 'link', 'chat', 'agent'], description: 'What it is, default note.' },
        source: str('Where it came from: a URL, a file name, "Zoom 22 Sep".'),
        occurred_at: str('When the thing itself happened, ISO time.'),
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to file it under.' },
      },
      required: ['board', 'title', 'body'],
      additionalProperties: false,
    },
    run: async ({ board, ...rest }) => {
      const out = await api(`/api/v1/boards/${encodeURIComponent(board)}/captures`, {}, rest)
      return `Captured as #${out.number} on ${out.board}.`
    },
  },
  {
    name: 'list_captures',
    description: 'The raw material on a board, newest first: number, kind, title, how long, how many records came of it, a line of excerpt.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        kind: { type: 'string', enum: ['transcript', 'note', 'document', 'link', 'chat', 'agent'], description: 'Only this kind.' },
        keyword: str('Only what carries this keyword.'),
        limit: int('How many, default 30, at most 200.'),
        before: str('A created_at from the last page, for the next.'),
      },
      required: ['board'],
      additionalProperties: false,
    },
    run: async ({ board, kind, keyword, limit, before }) =>
      capturesText(await api(`/api/v1/boards/${encodeURIComponent(board)}/captures`, { kind, keyword, limit, before })),
  },
  {
    name: 'get_capture',
    description: 'One capture whole, with the records made from it. A long one comes in windows: pass offset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The capture\'s number.'),
        offset: { type: 'integer', minimum: 0, description: 'Where to continue a long one from.' },
        max_chars: int('Characters per window, default 20000.'),
      },
      required: ['board', 'number'],
      additionalProperties: false,
    },
    run: async ({ board, number, offset = 0, max_chars = 20000 }) =>
      captureText(await api(`/api/v1/boards/${encodeURIComponent(board)}/captures/${number}`, { offset, limit: max_chars })),
  },
  {
    name: 'file_record',
    description: 'Propose a structured record on a board: a type word (decision, action, summary, policy, entity, edge, ... -- reuse the types board_index lists), a title, JSON data and a Markdown body. Name the capture it was made from, and the accepted record it would replace, if any. It is a proposal: a person accepts or rejects it on screen; you cannot.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        type: str('One lower-case word: letters, digits, - or _.'),
        title: str('A short title.'),
        data: { type: 'object', description: 'The structured part, a JSON object.' },
        body: str('The prose part, Markdown.'),
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to file it under.' },
        capture: int('The number of the capture it was made from.'),
        supersedes: int('The number of an accepted record this would replace.'),
      },
      required: ['board', 'type', 'title'],
      additionalProperties: false,
    },
    run: async ({ board, ...rest }) => {
      const out = await api(`/api/v1/boards/${encodeURIComponent(board)}/records`, {}, rest)
      return `Proposed as #${out.number} on ${out.board}. It waits for a person to accept or reject it.`
    },
  },
  {
    name: 'list_records',
    description: 'The records on a board, most recently changed first: number, type, title, state, author, the capture it came from. Filter by type, state (proposed, accepted, rejected, superseded) or keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        type: str('Only this type.'),
        state: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'superseded'], description: 'Only this state.' },
        keyword: str('Only what carries this keyword.'),
        limit: int('How many, default 50, at most 200.'),
      },
      required: ['board'],
      additionalProperties: false,
    },
    run: async ({ board, type, state, keyword, limit }) =>
      recordsText(await api(`/api/v1/boards/${encodeURIComponent(board)}/records`, { type, state, keyword, limit })),
  },
  {
    name: 'get_record',
    description: 'One record whole: data, body, state, who reviewed it, the capture it came from, what it replaces or was replaced by.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The record\'s number.'),
        max_chars: int('Cut the answer at this many characters, default 12000.'),
        offset: { type: 'integer', minimum: 0, description: 'Where to continue a cut answer from.' },
      },
      required: ['board', 'number'],
      additionalProperties: false,
    },
    run: async ({ board, number, max_chars = 12000, offset = 0 }) =>
      window(recordText(await api(`/api/v1/boards/${encodeURIComponent(board)}/records/${number}`)), offset, max_chars),
  },
  {
    name: 'edit_record',
    description: 'Revise one of your own proposals before anyone has reviewed it. Give only what changes. An accepted record is not yours to change: propose a new one that supersedes it.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('The board slug.'),
        number: int('The record\'s number.'),
        title: str('A new title.'),
        data: { type: 'object', description: 'The whole new data object.' },
        body: str('The whole new body.'),
        keywords: { type: 'array', items: { type: 'string' }, description: 'The full new keyword list.' },
      },
      required: ['board', 'number'],
      additionalProperties: false,
    },
    run: async ({ board, number, ...rest }) => {
      await api(`/api/v1/boards/${encodeURIComponent(board)}/records/${number}`, {}, rest)
      return `Revised proposal #${number}.`
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
              'Access to the board app, as the key\'s owner. Read: list_boards, list_items, get_item. Across boards: search (words anywhere, Korean included), recent (what moved since a time), list_actions, list_decisions, list_keywords, get_keyword, read_file (a file\'s extracted text). To answer a question about the board, search first rather than walking every board. Write (with a key allowed to write; everything written is marked via API): create_discussion, create_surface, reply, send_message, add_task, draw. Edit (the same key; only the owner\'s own words): edit_discussion, edit_reply, edit_message, update_task, rename_surface -- by the [ids] get_item shows. The warehouse, board by board: board_index first; capture puts raw material in as it came (transcripts, notes, documents); file_record proposes structured records made from it (a person accepts or rejects them on screen -- you cannot); list_captures, get_capture, list_records, get_record read them; edit_record revises your own proposal before review. Pick the board by slug and the thing by its number. To draw or edit, read it with get_item first. Answers are cut at max_chars; ask for more with offset only when you need it.',
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
