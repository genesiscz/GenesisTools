# tools meetings

> **Meetings as one record each: the projects they belong to, the dictionary that polishes their transcripts, and
> (being built) the meeting record, recording and review.**

The source-neutral side of meeting transcripts. `tools wisprflow` reads Wispr Flow; this tool keeps what is the same
for every source. The design is the vault note `GenesisTools/2026-11-02-MeetingTranscriptPolish-Design.md`.

## Commands

| Command | What it does |
|---|---|
| `new [title] [--at <time>] [--project <name>]` | Create a meeting record by hand |
| `new --source wisprflow:<id>` | Create it from a source's meeting: title, times, people, the calendar entry |
| `list [--project <name>]`, `show <meeting>` | The records (`--json`) |
| `set <meeting> --project <name> \| --title <text>` | Change a field |
| `link <meeting> wisprflow:<id>` | Attach a source's meeting to an existing record |
| `context add <meeting> [file\|url] [--title] [--note]`, `context list`, `context remove` | Reference material; a file is kept as its path, never copied |
| `projects list` | The known projects, with their dictionary size and match rules (`--json`) |
| `projects add <name>` | Add a known project |
| `dictionary show [--project <name>]` | The merged dictionary: global, then the project (`--json`) |
| `dictionary add <value> [substitution] --type fix\|abbr\|term\|keep [--project <name>]` | Add or replace an entry; a new project name is added to the known projects |
| `dictionary expansion every\|first\|off [--project <name>]` | How abbreviations expand |
| `dictionary remove <value> [--project <name>]` | Remove an entry |

## The meeting record

One folder per meeting, `~/.genesis-tools/meetings/<YYYY-MM-DD_HH-MM>-<title>/meeting.json`. A meeting is named by its
id, a unique prefix of it, `last`, or a source reference such as `wisprflow:1a2b3c4d`. Every change adds one line to
the record's `history`, and a change that would make the record invalid writes nothing.

Every command that creates or changes a meeting resolves its project in this order: `--project` (a new name joins
the known projects), the meeting's own, one matching project (`projects.<name>.match`), a choice in a terminal, and
without a terminal no project. `show` then says how to set it.

## The dictionary

- `fix`: a misheard spelling, replaced at every whole-word match (`DTLčko` becomes `DTOčko`).
- `abbr`: an abbreviation. Its substitution must contain the abbreviation itself, so the original stays:
  `MOP` becomes `MOP (Obchodní partner podnikatel)`. A substitution without it is refused.
- `term`: a correct spelling the misheard-term check should know; `--spoken` lists how people say it.
- `keep`: a word the misheard-term check must never flag.

Levels merge in this order, a later one winning: global, the project, the meeting. Abbreviations expand at every
mention by default (`every`); `first` expands only the first mention in a transcript, `off` none.

## Config

`~/.genesis-tools/meetings/config.json`. Every key has a default, so the file holds only what you changed:

```jsonc
{
    "version": 1,
    "global": { "dictionary": { "abbrExpansion": "every", "entries": [] }, "capture": { "activeFps": 1 } },
    "projects": {
        "work": {
            "dictionary": { "entries": [{ "type": "abbr", "value": "MOP", "substitution": "MOP (Obchodní partner podnikatel)" }] },
            "match": { "wisprflow": { "folders": ["Work"] }, "calendar": { "titles": ["Wiki"] } }
        }
    },
    "sources": { "wisprflow": { "autoRecord": { "enabled": false } } }
}
```

A change that would make the file invalid is refused, and the file stays as it was.
