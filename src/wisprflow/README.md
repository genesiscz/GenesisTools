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
| `meetings transcript <meeting>` | The transcript in speaker turns and paragraphs (`--format md\|txt\|json\|srt\|vtt`) |
| `meetings export <meeting...> --dir <dir>` | `Summary.md`, `Transcript.md` and `meeting.json` per meeting |
| `meetings series <meeting>` | Every recorded occurrence of a recurring meeting (MCP) |
| `notes list [query]`, `notes show <id>` | Scratchpad notes |
| `calendar upcoming`, `calendar search [query]` | Calendar events |
| `doctor` | Both sources, plus speaker renames not on the server yet. Read-only |

`<meeting>` is a meeting id, a share link (`https://notes.wisprflow.ai/shared/…`) or its slug.

## Transcript options

| Option | Effect |
|--------|--------|
| `--format md` | Frontmatter (unless `--no-frontmatter`), title, misheard-term callout, `## Summary` (unless `--no-summary`), `## Transcript` |
| `--timestamps` | The start time of each paragraph |
| `--first-names` | `Alice` instead of `Alice Example` |
| `-o <file>` | Write to a file. A different existing file is not replaced: the diff is printed and the command exits 2. Add `--confirm` to replace it. An existing frontmatter is kept; only missing keys are added (`--no-keep-frontmatter` replaces it) |
| `--source auto\|local\|mcp`, `--cross-check` | Pick the source; also ask the MCP and report where speaker names differ |

## Misheard terms

Speech recognition turns jargon into near-misses ("Zushtent" for Zustand, "RaaQuery" for React Query). The transcript command compares every 1 to 3 word run with a vocabulary and lists the likely ones in a callout under the title, each with its candidates and a confidence:

- Vocabulary: a built-in development glossary, proper nouns from the meeting's own summary, your Wispr Flow dictionary, and `--vocab <file>` (a `package.json` or one term per line, repeatable).
- Score: edit distance on the text, on a phonetic key tuned for Czech speakers saying English terms, and on its consonants. Czech case endings on a correct term ("Reduxu") are not reported.
- `--min-confidence <pct>` (default 70) sets the cut-off. `--no-terms` turns the check off.

Nothing is changed until you ask. The command prints the exact rerun line:

```bash
tools wisprflow meetings transcript <id> --fix-term "Zushtent::Zustand" --fix-term "redakt::Redux"
tools wisprflow meetings transcript <id> --fix-term Zushtent        # its top candidate
tools wisprflow meetings transcript <id> --fix-term all             # every non-inflected suspect
```

`--fix-term` is repeatable, and a comma also separates values. The suggested command lists one explicit `heard::Replacement` pair per suspect, so an agent (or you) can read each one in its sentence, then keep it, change the replacement, or drop it. Applied fixes are recorded in the frontmatter under `term_fixes`.

## Examples

```bash
tools wisprflow meetings list --since 2026-09-30
tools wisprflow meetings transcript <id> --first-names --no-summary -o Transcript.md
tools wisprflow meetings transcript <id> --format srt > meeting.srt
tools wisprflow meetings show https://notes.wisprflow.ai/shared/<slug> --format json
tools wisprflow doctor
```
