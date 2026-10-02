# slowboard-mcp

A local MCP server that lets Claude read -- and, with a writing key, write, edit and draw on -- your Slow Board boards. One file, no
dependencies: Node 18 or later is all it needs.

It runs on your own machine. Claude Code or Claude Desktop starts it and talks to
it over stdin/stdout; when Claude calls a tool, it makes one short request to the
board's API and returns. Nothing is hosted and nothing stays connected,
so a tool call costs exactly one API call -- and a key may make 120 a minute.

## Tools

| Tool | What it gives Claude |
|---|---|
| `list_boards` | The organisation and its boards, with how many discussions, canvases, kanbans and conversations each holds |
| `list_items` | What is on one board, most recently active first: number, kind, title, one line of excerpt |
| `get_item` | One thing whole: a discussion with replies, decisions, action points and files; a conversation's lines; a kanban's columns and cards; a canvas's text and arrows |
| `list_conversations` | Your direct conversations |
| `get_conversation` | One of them, line by line |
| `search` | Words anywhere -- discussions, replies, canvases and kanbans, conversations, lines, and the words inside files -- with where each hit is and the text around it. Korean works |
| `catch_up` | What moved since this key last read, oldest first. The board remembers where the key read to, so each call hands over only what is newer -- start a session with it. `peek` reads without moving the mark |
| `set_read_mark` | Put the read mark at a moment: back to read again, or now to skip |
| `brief` | Everything on one subject in one read: an address (`surfaces#41`) gives that thing with what refers to it and what shares its keywords; words give the discussions most about them with their latest replies, decisions and open actions, and every decision, action, surface and file that mentions them |
| `recent` | What moved since a time, across every board and your direct conversations |
| `list_actions` | Action points across boards, with where each lives. By default only what is still to do |
| `list_decisions` | The decision log, with the discussion each decision was filed against |
| `list_keywords` | Every keyword, with how many things carry it |
| `get_keyword` | Everything filed under one keyword |
| `read_file` | A file's details and the words inside it, in windows -- a spreadsheet as tables, `.hwp`/`.hwpx` included. An image comes as a picture Claude can see; `look` hands over any file itself, up to 8 MB |
| `create_discussion` | Start a discussion on a board you choose, with a title and a Markdown body |
| `create_surface` | Make a canvas or kanban on a board, named as you say |
| `reply` | Reply to a discussion |
| `send_message` | Write a line in a board conversation or one of your direct conversations |
| `add_task` | Add an action point -- who, what, by when -- to anything by its number |
| `draw` | Draw on a canvas or kanban: real shapes, text, arrows, columns and cards, not a picture -- and move, change or remove what is there. On a kanban it also sets your own progress on a card -- Preparing, In progress, Blocked, Done or Verified; each person sets only their own, and `get_item` shows everyone's |
| `edit_discussion` | Change a discussion's title, body or keywords |
| `edit_reply` | Change one of your replies |
| `edit_message` | Change one of your lines, on a board or in a direct conversation |
| `update_task` | Change an action point: open, blocked (with the reason), done or dropped; what it says; who has it; by when |
| `rename_surface` | Rename a canvas or kanban |
| `my_changes` | Everything this key wrote since a time: surfaces drawn on, action points changed or raised, posts and lines |
| `revert` | Take this key's changes back -- on every surface and action point, or one surface -- or put one canvas or kanban back as it stood at a moment. Says what it would do first; changes nothing without `apply` |

Everything from `create_discussion` down writes, as you, and needs a key made with
**Allow writing** (`my_changes` only reads; `revert` reads until `apply`).
Everything written is marked via API on the board, and an edit is marked edited
via API. The rule is the screen's: a discussion, reply or line is its author's,
so the edit tools change only yours; an action point is shared work, and a canvas
or kanban is everyone's, so `update_task`, `rename_surface` and `draw` change any
of them -- every change is kept, and `revert` takes a key's changes back without
touching anyone else's later work.
`get_item` shows the id of every reply, line and action point in brackets, which
is what the edit tools take.

Answers are short text rather than JSON, because the model reads every character a
tool returns. `get_item` cuts long answers at `max_chars` (12,000 by default) and
says which `offset` to ask for next.

## Set up

1. On the board, open **Settings**, then **API**, and make a key. It is shown once,
   and that page then shows the commands below with your key already in them.
   A key reads exactly what you can read on the board. It writes and edits only if
   made with **Allow writing**, and then edits only what you wrote.
2. Get this server:

   ```bash
   git clone https://github.com/iam-hongsanghyun/slowboard-mcp.git ~/github/slowboard-mcp
   ```

3. Connect it.

   **Claude Code**

   ```bash
   claude mcp add board --env BOARD_API_KEY=cmk_... -- node ~/github/slowboard-mcp/index.mjs
   ```

   **Claude Desktop**: add this to `claude_desktop_config.json` (on a Mac, in
   `~/Library/Application Support/Claude/`), then quit and reopen Desktop. Use the
   full path to `node` -- a desktop app does not see your shell's PATH; `which node`
   prints it.

   ```json
   {
     "mcpServers": {
       "board": {
         "command": "/usr/local/bin/node",
         "args": ["/Users/you/github/slowboard-mcp/index.mjs"],
         "env": { "BOARD_API_KEY": "cmk_..." }
       }
     }
   }
   ```

## Settings

| Variable | Meaning |
|---|---|
| `BOARD_API_KEY` | Your key, from the board's Settings, API. Required. |
| `BOARD_API_URL` | Where the board is. Defaults to `https://slow-board.vercel.app`; set `http://localhost:3000` for a local dev server. |

Keep the key out of anything you commit or paste. If it leaks, revoke it in
Settings, API and make another; the old one stops working at once.

## Why local

An MCP server hosted on a serverless platform over SSE keeps a function open for as
long as the client stays connected, and that open time is billed whether or not
anything is asked. This server is not hosted anywhere: it lives as long as your
Claude session, on your machine, and reaches the board only when a tool is called.
