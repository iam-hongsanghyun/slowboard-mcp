# slowboard-mcp

A local MCP server that lets Claude read -- and, with a writing key, write and draw on -- your Slow Board boards. One file, no
dependencies: Node 18 or later is all it needs.

It runs on your own machine. Claude Code or Claude Desktop starts it and talks to
it over stdin/stdout; when Claude calls a tool, it makes one short request to the
board's read-only API and returns. Nothing is hosted and nothing stays connected,
so a tool call costs exactly one API call -- and a key may make 120 a minute.

## Tools

| Tool | What it gives Claude |
|---|---|
| `list_boards` | The organisation and its boards, with how many discussions, canvases, kanbans and conversations each holds |
| `list_items` | What is on one board, most recently active first: number, kind, title, one line of excerpt |
| `get_item` | One thing whole: a discussion with replies, decisions, action points and files; a conversation's lines; a kanban's columns and cards; a canvas's text and arrows |
| `list_conversations` | Your direct conversations |
| `get_conversation` | One of them, line by line |
| `create_discussion` | Start a discussion on a board you choose, with a title and a Markdown body |
| `create_surface` | Make a canvas or kanban on a board, named as you say |
| `reply` | Reply to a discussion |
| `send_message` | Write a line in a board conversation or one of your direct conversations |
| `add_task` | Add an action point -- who, what, by when -- to anything by its number |
| `draw` | Draw on a canvas or kanban: real shapes, text, arrows, columns and cards, not a picture |

The last six write, as you, and need a key made with **Allow writing**.
Everything they write is marked via API on the board.

Answers are short text rather than JSON, because the model reads every character a
tool returns. `get_item` cuts long answers at `max_chars` (12,000 by default) and
says which `offset` to ask for next.

## Set up

1. On the board, open **Settings**, then **API**, and make a key. It is shown once,
   and that page then shows the commands below with your key already in them.
   A key reads exactly what you can read on the board, and never writes.
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
