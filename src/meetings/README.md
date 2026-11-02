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
| `speakers stats <meeting> [--attendance teams\|<file>]` | Per label: origin, turns, spoken time, spans, with hints |
| `speakers rename <meeting> <label> <name>` | Rename a label for this meeting |
| `evidence <meeting> [--attendance teams\|<file>] [--files]` | Which voice each label's lines are: audio channel and the platform's speaking indicator, plus the volume check (`--format json`: one row per line) |
| `suggest <meeting> [--rules speakers,evidence,terms] [--attendance teams\|<file>]` | Run the rules and add what they find as suggested items |
| `items <meeting> [--status …] [--kind …]` | The items with status, confidence and rules |
| `confirm <meeting> <ids…> [--speaker <name>] [--proposed <text>]`, `--min-confidence 0.9` | Confirm items; a range nobody named needs `--speaker` |
| `reject <meeting> <ids…>` | Reject items; they are never suggested again |
| `transcript <meeting> [--format md\|txt\|json\|srt\|vtt] [--with-suggested]` | The transcript with renames, confirmed items and the dictionary |
| `record start [--meeting <ref> \| --source wisprflow:<id> \| --title <text>] [--project] [--display 1]` | Record the screen: a frame when it changes, OCR per frame; creates the meeting (with the calendar event around now) unless one is named |
| `record stop`, `record status` | Stop (it finishes its current 30 s piece) and write the summary into the meeting; what is recording |
| `screen <meeting> --at 1:23:50 [--window 30s]` | The OCR text of the screen around a transcript time |
| `autostart on\|off\|status` | Record the screen whenever Wispr Flow records a meeting (default off) |
| `watch [--once]` | The watcher behind autostart; the daemon starts it at login when autostart is on |
| `attendance <meeting> [--from teams\|<file>]` | Store who was in the call and when, and the sections derived from it (one per join or leave); suggest, speakers stats and evidence read them when no `--attendance` is given |
| `play <meeting> --at 1:23:50 [--before 5]` | Play the meeting's audio from a moment in VLC (`playback.player`, ffplay as fallback), to hear a voice before `confirm` |
| `projects list` | The known projects, with their dictionary size and match rules (`--json`) |
| `projects add <name>` | Add a known project |
| `dictionary show [--project <name>]` | The merged dictionary: global, then the project (`--json`) |
| `dictionary add <value> [substitution] --type fix\|abbr\|term\|keep [--project <name>]` | Add or replace an entry; a new project name is added to the known projects |
| `dictionary suggest [--project <name>] [--apply 1,3\|all]` | Entries proposed from the source's own dictionary (Wispr Flow) and from corrections confirmed twice |
| `dictionary expansion every\|first\|off [--project <name>]` | How abbreviations expand |
| `dictionary remove <value> [--project <name>]` | Remove an entry |

## The meeting record

One folder per meeting, `~/.genesis-tools/meetings/<YYYY-MM-DD_HH-MM>-<title>/meeting.json`. A meeting is named by its
id, a unique prefix of it, `last`, or a source reference such as `wisprflow:1a2b3c4d`. Every change adds one line to
the record's `history`, and a change that would make the record invalid writes nothing.

Every command that creates or changes a meeting resolves its project in this order: `--project` (a new name joins
the known projects), the meeting's own, one matching project (`projects.<name>.match`), a choice in a terminal, and
without a terminal no project. `show` then says how to set it.

## Recording

`record start` checks Screen Recording first, by the classic route: granted already, then the macOS prompt for the
identity that captures (GenesisTools.app when it is installed, else the terminal), then GenesisTools.app's own
permission window, and without the app it says what to install and grant. Without a terminal (`--yes`, the daemon) it
never prompts and only says what to run.

The recorder runs peekaboo's change-aware live capture in 30 s pieces (`capture.activeFps`, `idleFps`, `threshold`
in the config), converts each frame to JPEG under the meeting's `frames/`, and appends Vision OCR to `ocr.jsonl`.
Frames stay on this Mac and never go into an export. When a source is linked, `record stop` stores its clock, so
`screen --at` takes transcript times.

### Autostart

`tools meetings autostart on` sets `sources.wisprflow.autoRecord.enabled` and starts the watcher; the daemon starts
it at every login while it is on. Every 15 s the watcher asks Wispr Flow for a meeting it has not ended whose live
transcript changed in the last `liveWithinSec` (30). It then runs `record start --source wisprflow:<id> --yes` and
posts a notification (`notify`, default on). It stops only the recordings it started, when Wispr Flow ends the
meeting or stays silent for `stopAfterSilenceSec` (120). A start that failed (no grant) notifies once and is not
retried for the same meeting.

## Items

A rule's finding is an item with a confidence and the rules that produced it. A person confirms or rejects it; only
confirmed items change a transcript (`--with-suggested` previews the rest).

- `speaker-range`: lines of a label that belong to someone else. RA (Teams attendance) names the people in the call
  as candidates, or the one person left; R1 and R5 mark a goodbye the label keeps talking after, R13 when another
  label answered it, R14 when it echoes another label's goodbye.
- `speaker-range` from the `evidence` rules: E1, the audio channel (the user's microphone is always the user; a line
  where the microphone wins below 90 % asks to listen first), with E3 (the platform's speaking indicator) and E4 (its
  live name, overruled when attendance says that person was not in the call).
- `join`: a word cut between two lines ("dot" + "áhnu").
- `term`: a misheard term and its proposed spelling.

A confirmed term or join is also written to `~/.genesis-tools/meetings/corrections.jsonl`.

## The dictionary

- `fix`: a misheard spelling, replaced at every whole-word match (`DTLčko` becomes `DTOčko`).
- `abbr`: an abbreviation. Its substitution must contain the abbreviation itself, so the original stays:
  `MOP` becomes `MOP (Obchodní partner podnikatel)`. A substitution without it is refused.
- `term`: a correct spelling the misheard-term check should know; `--spoken` lists how people say it.
- `keep`: a word the misheard-term check must never flag.

A `term` may list its spoken forms (`--spoken jenezetka --spoken jenezetkou` for JDZ): a whole-word spoken form is
replaced by the term. Other words are compared with the terms and their spoken forms after the Czech ending is
stripped (`jenezetkama` and `jenezetka` share `jenezet`). A level's `fuzzy: { apply, suggest }` (default 0.95 and
0.8) decides what happens: at `apply` or above the word is replaced, from `suggest` up to `apply` `suggest` makes a
term item with the score (rule `dictionary-fuzzy`), below nothing. `--meaning` stores what a term means.

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
