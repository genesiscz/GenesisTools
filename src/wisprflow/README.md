# tools wisprflow

Reads your Wispr Flow meetings, transcripts, scratchpad notes, calendar events and dictionary, and prints them as
tables, JSON, Markdown, plain text or subtitles. It reads the Wispr Flow app's own data on this Mac first, and the
hosted Wispr Flow MCP when the meeting is not on this Mac. It never changes anything in Wispr Flow.

Use it to find a meeting, export its raw transcript and summary into your notes, or feed it to `tools meetings`,
which does the polishing (speaker fixes, term fixes, attendance).

## Quick start

```bash
# Are the local data and the MCP both reachable?
tools wisprflow doctor
# Meetings since a date, newest first
tools wisprflow meetings list --since 2026-09-30
# Participants, invitees, summary and notes of one meeting
tools wisprflow meetings show <id>
# The transcript as Markdown in a file, speakers by first name
tools wisprflow meetings transcript <id> --first-names --no-summary -o Transcript.md
# Summary.md, Transcript.md and meeting.json in a folder per meeting
tools wisprflow meetings export <id> --dir ~/Projects/app/meetings --timestamps
# Calendar events in the next 8 hours
tools wisprflow calendar upcoming --hours 8
```

`<id>` comes from the `ID` column of `meetings list`.

## Commands

A command that can use either source prints the source that answered (`source: local …` or `source: mcp …`) on
stderr, so stdout holds only the result. `--source auto|local|mcp` picks the source; `auto` is the default (see
"How it works").

`<meeting>` is a meeting id, a share link (`https://notes.wisprflow.ai/shared/<slug>`) or the bare share slug.

### Meetings

- `meetings list [query]` (alias `ls`): list or search meetings, newest first. The query matches the title, the
  summary or the notes.
  - `--since <iso>`, `--until <iso>`: only meetings that start in this window.
  - `--folder <name>`: only meetings in a folder whose name contains this text. Local source only; the MCP ignores it
    and says so.
  - `--attendee <email>`: only meetings with this attendee. Repeat it for several. MCP only: with `--source auto` this
    flag makes the command ask the MCP, because the local data has no attendee e-mails for meetings. With
    `--source local` the flag is ignored without a warning, so the list is not filtered.
  - `--limit <n>` (default 25), `--source`, `--format table|json`.
- `meetings show <meeting>`: one meeting without its transcript.
  - `--format md` (default): frontmatter, Participants, Invited, Summary and Notes.
  - `--format txt`: the title, the start time and the summary.
  - `--format json`: `{ source, notes, meeting }`.
  - `--source`.
- `meetings transcript <meeting>`: Wispr Flow's raw transcript, grouped into speaker turns and paragraphs. The
  flags are in "Transcript output" below.
- `meetings export <meetings...> --dir <dir>`: one sub-folder per meeting with `Summary.md`, `Transcript.md` and
  `meeting.json`. `--dir` is required. `--confirm`, `--timestamps`, `--first-names`, `--source`.
- `meetings series <meeting>`: every recorded occurrence of the recurring meeting this one belongs to. MCP only, so it
  has no `--source`. `--limit <n>` (default 25), `--format table|json`.
- `meetings speakers <meeting>`: moved. It prints the `tools meetings speakers stats` command to use and exits 1.

### Notes

- `notes list [query]` (alias `ls`): scratchpad notes, newest first. The query matches the title or the content.
  `--limit <n>` (default 25), `--source`, `--format table|json`.
- `notes show <id>`: one note's text as `# Title` and the body. `--source`, `--format md|json`. In `auto` mode a note
  that is not on this Mac is read from the MCP.

### Calendar

- `calendar upcoming`: events in the next hours, soonest first. `--hours <n>` (default 24, at most 168), `--source`,
  `--format table|json`.
- `calendar search [query]`: events whose title contains the query. The window is `--since` to `--until`; by default
  it starts 30 days ago and ends 7 days from now. `--source`, `--format table|json`.

The local source leaves out cancelled events. The MCP source returns at most 50 events.

### Dictionary

- `dictionary list` (alias `ls`): the words the app was taught to spell, most used first, with the replacement, the use
  count and whether you added it by hand. `--snippets` also lists text snippets (expansions, not spellings).
  `--format table|json`. Local data only: the MCP has no dictionary.

To propose these words for the meetings dictionary, run `tools meetings dictionary suggest`.

### Doctor

- `doctor`: checks both sources and lists the meetings whose speaker rename the app has not sent to the server yet.
  It opens the database read-only and makes one MCP search call. Like every MCP call, that call starts the local
  gateway when it is not running and can open a login window (see "Configuration"). `--json` prints
  `{ local: { ok, dir, error?, pendingRenames }, mcp: { ok, error? } }`. It exits 1 only when both sources fail.

### Moved to tools meetings

`tools wisprflow` is the Wispr Flow source and its raw export. Term fixes, speaker statistics, attendance and the rest
of the polishing are `tools meetings`, one pipeline for every source. The old flags (`transcript --fix-term`,
`--vocab`, `--min-confidence`) and `meetings speakers` print the commands to use and exit 1:

```bash
tools meetings new --source wisprflow:<id>
tools meetings suggest wisprflow:<id>
tools meetings transcript wisprflow:<id> --with-suggested
tools meetings speakers stats wisprflow:<id> --attendance teams
```

The hidden `--no-terms` flag on `transcript` and `export` is still accepted and has no effect.

## Transcript output

| Option | Effect |
|--------|--------|
| `--format md` | The default. Frontmatter, title, `## Summary`, `## Transcript` |
| `--format txt` | Title, start time, `SUMMARY`, `TRANSCRIPT`, then the turns |
| `--format json` | `{ source, notes, meeting }`, with one transcript entry per line |
| `--format srt\|vtt` | Subtitles. They need a time per line, so only local data |
| `--no-frontmatter` | md: leave out the frontmatter |
| `--no-summary` | Leave out the summary section |
| `--timestamps` | The start time of each paragraph |
| `--first-names` | `Alice` instead of `Alice Example` |
| `-o, --output <file>` | Write to a file instead of stdout |
| `--confirm` | Replace an `-o` file that differs |
| `--no-keep-frontmatter` | md with `-o`: replace the file's own frontmatter |
| `--source`, `--cross-check` | Pick the source; also ask the MCP where speaker names differ |

```bash
# Subtitles for a meeting recorded on this Mac
tools wisprflow meetings transcript <id> --format srt > meeting.srt
# A meeting from its share link, as JSON
tools wisprflow meetings show https://notes.wisprflow.ai/shared/<slug> --format json
```

The Markdown transcript groups lines into speaker turns. A pause of 30 seconds inside a turn starts a new paragraph,
and a paragraph longer than 700 characters breaks at the next sentence end.

The frontmatter has `title`, `meeting` (the local start and end time), `duration_min`, `speakers`, `wisprflow_id`,
`source` (the share link), `folders` and `wisprflow_source` (`local` or `mcp`). Times in tables and in the
frontmatter are local time. Times in JSON are UTC.

**Writing to a file is guarded.** `-o` creates a new file and leaves an identical one alone. When the file exists and
differs, nothing is written: the diff goes to stderr and the command exits 2. Add `--confirm` to replace it. An
existing frontmatter is kept: every key already in the file stays as it is, and only missing keys are added
(`--no-keep-frontmatter` replaces it). The body is always the new one. The write is atomic, and a note that is a
symlink stays a symlink.

**Export** writes into `<dir>/<YYYY-MM-DD>-<Title>/`. The date is local, and every run of characters that are not
letters or digits in the title becomes `-`; a meeting without a title uses the first 8 characters of its id.

- `Summary.md` is what `meetings show` prints.
- `Transcript.md` is the Markdown transcript with frontmatter and without the summary.
- `meeting.json` is `{ source, meeting, calendar }`: the participants with `name`, `origin` and
  `isSelf` (plus `speakerId` for a local meeting only; the MCP gives no speaker numbers for participants), one
  transcript entry per line with `startSec`, `speakerId`, `speaker` and `text`, and the matched calendar
  event or `null`. `origin` says who named the speaker (`platform` for the call app, `llm` for Wispr's language model,
  `self` for you). A platform name is evidence; a model's name is a guess. `meetings show` prints it as "named by …".
  From the MCP, the participants have no `speakerId` and the lines have no `startSec`, because the MCP gives neither.
  A line from the MCP has a `speakerId` only when its speaker is still called `Speaker N`.

The same guard applies to each file: an existing file that differs needs `--confirm`. The two Markdown files keep
their frontmatter; `meeting.json` is replaced whole. A meeting that fails prints `<ref>: <error>` and the export goes
on with the next one.

## How it works

Two sources:

1. **local**: the Wispr Flow app's own data on this Mac, opened read-only while the app keeps writing to it.
   - `~/Library/Application Support/Wispr Flow/flow.sqlite` holds the meetings, the speaker map, summaries, folders,
     notes, calendar events, your dictionary and your transcript edits.
   - `meetings/<id>/refined.ndjson` in that folder holds the transcript with a time and a speaker number per line.
     `meetings/<id>/live.ndjson` is the unrefined transcript the app writes while the meeting runs.
2. **mcp**: the hosted Wispr Flow MCP (`https://api.wisprflow.ai/connect/mcp`) through the local MCP gateway of
   `tools mcp-manager`. It sees meetings recorded on another machine, filters by attendee e-mail and knows recurring
   series. Through the MCP there are no times per line, no dictionary and no `--folder` filter.

`--source auto` uses the local data when the meeting is on this Mac and the MCP otherwise. For `meetings list`,
`notes list` and the calendar commands, `auto` uses the local data whenever the app's database is on this Mac
(except `meetings list --attendee`, which needs the MCP).

**Why local first:** a speaker you rename in the app is stored on this Mac at once and sent to the server later.
Until it is sent, the MCP still says "Speaker 1". The local copy alone has those renames, the times per line and your
transcript edits. `tools wisprflow doctor` lists the meetings in that state. `transcript --cross-check` also asks the
MCP and reports where the names differ, or says `Cross-check skipped: …` when the MCP does not answer.

What the local reader does for you:

- **Speaker names.** Each speaker number gets the person the app assigned. The app can assign a person in five ways,
  and the first that names one wins: your manual pick in the app (`user`), then `consensus`, `mic`, `dom` and `llm`.
  A speaker nobody named stays "Speaker N". `<@speaker:N>` mentions in the summary and notes become names.
- **Your edits.** Your corrections of transcript lines replace the recognised text; the newest edit of a line wins.
- **A cut-off refined transcript.** The app sometimes stops refining a long meeting part-way and never resumes (seen:
  the refined text ended at 13:18 of a 189 minute recording). When the live lines run more than 30 seconds past the
  refined ones, the tool appends the unrefined live lines and says so: a note on stderr, a "Partly unrefined" callout
  in Markdown, and `transcriptGap` in JSON. A tail of fewer than 10 words is trailing noise and is left out (seen: 1
  and 4 words in two of 62 meetings).
- **Invitees.** `meetings show` and `export` take the "Invited" list and the call link from the local calendar event
  that starts closest to the meeting, within 15 minutes.

**Read-only, by design and by necessity.** The tool never writes the app's database. Wispr Flow also offers no way to
change a meeting from outside: checked on 2026-11-04 and again on 2026-11-05 (app 1.6.1376), its MCP server lists 16
tools that all read, and its `wispr-flow://` URL scheme only opens pages. To file a meeting in a folder, open it in
Wispr Flow's Notes page and add it there.

**Costs and requirements.** The local source needs the Wispr Flow app installed on this Mac. The MCP needs a Wispr
Flow account and a network connection. The tool calls no paid API.

## Configuration

The tool has no config file and no environment variables. The local data path is fixed. The MCP source needs a server
named `wisprflow` in `tools mcp-manager`:

- transport `http`, URL `https://api.wisprflow.ai/connect/mcp`, OAuth through the gateway;
- enabled in at least one provider (the tool skips a server that is disabled everywhere);
- logged in: `tools mcp-manager auth login wisprflow`.

The tool finds the server in the `tools scripts` registry cache (`~/.genesis-tools/scripts/cache/registry.json`).
That cache has no expiry, and `tools mcp-manager` does not clear it. After you add or enable `wisprflow`, run
`tools scripts tools 'wisprflow.*' --refresh` once: it re-scans the provider configs and saves the cache.
`tools scripts servers --refresh` shows the fresh list but does not save it.

Each MCP call first starts the local gateway when it is not running: through its launchd agent when that is
installed, otherwise inside the command's own process. The tool's own MCP client never runs an OAuth flow, but the
gateway does. When `wisprflow` has no valid login, the gateway opens a browser window to log in to Wispr Flow, and
the command fails with `Wispr Flow MCP is not reachable: …`. After a failed login the gateway answers
`wisprflow needs a login and the last attempt failed` instead. Each MCP call times out after 60 seconds. Check the
setup with:

```bash
tools scripts servers                     # is wisprflow in the cached list this tool reads?
tools mcp-manager auth status wisprflow   # is the login still valid?
tools mcp-manager gateway status          # is the local gateway running?
```

## For agents

- **JSON:** `--format json` on `meetings list|show|transcript|series`, `notes list|show` and
  `calendar upcoming|search`. Each of these answers names its `source`. Lists are `{ source, meetings }`,
  `{ source, notes }` or `{ source, events }`, and `notes show` is `{ source, note }`. Calendar events carry `people`
  with e-mails where the calendar has them.
- **JSON without a source:** `dictionary list --format json` prints a bare array of
  `{ phrase, replacement?, uses, manual, snippet, lastUsed? }`. `doctor --json` prints the report shape in "Doctor".
- **Top-level `notes`** in a JSON answer are the source's warnings (a pending rename, a cut-off transcript, a
  fallback to the MCP). The meeting's own notes are `meeting.notes`.
- **stdout and stderr:** the result goes to stdout. The source line, warnings, diffs and the "Next:" hints go to
  stderr. `doctor` without `--json` prints its whole report to stderr.
- **Exit codes:** 0 on success; 1 on an error, an unknown flag value, or a moved command; 2 when `-o` or `export` found
  a different file and `--confirm` was not given (nothing was written).
- **A bare `--format`** opens a picker in a terminal. Outside a terminal it prints the allowed values with a ready
  command and exits 1, so always pass the value. A bare `--source` means `auto`.
- **tools meetings** reads Wispr Flow through this tool's source adapter (`lib/meeting-source.ts`, refs
  `wisprflow:<id>`), and this tool imports nothing from `tools meetings`. The adapter also gives `tools meetings` the
  app's dictionary, the calendar, the folders, the meeting that is recording now, and the raw evidence files of a
  meeting folder (`speakers.observations.ndjson`, `native-language-evidence.json`, `audio-devices.json`,
  `upload.ogg`). Transcript second 0 is the meeting's start (checked on 2026-11-02 against Teams leave times, within
  4 seconds).
- **node-repl:** the `meetings` toolset's `meetings.open()` also takes `wisprflow:<id>` to open the stored meeting
  record of a Wispr Flow meeting.
- **Plugin skill:** the genesis-tools `meetings` skill and its `references/wisprflow.md` say which of these commands a
  transcript polisher uses.

## Troubleshooting

- **`Wispr Flow MCP is not reachable: …`**: the login is missing or expired, the call timed out, or the gateway
  stopped answering. When the gateway opened a browser window, finish the login there and run the command again.
  Otherwise run `tools mcp-manager gateway status`, then `tools mcp-manager auth login wisprflow`.
- **`port <n> is in use by another process`** or **`launchd agent … is installed but /health is not ok`**: the tool
  could not start the local gateway. Another process holds the gateway's port, or the installed launchd agent did not
  come up (the message names its log file). Run `tools mcp-manager gateway status`.
- **`… No enabled MCP server matched: wisprflow`**: the server is missing, disabled everywhere in
  `tools mcp-manager`, or added after the registry cache was saved. Run `tools scripts tools 'wisprflow.*' --refresh`
  once. See "Configuration".
- **`--format srt needs a time per line`**: the MCP answered, and it has no times. Use `--source local` on the Mac
  that recorded the meeting.
- **`meeting <id> is not in the local Wispr Flow database`**: you passed `--source local` for a meeting recorded on
  another Mac. Use `--source auto` or `mcp`.
- **`meeting <id> is not in the local Wispr Flow database, and Wispr Flow MCP is not reachable: …`**: in `auto` mode
  the meeting is not on this Mac, and the MCP did not answer. Fix the MCP setup (the entries above).
- **`the Wispr Flow app data is not on this Mac`**: you passed `--source local` on a Mac without the Wispr Flow app
  data (`doctor` prints the same line for the local source). Use `--source mcp`.
- **The MCP still says "Speaker 1" after a rename**: the app has not sent the rename yet. Read the meeting locally;
  `doctor` lists every meeting in that state.
- **`share link … did not resolve to one of your meetings`**: the link is not in your local data and the MCP does not
  know it for your account.
- **Exit 2 and a diff**: the target file has other content. Read the diff, then add `--confirm`.
- **`The dictionary is only in the local app data`**: `dictionary list` runs only on a Mac with the Wispr Flow app.
- **More detail**: add `-v`, and read `~/.genesis-tools/logs/<today>.log` for the `wisprflow-local`, `wisprflow-mcp`
  and `wisprflow-source` entries.

## Related

- [tools meetings](../meetings/README.md): speaker fixes, term fixes, attendance and screen recording, with Wispr
  Flow as its transcript source.
- [tools mcp-manager](../mcp-manager/README.md): the MCP gateway and the OAuth login the MCP source uses.
- [tools scripts](../scripts/README.md): `tools scripts servers` lists the MCP servers this tool can reach.
- [tools ms-teams](../ms-teams/README.md): Teams attendance, which `tools meetings` checks speakers against.
- [tools node-repl](../node-repl/README.md): the `meetings` toolset.
