# tools wisprflow

> **Wispr Flow meetings, notes and calendar as JSON, Markdown, text or subtitles, from the app's local data or its MCP.**

Two sources, and every command prints which one answered (on stderr):

1. **local**: the Wispr Flow app's own data on this Mac, read-only. `flow.sqlite` holds meetings, the speaker map, summaries, folders, notes, calendar events, your dictionary and your transcript edits; `meetings/<id>/refined.ndjson` holds the transcript with a time and a speaker number per line.
2. **mcp**: the hosted Wispr Flow MCP (`api.wisprflow.ai/connect/mcp`) through the local MCP gateway. It sees meetings that were recorded on another machine, attendee e-mails and recurring series, but it returns no times per line.

`--source auto` (the default) uses local data when the meeting is on this Mac, and the MCP otherwise.

**Why local first:** a speaker you rename in the app is stored on this Mac at once, and sent to the server later. Until it is sent, the MCP still says "Speaker 1". `tools wisprflow doctor` lists the meetings in that state, and `--cross-check` shows the difference.

---

## Commands

| Command | Description |
|---------|-------------|
| `meetings list [query]` | List or search meetings (`--since`, `--until`, `--folder`, `--attendee`, `--limit`) |
| `meetings show <meeting>` | Participants, folders, share link, summary and notes (`--format md\|json\|txt`) |
| `meetings transcript <meeting>` | Wispr Flow's raw transcript in speaker turns and paragraphs (`--format md\|txt\|json\|srt\|vtt`) |
| `dictionary list [--snippets]` | The app's own dictionary, most used first (read-only, local data only) |
| `meetings export <meeting...> --dir <dir>` | `Summary.md`, `Transcript.md` and `meeting.json` per meeting |
| `meetings series <meeting>` | Every recorded occurrence of a recurring meeting (MCP) |
| `notes list [query]`, `notes show <id>` | Scratchpad notes |
| `calendar upcoming`, `calendar search [query]` | Calendar events |
| `doctor` | Both sources, plus speaker renames not on the server yet. Read-only |

`<meeting>` is a meeting id, a share link (`https://notes.wisprflow.ai/shared/…`) or its slug.

## Transcript options

| Option | Effect |
|--------|--------|
| `--format md` | Frontmatter (unless `--no-frontmatter`), title, `## Summary` (unless `--no-summary`), `## Transcript` |
| `--timestamps` | The start time of each paragraph |
| `--first-names` | `Alice` instead of `Alice Example` |
| `-o <file>` | Write to a file. A different existing file is not replaced: the diff is printed and the command exits 2. Add `--confirm` to replace it. An existing frontmatter is kept; only missing keys are added (`--no-keep-frontmatter` replaces it) |
| `--source auto\|local\|mcp`, `--cross-check` | Pick the source; also ask the MCP and report where speaker names differ |

## Polishing lives in `tools meetings`

`tools wisprflow` is the Wispr Flow source and its raw export. Term fixes, speaker statistics, attendance and the
rest of the polishing are `tools meetings`, one pipeline for every source; `tools meetings` reads Wispr Flow through
this tool's source adapter (`lib/meeting-source.ts`), and this tool imports nothing from `tools meetings`. The old
flags (`transcript --fix-term`, `--vocab`, `--min-confidence`, and `meetings speakers`) print the commands to use:

```bash
tools meetings new --source wisprflow:<id>
tools meetings suggest wisprflow:<id>
tools meetings transcript wisprflow:<id> --with-suggested
tools meetings speakers stats wisprflow:<id> --attendance teams
```

## Examples

```bash
tools wisprflow meetings list --since 2026-09-30
tools wisprflow meetings transcript <id> --first-names --no-summary -o Transcript.md
tools wisprflow meetings transcript <id> --format srt > meeting.srt
tools wisprflow meetings show https://notes.wisprflow.ai/shared/<slug> --format json
tools wisprflow doctor
```
