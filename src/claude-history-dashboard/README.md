# Claude History Dashboard

A web dashboard for browsing and searching your Claude Code conversation history stored in `~/.claude/projects/`.

## Features

- **Conversation Browser**: View all conversations with search and filtering
- **Conversation Detail**: Read full conversation threads with user/assistant messages and tool usage
- **Statistics**: Overview of usage including total conversations, messages, top projects, tool usage, and daily activity chart
- **Subagent Detection**: Identifies and labels subagent sessions

## Quick Start

```bash
cd src/claude-history-dashboard
bun install
bun run dev
```

Open http://localhost:3000 in your browser.

## Tech Stack

- **React 19** with React Compiler
- **TanStack Router** - File-based routing
- **TanStack Start** - Server functions for data fetching
- **TanStack Query** - Data caching and state management
- **Tailwind CSS** - Styling
- **Shadcn UI** - Component library
- **Vite** - Build tool
- **Biome** - Linting and formatting

## Pages

| Route | Description |
|-------|-------------|
| `/` | Main conversation list with search |
| `/conversation/:id` | Full conversation view |
| `/stats` | Usage statistics and analytics |

## Scripts

```bash
bun run dev      # Start dev server on port 3000
bun run build    # Build for production
bun run preview  # Preview production build
bun run test     # Run tests
bun run lint     # Lint code
bun run format   # Format code
bun run check    # Run all checks
```

## Data Source

This dashboard reads conversation history from the `claude-history` library (`@app/claude-history/lib`), which parses JSONL files from `~/.claude/projects/`.
