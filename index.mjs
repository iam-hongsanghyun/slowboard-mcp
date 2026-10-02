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
const VERSION = '1.5.0'
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

const STATUS_LABEL = { preparing: 'Preparing', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', verified: 'Verified' }

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
      for (const card of c.cards) {
        // A card's progress: one track per person, each set only by that person.
        const status = card.progress?.length
          ? ` {${card.progress.map((p) => `${p.person}: ${STATUS_LABEL[p.status] ?? p.status}`).join('; ')}}`
          : ''
        parts.push(`- [${card.id}] ${oneLine(card.text, 300) || 'Untitled'}${status}${card.keywords?.length ? ` [${card.keywords.join(', ')}]` : ''}`)
      }
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
  if (!f.text_length) lines.push(String(f.mime).startsWith('image/') ? 'An image: no words inside.' : 'No text could be read from this file (a scanned PDF, or a format the board does not read).')
  else {
    lines.push(`Text (${offset}-${offset + (f.text?.length ?? 0)} of ${f.text_length} characters):`, '', f.text ?? '')
    if (f.next_offset != null) lines.push('', `[More: call read_file again with offset=${f.next_offset}.]`)
  }
  return lines.join('\n')
}

function catchUpText(r) {
  const items = r.items ?? []
  const since = String(r.since).slice(0, 16).replace('T', ' ')
  if (!items.length) return `Nothing new since ${since}.${r.moved_mark ? '' : ' (The read mark did not move.)'}`
  const lines = [`Since ${since}, oldest first: ${items.length} ${items.length === 1 ? 'thing' : 'things'} moved.`, '']
  for (const i of items) {
    lines.push(`- ${i.new ? 'new ' : ''}${i.kind} ${whereOf(i)}: ${i.title} -- ${i.by ?? 'someone'}, ${String(i.updated_at).slice(0, 16).replace('T', ' ')}`)
    if (i.excerpt) lines.push(`    ${oneLine(i.excerpt, 140)}`)
  }
  lines.push('', r.moved_mark
    ? `Read mark moved to ${String(r.read_to).slice(0, 19).replace('T', ' ')}.${r.more ? ' More is waiting: call catch_up again.' : ''}`
    : `Read mark not moved (a peek, or narrowed to one board).${r.more ? ' More is waiting.' : ''}`)
  return lines.join('\n')
}

function changesText(r) {
  const out = [`What this key wrote since ${String(r.since).slice(0, 16).replace('T', ' ')}:`]
  const section = (title, list, line) => { if (list?.length) out.push('', `${title}:`, ...list.map(line)) }
  section('Surfaces drawn on', r.surfaces, (s) => `- ${s.kind} ${whereOf(s)}: ${s.title} -- ${s.changes} changes, ${String(s.first_at).slice(0, 16).replace('T', ' ')} to ${String(s.last_at).slice(11, 16)}`)
  section('Action points changed', r.actions_changed, (a) => `- [${a.id}] [${a.state}] ${a.body} -- ${a.changes} changes${a.place ? `, on ${whereOf(a.place)}` : ''}`)
  section('Action points raised', r.actions_raised, (a) => `- [${a.id}] [${a.state}] ${a.body}${a.place ? `, on ${whereOf(a.place)}` : ''}`)
  section('Discussions started', r.discussions, (d) => `- ${whereOf(d)}: ${d.title}`)
  section('Replies', r.replies, (d) => `- [${d.id}] on ${whereOf(d)}: ${oneLine(d.excerpt, 100)}`)
  section('Lines', r.lines, (m) => `- [${m.id}] in ${whereOf(m)}: ${oneLine(m.excerpt, 100)}`)
  if (out.length === 1) out.push('Nothing.')
  return out.join('\n')
}

function revertText(r) {
  const out = [r.applied ? 'Taken back:' : 'Would take back (nothing changed yet -- call again with apply: true):']
  for (const s of r.surfaces ?? []) {
    out.push(`- ${s.kind} ${whereOf(s)}: ${s.title} -- ${s.undone} ${s.undone === 1 ? 'change' : 'changes'}${s.appended ? `, ${s.appended} events appended` : ''}`)
    for (const k of s.skipped ?? []) out.push(`    left alone: ${k}`)
  }
  const a = r.actions
  if (a) {
    for (const x of a.restored ?? []) out.push(`- action [${x.id}] put back to: [${x.state}] ${x.body}`)
    for (const x of a.dropped ?? []) out.push(`- action [${x.id}] dropped (this key raised it): ${x.body}`)
    for (const x of a.skipped ?? []) out.push(`- action [${x.id}] left alone (${x.why}): ${x.body}`)
  }
  if (out.length === 1) out.push('Nothing to take back.')
  if ((r.surfaces ?? []).some((s) => s.skipped?.length) || a?.skipped?.length) out.push('', 'Left-alone items were changed by someone else since; force: true takes them back anyway.')
  return out.join('\n')
}

function briefText(r) {
  const out = [`Brief: ${r.subject}`]
  const thing = (t, indent = '') => {
    const lines = [`${indent}${t.kind} ${whereOf(t)}: ${t.title}${t.keywords?.length ? ` [${t.keywords.join(', ')}]` : ''}${t.by ? ` -- ${t.by}, ${day(t.created_at)}` : ''}`]
    if (t.body) lines.push('', t.body)
    if (t.latest_replies?.length) {
      lines.push('', `Latest replies (${t.latest_replies.length} of ${t.replies_total}):`)
      for (const x of t.latest_replies) lines.push(`- ${x.by ?? 'someone'}, ${day(x.at)}${x.title ? ` -- ${x.title}` : ''}: ${x.body ?? ''}`)
    }
    if (t.decisions?.length) lines.push('', 'Decided:', ...t.decisions.map((d) => `- ${d.summary} -- ${d.by}, ${day(d.at)}`))
    if (t.open_actions?.length) lines.push('', 'Still to do:', ...t.open_actions.map((a) => `- [${a.state}] ${a.body}${a.assignee ? ` -- ${a.assignee}` : ''}${a.due_on ? `, by ${a.due_on}` : ''}`))
    if (t.files?.length) lines.push('', `Files: ${t.files.map((f) => `${f.name} [${f.id}]`).join(', ')}`)
    if (t.columns) for (const c of t.columns) lines.push(`- ${c.title}: ${c.cards.join(' | ') || '(empty)'}`)
    if (t.text?.length) lines.push(`Text on it (${t.elements} elements): ${t.text.join(' | ')}`)
    if (t.latest_lines?.length) lines.push(...t.latest_lines.map((m) => `- ${m.by ?? 'someone'}, ${day(m.at)}: ${m.body}`))
    return lines.join('\n')
  }
  if (r.item) {
    out.push('', thing(r.item))
    if (r.referred_to_by?.length) out.push('', 'Referred to by:', ...r.referred_to_by.map((x) => `- ${x.kind} ${whereOf(x)}: ${x.title ?? ''} -- ${oneLine(x.snippet, 160)}`))
    for (const k of r.same_keywords ?? []) if (k.items?.length) out.push('', `Also under "${k.keyword}":`, ...k.items.map((i) => `- ${i.kind} ${i.kind === 'file' ? `[${i.id}]` : whereOf(i)}: ${i.title}`))
    return out.join('\n')
  }
  if (r.keyword) out.push('', `Filed under "${r.keyword.keyword}":`, ...r.keyword.items.map((i) => `- ${i.kind} ${i.kind === 'file' ? `[${i.id}]` : whereOf(i)}: ${i.title}`))
  if (r.discussions?.length) for (const d of r.discussions) out.push('', '---', thing(d))
  if (r.more_discussions?.length) out.push('', `More discussions on it: ${r.more_discussions.map((t) => `${t.board}#${t.number}`).join(', ')}`)
  if (r.decisions?.length) out.push('', 'Decisions mentioning it:', ...r.decisions.map((d) => `- ${d.summary} -- ${d.by}, ${day(d.decided_at)}, on ${whereOf(d.discussion)}`))
  if (r.open_actions?.length) out.push('', 'Open actions mentioning it:', ...r.open_actions.map((a) => `- [${a.id}] [${a.state}] ${a.body}${a.assignee ? ` -- ${a.assignee}` : ''}${a.place ? `, on ${whereOf(a.place)}` : ''}`))
  if (r.elsewhere?.length) out.push('', 'Elsewhere:', ...r.elsewhere.map((h) => `- ${h.kind}${h.id ? ` [${h.id}]` : ''} in ${whereOf(h)}: ${h.title ?? ''} -- ${oneLine(h.snippet, 160)}`))
  if (out.length === 1) out.push('', 'Nothing on the board mentions it.')
  return out.join('\n')
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
    name: 'open_ref',
    description:
      'One thing by its short address, as people paste it -- "questions#2", or "#2" with board -- whole, the same as get_item. A discussion that has moved since keeps its address and is followed to where it lives now. Use this for any board#number you meet in a post, a line, a card or a shape.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: str('The short address: board#number, or #number with board.'),
        board: str('The board a bare #number belongs to.'),
        max_chars: int('Cut the answer at this many characters, default 12000.'),
        offset: { type: 'integer', minimum: 0, description: 'Where to continue a cut answer from.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    run: async ({ ref, board, max_chars = 12000, offset = 0 }) => {
      const m = /^\s*([a-z0-9][a-z0-9-]*)?#(\d+)\s*$/.exec(String(ref))
      if (!m) throw new ApiError('A short address looks like questions#2, or #2 with board.')
      const where = m[1] ?? board
      if (!where) throw new ApiError(`"${ref}" names no board: pass board, or write it as board#number.`)
      return window(itemText(await api(`/api/v1/boards/${encodeURIComponent(where)}/items/${m[2]}`)), offset, max_chars)
    },
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
        look: { type: 'boolean', description: 'Also hand over the file itself (up to 8 MB), e.g. a scanned PDF. Images come as pictures anyway.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id, offset = 0, max_chars = 12000, look = false }) => {
      const f = await api(`/api/v1/files/${encodeURIComponent(id)}`, { offset, limit: max_chars })
      const text = fileText(f, offset)
      // An image is handed over as a picture, so the model sees it; so is any
      // file asked for with look, up to the size the API serves.
      const image = String(f.mime).startsWith('image/') && /^image\/(png|jpeg|gif|webp)$/.test(f.mime)
      if (!f.content || !(image || look)) return text
      try {
        const c = await api(`/api/v1/files/${encodeURIComponent(id)}/content`)
        if (image) return { content: [{ type: 'text', text }, { type: 'image', data: c.base64, mimeType: c.mime }] }
        return { content: [{ type: 'text', text }, { type: 'resource', resource: { uri: f.content, mimeType: c.mime, blob: c.base64 } }] }
      } catch (e) {
        return `${text}\n\n[The file itself could not be fetched: ${e.message}]`
      }
    },
  },
  {
    name: 'catch_up',
    description: 'What moved since this key last read, oldest first -- discussions, canvases, kanbans and conversations. The board remembers where the key read to: each call moves the mark to the last thing it hands over, so the next call gives only what is newer (or the next page). Start a session with this instead of recent. peek reads without moving the mark.',
    inputSchema: {
      type: 'object',
      properties: {
        board: str('Only this board (slug). A narrowed call never moves the mark.'),
        limit: int('How many, default 50, at most 200.'),
        peek: { type: 'boolean', description: 'Read without moving the mark.' },
      },
      additionalProperties: false,
    },
    run: async ({ board, limit, peek }) => catchUpText(await api('/api/v1/catch-up', { board, limit, peek: peek ? 1 : undefined })),
  },
  {
    name: 'set_read_mark',
    description: 'Put this key\'s read mark at a moment: back, to read again from there; left out, at now, to skip everything before.',
    inputSchema: { type: 'object', properties: { read_to: str('An ISO date or time. Default: now.') }, additionalProperties: false },
    run: async ({ read_to }) => {
      const r = await api('/api/v1/catch-up', {}, read_to ? { read_to } : {})
      return `Read mark set to ${String(r.read_to).slice(0, 19).replace('T', ' ')}.`
    },
  },
  {
    name: 'brief',
    description: 'Everything the board holds about one subject, condensed to read in one go. Give an address (surfaces#41) for that thing with what refers to it and what shares its keywords; or words for the discussions most about them (with latest replies, decisions and open actions), the decisions and open actions that mention them anywhere, and the matching surfaces, conversations and files. Use it to explain a topic or to pick up work on it.',
    inputSchema: {
      type: 'object',
      properties: {
        q: str('An address like surfaces#41, or the subject in words (Korean works).'),
        board: str('Only this board, or the board of a bare #41.'),
      },
      required: ['q'],
      additionalProperties: false,
    },
    run: async ({ q, board }) => briefText(await api('/api/v1/brief', { q, board })),
  },
  {
    name: 'my_changes',
    description: 'Everything this key wrote since a time (default a day ago): the canvases and kanbans it drew on and how much, the action points it changed or raised, the discussions, replies and lines it posted. Check it before revert, or to report what you did.',
    inputSchema: { type: 'object', properties: { since: str('An ISO date or time. Default: a day ago.') }, additionalProperties: false },
    run: async ({ since }) => changesText(await api('/api/v1/changes', { since })),
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
      'Kanban ops: {op:"column", ref, title}, {op:"card", ref, column (id, ref or title), text, keywords?}, {op:"move_card", card, column, index?}, {op:"update", id, text?, status?}, {op:"delete", id}.',
      'A card carries progress one person at a time, each person\'s own: {op:"update", id, status} sets yours -- preparing, in_progress, blocked, done, verified, or null to take yourself off the card. Nobody sets anyone else\'s. get_item shows everyone\'s in braces.',
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

  // ── editing: the same writing key, the same rule as on screen (0059) ──
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
    description: 'Rename a canvas or kanban -- any of them: a surface is everyone\'s. (Its contents are edited with draw: update, delete, move_card, on any element; every change is kept in its history.)',
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
    name: 'revert',
    description: 'Take changes back, safely. With since: everything this key changed after that time -- every canvas and kanban it drew on (the inverse is appended, as undo does; nothing leaves the history) and every action point it changed (put back) or raised (dropped). With since plus board and number: only on that surface. With at plus board and number: that canvas or kanban put back as it stood at that moment, whoever changed it since. Answers with what it would do and changes nothing unless apply is true -- look first. Anything someone else changed since is left alone and reported unless force. Posts and lines are not touched: they are their author\'s (see my_changes).',
    inputSchema: {
      type: 'object',
      properties: {
        since: str('Take back this key\'s changes after this ISO time.'),
        at: str('Put one surface back as it stood at this ISO time (needs board and number).'),
        board: str('The board slug of one surface.'),
        number: int('The canvas or kanban number.'),
        apply: { type: 'boolean', description: 'Actually do it. Without it, only says what would happen.' },
        force: { type: 'boolean', description: 'Take back even what someone else has changed since.' },
      },
      additionalProperties: false,
    },
    run: async (args) => revertText(await api('/api/v1/revert', {}, args)),
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
              'Access to the board app, as the key\'s owner. Start a session with catch_up: the board remembers where this key read to and hands over only what is newer. To explain or pick up a subject, brief (an address or words) gives everything on it in one call. Read: list_boards, list_items, get_item, open_ref (any board#number people paste, followed if it moved). Across boards: search (words anywhere, Korean included), recent (what moved since a time), list_actions, list_decisions, list_keywords, get_keyword, read_file (a file\'s words -- spreadsheets as tables, Hangul documents included -- and an image as a picture). To answer a question about the board, search first rather than walking every board. Write (with a key allowed to write; everything written is marked via API): create_discussion, create_surface, reply, send_message, add_task, draw. Edit (the same key, the same rule as on screen): edit_discussion, edit_reply and edit_message change only the owner\'s own posts and lines; update_task any action point where the owner may post (shared work, every change kept); a canvas or kanban is everyone\'s, so rename_surface and draw (update, delete, move_card) work on any of it, and every change is kept in its history. Safety: my_changes lists what this key wrote; revert takes it back (look first, then apply: true), or puts one surface back as it stood at a moment. By the [ids] get_item shows. Pick the board by slug and the thing by its number. To draw or edit, read it with get_item first. Answers are cut at max_chars; ask for more with offset only when you need it.',
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
          // A tool answers in text, or with its own content -- an image, a file.
          const out = await tool.run(params?.arguments ?? {})
          send({ id, result: typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out })
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
