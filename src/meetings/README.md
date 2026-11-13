# tools meetings

Keeps each meeting as one record: its project and labels, its transcript source, a screen recording with OCR, the
findings that correct its transcript, and the dictionary that polishes it. Use it to turn a speech-recognition
transcript (today from Wispr Flow) into a transcript you can trust: the right speaker on each line, the right
spelling of each term, and a polished note in the project's folder.

The tool keeps what is the same for every transcript source. `tools wisprflow` reads Wispr Flow itself. The design
lives in the maintainer's notes (`GenesisTools/2026-11-02-MeetingTranscriptPolish-Design.md`), not in this repository.

## Quick start

```bash
tools meetings new --source wisprflow:1a2b3c4d     # make a record from a Wispr Flow meeting
tools meetings suggest last --attendance teams     # run the rules, store what they find as suggested items
tools meetings listen last                         # answer the open questions by ear, one at a time
tools meetings transcript last --with-suggested    # preview the corrected transcript
tools meetings export last                         # write the polished note into the project's folder
tools meetings record start --audio mic,system     # record the screen (and sound) during a call
```

`last` is the newest meeting. `export` needs a folder: set `projects.<p>.export.folder` once, or pass
`--to ~/Projects/app/notes` (see [Export](#export)). `tools meetings window` opens the same records in the Meetings
window of GenesisTools.app.

## Commands

A meeting argument is a meeting id, a unique prefix of it, `last`, or a source reference such as
`wisprflow:1a2b3c4d`. A time is `1:23:50`, `23:50` or seconds, on the transcript's clock. Commands that print data take
`--json` where the list names it; [For agents](#for-agents) lists them all.

### Service and review additions

| Command | What it does |
|---|---|
| `speakers stats <meeting> [--attendance <platform>\|<file>]` | Per label: origin, turns, spoken time, spans, with hints. A span joins turns up to `--gap` apart (2 minutes): it says when the label was there. `--json` also lists each turn by itself as `talk`, which the Meetings window draws as the talk-time lanes |
| `people [query] [--meeting <meeting> [--at <time>]] [--limit <n>] [--hidden] [--json]` | The people directory: everyone the meetings, the projects, Contacts and the people book name, one row per person, matched with case and accents ignored and ranked (see [People](#people)). `--json` prints `{ query, people, total, sources }`; a source that is off or refused says why in `sources` |
| `people add <name> [--email <address>] [--note <text>]`, `people hide <person> [--show]` | Add a person to the people book, or give one it has an email or a note; hide a person from every list, or show them again |
| `people merge <a> <b> [--name <name>] [--yes]`, `people unmerge <token>` | Show two people as one. Without `--yes` it prints the meetings that name either of them and the speaker labels renamed to them, and writes nothing; with `--yes` it writes the merge and prints its token, which `unmerge` takes. No meeting record changes |
| `people assign <meeting> <person> --from <time> [--to <time>] [--label <label>] [--line <time>]… [--plan]`, `people unassign <meeting> <token>` | Give lines of one meeting to a person without renaming the whole label: a stretch (one label's lines with `--label`, every voice's without it) or single lines by their start. The corrected transcript, `show` and `speakers stats` show them as that person. `--plan` prints what it would give and the other stretches it may reach, and saves nothing. `unassign` undoes it by the token it printed |
| `rows <meeting> [--all] [--json]` | The review rows, as the Meetings window shows them: questions first in the order `listen` asks (priority, then time), then the other items by time; a decided row keeps its place. Each row has its question as parts (who, what was said, when, what it asks, what it settles, the reason), its choices with their role (suggested, presumed, candidate, heard, earlier answer, none of these, several voices, skip) and the engine's confidence where it has one, its edit kind, what it needs, its sources and who decided it last. Open questions below `playback.listen.minPriority` are counted, and `--all` shows them. `--json` prints `{ meeting, rows, hidden }` (REPL: `meetings.open(id).items.rows()`; the Meetings service: `meeting.rows`) |
| `confirm <meeting> <ids…> [--speaker <name>] [--proposed <text>] [--reason <text>] [--json]`, `--min-confidence 0.9` | Confirm items; a range nobody named needs `--speaker`. An item confirmed already is left as it is (`needs: "nothing"` in `--json`, exit 0), so its first Undo token still works; a skip that needs a value or an answer exits 1. `--reason` is kept in the decision journal and on each item it decided. `--json` prints `{ decided, token, skipped, entry }`; `entry` is the journal entry, with who decided (the actor), the reason and every item before and after |
| `reject <meeting> <ids…> [--reason <text>] [--json]`, `--min-confidence 0.9` | Reject items; they are never suggested again. `--json` prints `{ decided, token, skipped, entry }`, as `confirm --json` does; the token is what `reopen --token` takes |
| `journal <meeting> [--item i42\|Q12] [--limit <n>] [--json]` | Who decided what in the meeting, when and why, newest first: one entry per decision (a person in the window, a person in `listen`, a person at the command line, an agent with its harness and session, a rule), with its reason and the items it changed. An Undo names the entry it undid. Comments sent to the listening agent are entries too (kind `comment`). `--json` prints `{ meeting, entries }` |
| `serve [--detach] [--status] [--stop] [--no-idle]` | The Meetings service: the one owner of the meetings store while it runs, which the window, the CLI and agents reach over `<genesis-tools>/meetings-service/service.sock` (`service.json` beside it names its pid and checkout). A command finds it by itself and answers in its own process when none runs, with the same output. It exits after 10 minutes with no connection and when its code changes. `--stop` stops it (none running is no failure). The settings page's library is on it too: `projects.add`, `projects.rename`, `projects.remove`, `projects.labels`, `projects.unpair`, `projects.preview`, `dictionary.show`, `dictionary.add`, `dictionary.remove`, `dictionary.test` and `config.edit`, which `projects`, `dictionary` and `config edit` call with the same output |
| `reopen <meeting> <ids…> [--token <token>] [--reason <text>] [--json]` | Put confirmed or rejected items back to suggested (the Undo of confirm and reject). `--token` undoes one decision, by the token that `confirm --json` or `reject --json` printed; when another decision changed one of its items since, it is refused with `[item-changed]`. A question is reopened only by `listen`, and a confirm's line in the corrections ledger stays |
| `listen <meeting> [--item Q12] [--reason <text>]` | Answer the open questions by ear, one at a time: each range is cut with ffmpeg (padding `playback.listen.padBeforeSec` before it and `padAfterSec` after it, asked once on the first run for both sides), with a short tone just before the asked words (`playback.listen.tone`: `enabled`, `leadSec`, and its `sound`: a sine `{ hz, sec, volume }`, a preset `{ preset, volume? }` or a sound file `{ file, volume }`, see "The tone's sound"), and played `delaySec` (2) after the question shows, then again after each `repeatGapSec` (1) pause until the question is answered (`repeat`, on by default), also while a "Something else…" answer is typed. A word question shows the line its heard words are in, with the words marked and the lines before and after it. When the round already answered the same heard words at another time, that answer is the first choice and the question says when it was given. A speaker question shows each name's score beside it (`72 %`, see "Speaker candidate scores"); a name without one shows none. Esc goes back one step: from the comment to the choices, from the choices to the previous question, whose answer is undone. "Enough for now", or Esc on the first question, ends the round; the next `listen` goes on from there. Undo reverts only what that answer changed, so an item added meanwhile stays. `--item Q12` (or `12`, or the id `i42`) asks only that question and, after "Several voices", its parts. `--item Q12 --answer "<text>"` answers without audio, in a round of its own, or inside the round a person is listening to. `--reason` is kept in the decision journal with each answer |
| `listen <meeting> --subscribe-answers [--follow] [--from-start] [--timeout 120]` | For an agent: prints the running round's events as JSON lines (`round-start`, `answered`, `skipped`, `split`, `reopened`, `round-end`) while the person answers, from `questions.ndjson` in the meeting folder, and exits 0 at the round's end (an aborted round when the listener is gone), 2 on the timeout in minutes. `--follow` stays up across rounds (the Meetings window answers one question per round) and exits 0 when a round ends with no open question. `--with-comments` adds the comments the person sends from the window to the same stream: one line per comment with `"type": "comment"` (`id`, `text`, `quote`, the transcript `target`, the journal `token`), and every answer line then starts with `"type": "answer"`. Without the flag the stream is unchanged. While it runs, the window names it as the listener a send reaches. An `answered` line names the items it confirmed or rejected in `decided`; `settled` lists the other questions the same answer closed. Run it under a Monitor, so each answer wakes the agent |

### Meeting records

- `new [title] [--at <time>] [--project <name>] [--yes]`: create a meeting record by hand. `--at` defaults to now;
  `--yes` never prompts for a project.
- `new --source wisprflow:<id>`: create it from a source's meeting: title, times, people and the calendar entry.
- `list` (alias `ls`) `[--project <name>] [--limit <n>] [--json [--full]]`: the records, newest first. `--limit`
  keeps the newest n, after `--project`. `--json` prints one row per meeting (`id`, `title`, `start`, `end`,
  `project`, `labels`, `sources`, `context`, `items` counts, `recording`); `--full` prints the whole records, as
  `show --json` prints one.
- `show <meeting> [--json]`: one record, with its recording's state, frames per display, spans and warning. When the
  meeting has no project, it says how to set one.
- `revisions <meeting> [--json]`: one token per part of the Meetings window. An equal token means that part would
  read the same. It reads no transcript and no frame, so the window asks it on every return and reads again only the
  parts whose token changed.
- `set <meeting> [--project <name>] [--title <text>] [--label <text...>] [--unlabel <text...>]`: change a field. A
  new project name joins the known projects; a new label joins the project's labels.
- `link <meeting> wisprflow:<id> [--project <name>]`: attach a source's meeting to an existing record: its
  transcript, people, times and calendar entry. A source meeting that another record holds is refused with
  `[source-linked]` and the `merge` command to run, because two records would split one call. When the call started
  before the record (a record made when a screen recording started), the record's start becomes the call's, so its
  times match the transcript.
- `merge <meeting> --into <meeting> [--dry-run] [--json]`: make two records of one call one. The first meeting goes
  away; the `--into` meeting stays. Details under [Merging two records](#merging-two-records).
- `context add <meeting> [file|url] [--title <text>] [--note <text>]`: add reference material. A file is kept as its
  path, never copied. `--note` alone adds a note of its own.
- `context list <meeting> [--json]`, `context remove` (alias `rm`) `<meeting> <id>`: list the context, or remove one
  reference by its id (`c1`, `c2`, …).

### Projects and how a meeting finds one

- `projects list` (alias `ls`) `[--json]`: the known projects, with their dictionary size, labels and match rules.
- `projects add <name>`: add a known project.
- `projects rename <name> <new-name> [--json]`: rename a project everywhere it is named: its block (dictionary,
  labels, match rules, export folder), its source folder pairings and the project of its meetings. Refused when the
  new name is taken. `--json` prints `{ from, to, meetings }`.
- `projects remove` (alias `rm`) `<name> [--unassign] [--json]`: remove a project. Its block and pairings go into
  `~/.genesis-tools/backups/meetings/<time>-project-<name>.json` first. Refused while meetings have it, unless
  `--unassign` leaves them without a project. `--json` prints `{ name, unassigned, backup }`.
- `projects labels <name> [--add <label...>] [--remove <label...>]`: show or change the labels a meeting of the
  project can carry (for example "Checkout 2.0").
- `projects pair <name> --person "Name <email>"... [--note <text>]`: pair people with a project by hand, so a later
  meeting with them proposes it. A person is `"Name <email>"`, an email, or a name.
- `projects unpair --entry <id>`: remove the pairings one calendar entry made. A person that another source pairs
  stays.
- `projects unpair <name> --person <who>`: remove one person from a project.
- `projects people [name] [--json]`: the paired people of each project, with the sources that paired them.
- `projects preview [--draft <json>] [--limit 20] [--json]`: which project each recent meeting matches by the saved
  rules, or by a draft of them (`{"work":{"titleWords":["sync"],"calendars":[],"folders":{"wisprflow":[]}}}`).
  Reads only.
- `assign proposals` (alias `explain`) `<meeting> [--json]`: the ranked project proposals of a meeting and why, the
  overlapping calendar entries and the folder step. Reads only.
- `assign ask <meeting> [--force]`: post the meeting's project question to the decision inbox now. `--force` asks
  even when the meeting has a project or was asked before.
- `assign apply <meeting> --project <name> | --none [--label <text...>] [--entry <id>] [--pair-folder]`: apply an
  answer without the inbox: the project, the labels, the calendar entry whose attendees are paired, and the source
  folder pairing.
- `assign sweep [--json]`: one "ask each time" pass, as the watcher runs it: read back answers, then ask about each
  recent ended meeting without a project.

### Reviewing a transcript

- `suggest <meeting> [--rules speakers,evidence,terms] [--attendance <platform>|<file>] [--word-check <provider>]
  [--json]`: run the rules and add what they find as suggested items. A second run adds no item it already made and
  no question while the meeting has `questionCap` open. It first retires (rejects, with `evidence.retired`) the
  suggested words that a dictionary entry or the slang rule settles now, and the questions that decided only them.
  `--word-check` is `hunspell`, `hunspell-cc0`, `macos` or `off` (see [Configuration](#configuration)).
- `items <meeting> [--status suggested|confirmed|rejected] [--kind <kind>] [--json]`: the items with status,
  confidence and rules. Kinds: `speaker-range`, `label`, `join`, `term`, `question`. The `Q` column shows a
  question's number.
- `items add <meeting> ...`: store an agent's finding or a question. See [Adding findings](#adding-findings).
- `confirm <meeting> <ids...> [--speaker <name>] [--proposed <text>] [--json]`: confirm items. An id is `i42` or a
  question's number `Q12`. A range nobody named needs `--speaker`; `--proposed` gives a term's right spelling when
  the proposal is wrong. An item confirmed already is left as it is (`needs: "nothing"` in `--json`, exit 0), so its
  first Undo token still works. A skip that needs a value or an answer exits 1.
- `confirm <meeting> --min-confidence 0.9`: confirm every suggested item at or above that confidence.
- `reject <meeting> <ids...> [--min-confidence <0..1>] [--json]`: reject items; they are never suggested again.
- `confirm --json` and `reject --json` print `{ decided, token, skipped }`. The token is what `reopen --token` takes.
- `reopen <meeting> [ids...] [--token <token>] [--json]`: put confirmed or rejected items back to suggested (the Undo
  of confirm and reject). `--token` undoes one decision, by the token that `confirm --json` or `reject --json` printed
  (or `journal` lists). With no ids it undoes the whole entry, a speaker rename too; with ids, only those items. When
  another decision changed one of its items since, it is refused with `[item-changed]`. Without `--token` the ids are
  required. Only `listen` reopens a question, and a confirm's line in the corrections ledger stays. `--json` prints
  `{ reopened, skipped }`.
- `speakers stats <meeting> [--gap 2m] [--attendance <platform>|<file>] [--json]`: per label, its origin, turns,
  spoken time and spans, with hints about labels that hold several voices. A pause shorter than `--gap` keeps two
  turns in one span.
- `speakers rename <meeting> <label> <name>`: rename a source label for this meeting.
- `evidence <meeting> [--attendance <platform>|<file>] [--files] [--format table|json] [--json]`: which voice each
  label's lines are: the audio channel and the platform's speaking indicator, plus the volume check. `--json` (the
  short form of `--format json`) prints one row per line; `--files` also lists the evidence files and their sizes.
- `evidence <meeting> --raw [--word-check <provider>]`: the facts per line as JSON for an agent: label, text,
  channel, speaking, muted, present, the people, the silent call stretches (`meeting.callSilent`), the term part and
  the summary. It has no rule and no confidence. It reads existing evidence and cached energy without writing.
- `attendance <meeting> [--from <platform>|<file>] [--json]`: who was in the call and when. With `--from`, it stores
  that and the sections derived from it (one per join or leave). Details under [Attendance](#attendance).
- `play <meeting> --at <time> [--before 5] [--player vlc|ffplay] [--json] [--no-start]`: play the meeting's audio
  from a moment, to hear a voice before you confirm it. Details under [Hearing the audio](#hearing-the-audio).
- `play <meeting> --item Q12|i42 | --at 1:49:48 [--to 1:50:02] | --target '<json>' [--clip] [--no-start] [--json]`:
  the Moment of a target: the bounded clip `listen` would play, with its pad and its tone. Details under
  [Hearing the audio](#hearing-the-audio).
- `listen <meeting> [--item Q12]`: answer the open questions by ear, one at a time. Details under
  [Answering questions with listen](#answering-questions-with-listen).
- `listen <meeting> --item Q12 --answer "<text>" [--comment <text>]`: answer one question without audio. `"none of
  these"` rejects what it decides; `--comment` keeps a note on the question.
- `listen <meeting> --subscribe-answers [--follow] [--from-start] [--timeout 120]`: for an agent, print the running
  round's answers as JSON lines; `--follow` stays up across rounds.
- `listen <meeting> --clip-out <dir> [--item Q12] [--json]`: for an agent or a test, cut each open question's clip
  into a folder, and play nothing.

### Output

- `transcript <meeting> [--format md|txt|json|srt|vtt] [--json] [--with-suggested] [--timestamps] [--play-links]
  [--no-frontmatter] [--no-dictionary]`: the transcript with renames, confirmed items and the dictionary applied.
  Details under [The transcript](#the-transcript).
- `export <meeting> [--to <folder>] [--dry-run] [--if-edited beside|refuse|replace] [--json]`: write the polished
  transcript (md, play links, dictionary, confirmed items) as `<folder>/<meeting id>.md`. Details under
  [Export](#export).
- `overview [--days 14] [--json]`: the recent meetings by day with their badges (no project, open questions, unclear
  speakers, recording only, transcript only, suggestions at or above `global.suggest.applyAbove`), and the meetings
  that wait for you. The Meetings window reads it.
- `window [meeting] [--place needs|all|<project>] [--tab transcript|screen|items|speakers|context] [--no-focus]
  [--no-build]`: open the Meetings window of GenesisTools.app (the `meetings` app part). Settings → Meetings holds its
  settings pages. When the installed app lacks the Meetings part, the command builds it first; `--no-build` fails
  instead and says how to build it. `--no-focus` opens it behind the front window.

### Recording the screen

- `record start [--meeting <ref> | --source wisprflow:<id> | --title <text>] [--project <name>] [--display
  all|follow-focus|main|<index>] [--audio mic|system|mic,system] [--yes]`: record the screen: a frame when it
  changes, OCR per frame. It creates the meeting (titled after the calendar event around now, else the time) unless
  `--meeting` names one. `--audio` also records sound beside the frames. `--yes` never prompts (project,
  permissions).
- `record stop [--meeting <id>] [--started-at <iso>]`: stop the recording. It answers after the last frames, the
  summary and the collect. `--meeting` and `--started-at` stop only that meeting or that recorder run.
- `record pause`, `record resume`: pause and resume; the time paused is not recorded.
- `record status [--json]`: what is being recorded, with the frames per display.
- `record mark <label>`: a marker (1 to 80 characters) at this moment of the running recording. The record keeps it,
  and the meeting's `recording.json` lists it at its movie time, so the editor shows it.
- `record mute <source>`, `record unmute <source>`: mute or unmute `mic` or `system`; the file keeps silence for the
  muted time.
- `record set [--active-fps <n>] [--idle-fps <n>] [--threshold <percent>] [--max-long-side <px>] [--ocr | --no-ocr]
  [--ocr-languages en-US,cs-CZ] [--ocr-min-chars <n>] [--json]`: change the running recording's settings at once.
  With no option it prints them. These are the values the REPL's `meeting.setSettings()` takes, checked by the same
  schema. `--ocr-min-chars` (0 to 1000) stores shorter OCR text as no text. `--threshold` is a percent (0 to 100),
  while the config's `global.capture.threshold` is a share (0 to 1): `--threshold 2` is the config's 0.02.
  `--max-long-side` is the live form of `global.capture.resolutionCap`.
- `record display list [--json]`: the connected displays; `●` marks those recorded.
- `record display add <displayId>`, `remove <displayId>`, `switch <displayId>`: record a display too, stop recording
  it, or record only it. A change applies at once.
- `record display mode <all|follow-focus|main|index>`: record by a policy again, instead of chosen displays.
- `record cost [--json]`: the CPU each capture choice costs: 368.6 ms per kept frame (the meetings-ocr bench, 40
  frames, commit c15b15f99e) and the newest recording's frame rate.
- `record run <meeting> [--display <which>] [--audio <sources>]`: the recorder process itself. `record start` runs
  it; it is hidden from `record --help`.
- `screen <meeting> --at <time> [--window 30s] [--json]`: the OCR text of each recorded screen around a transcript
  time.
- `screen <meeting> [--at <time>] --boxes [--match <text>] [--level block|line] --out <dir>`: the OCR boxes of those
  frames in frame pixels: the ones holding `--match`, or without it the ones that changed since the display's frame
  before. Each frame is drawn with numbered boxes (`<frame>.boxes.png`), with a PNG crop of each box
  (`<frame>.<n>.png`). `--match` without `--at` searches every frame (`--limit 5`).
- `screen <meeting> --timeline [--all] [--json]`: every frame in time order with the OCR lines that changed since the
  display's earlier frame, in frame pixels. `--all` prints every line of each frame too.
- `screen <meeting> --timeline --frame <file> [--json]`: one frame of that timeline (its file as the timeline names
  it), with its changed lines and every line. A file the timeline does not hold exits 1.
- `screen-note <meeting> [--out <note.md>] [--json]`: write the screen OCR as a note. Details under
  [The screen note](#the-screen-note).
- `autostart on|off|status`: record the screen whenever Wispr Flow records a meeting (default off).
- `watch [--once]`: the watcher behind autostart and "ask each time". The daemon starts it at login when autostart is
  on or a project question waits. `--once` looks once and prints what it did.

### Dictionary

- `dictionary show [--project <name>] [--json]`: the merged dictionary: global, then the project.
- `dictionary add <value> [substitution] --type fix|abbr|term|keep [--project <name>] [--spoken <form>]
  [--meaning <text>] [--case-sensitive] [--replace <value>] [--if-absent]`: add or replace an entry. A new project
  name joins the known projects. `--replace <value>` renames: the entry replaces the one with that value in one
  write, and a refused entry keeps the old one. `--if-absent` only adds: an entry with that value in the level stays
  as it is, and the command exits 1 with `[dictionary-exists]` (an Undo needs this).
- `dictionary suggest [--project <name>] [--source wisprflow] [--apply 1,3|all] [--json]`: entries proposed from the
  source's own dictionary (Wispr Flow) and from corrections confirmed twice. `--apply` saves the numbered ones.
- `dictionary expansion [every|first|off] [--project <name>]`: how abbreviations expand, globally or for one
  project. A meeting can override it. Without a mode it prints the expansion that applies now.
- `dictionary remove` (alias `rm`) `<value> [--project <name>]`: remove an entry.
- `dictionary test "<phrase>" [--project <name>] [--json]`: the phrase after the dictionary, with each entry that
  fired and the words close to a term. Reads only.

### Settings

- `config show` (alias `get`) `[path] [--json]`: the settings with their defaults, or the value at one path.
- `config set <path> <value> [--expect <json>] [--json]`: write one value (JSON such as `2`, `true`,
  `["cs-CZ","en-US"]`, or plain text).
- `config unset <path> [--expect <json>] [--json]`: remove one key, so its default applies again.
- `config edit '[{"path": …, "value": …, "expect": …}, {"path": …, "unset": true}]' [--json]`: several changes
  in one write: all of them, or none when one is refused.

A path is dotted (`global.capture.activeFps`) or a JSON array of keys (`["projects","a.b","labels"]`). A write that
would make the config invalid writes nothing. A path that names no setting (`global.capture.activFps`) is refused by
`show` and `set` with the closest setting; `unset` still removes such a key. `--expect` is the value (with its
default) the change replaces: when another editor changed it since, the write is refused with `[config-stale]`.

### Workflow: polish a meeting

1. `tools meetings new --source wisprflow:<id>` builds the record and collects the platform, attendance and channel
   facts.
2. `tools meetings suggest <meeting> --attendance teams` scores the speakers and the terms and picks the questions.
3. `tools meetings listen <meeting>` asks the person the unsure questions by ear.
4. `tools meetings items <meeting>`, then `confirm` or `reject` what is left.
5. `tools meetings export <meeting>` writes the note into `projects.<p>.export.folder`.

An agent works in three passes instead: `evidence --raw` gives it the facts, it stores its judgement with
`items add --from-file`, and the person answers only what it cannot settle. The plugin skill `meetings` describes
that procedure (see [For agents](#for-agents)).

### Workflow: record a call

Run `tools meetings record start` before the call, or run `tools meetings autostart on` once, so the screen is
recorded whenever Wispr Flow records a meeting. `tools meetings record stop` ends it. When a source is linked,
`record stop` stores its clock, so `screen --at` takes transcript times.

### Adding findings

`items add` stores a finding with rule `agent` and the reason in `evidence.reason`. It stays suggested until a person
confirms it. `--confidence` is required for `speaker-range`, `join` and `term`; `--reason` is required for
`speaker-range`, `label`, `join` and `term`. The default kind is `question`.

```bash
# a stretch of a label that is someone else's voice
tools meetings items add last \
    --kind speaker-range \
    --from 38:12 \
    --to 38:20 \
    --label "Speaker 2" \
    --speaker "Alice Novak" \
    --confidence 0.85 \
    --reason "her microphone, and she answers the question before"

# a misheard term; without --proposed it is asked as free text when it matters
tools meetings items add last \
    --kind term \
    --at 1:02 \
    --heard "dé té l" \
    --proposed DTO \
    --confidence 0.4 \
    --reason "the project dictionary has DTO, and the line is about the API"

# a question of your own for listen
tools meetings items add last \
    --listen \
    --from 37:43 \
    --to 37:51 \
    --question "Who says this?" \
    --choices "Alice,Bob" \
    --decides i7 \
    --priority 2

# a batch in one write
tools meetings items add last --from-file findings.json
```

Flags per kind: `--from` and `--to` (speaker-range, label, question), `--at` (term: where it is heard; join: the
start of the line after the cut), `--label` (speaker-range: the source label; label: the label that tracks no one
person; join: whose voice speaks it), `--speaker`, `--heard` (term; question: the words marked until answered),
`--proposed`, `--scope line|everywhere` (term, default everywhere), `--joined` (join), `--about speaker|term|text`
(question, default speaker), `--question`, `--choices` (comma-separated), `--decides` (comma-separated ids or batch
refs), `--priority`.

`--priority` is on the scale `suggest` scores its own questions with (about 1 to 3, see
[Which items become questions](#which-items-become-questions)). A question under `playback.listen.minPriority` (0.5)
is asked only with `--item`.

`--from-file` takes an array (or `{ "findings": [...] }`) of objects with the flags' names (`kind`, `from`, `to`,
`at`, `label`, `speaker`, `heard`, `proposed`, `scope`, `joined`, `question`, `choices`, `decides`, `priority`,
`confidence`, `reason`), plus `meaning` or `quote` on a term, and `line` (the line's index, as an `items add` warning
names it) on a join or a term when two lines start in one second. Times are seconds or `"37:43"`. A `label` finding
carries `"meaningless": true`. A finding may carry a `ref`, and a question's `decides` may list the refs of its own
batch: they become the new ids. A term's `proposed` fixes the words everywhere unless `"scope": "line"`. One bad
entry adds nothing.

Each join and each term bound to a line is anchored to its line (`evidence.transcriptLine`). A time where no line, or
two lines, start is a warning, and so is each new item that would not apply. `items add` also warns about a question
whose text repeats another open question, one that decides no item, and one with no priority.

### Answering questions with listen

`listen` asks the open questions one at a time. Each range is cut with ffmpeg, padded by `playback.listen.padBeforeSec`
before it and `padAfterSec` after it (both asked on the first run), with a short tone just before the asked words
(`playback.listen.tone`: `enabled`, `leadSec` 0.4 s, and its `sound` as a sine `{ hz, sec, volume }`, a preset
`{ preset, volume? }` or a sound file `{ file, volume }`). The clip plays
`delaySec` (2 s) after the question shows, then again after each `repeatGapSec` (1 s) pause until the question is
answered (`repeat`, on by default), also while a "Something else…" answer is typed. Clips play with
`playback.listen.player` (`afplay` by default, then `vlc`, then `ffplay`).

- A word question shows the line its heard words are in, with the words marked and the lines before and after it.
- When the round already answered the same heard words at another time, that answer is the first choice, and the
  question says when it was given.
- Esc goes back one step: from the comment to the choices, from the choices to the previous question, whose answer is
  undone. Undo reverts only what that answer changed, so an item added meanwhile stays.
- "Enough for now", or Esc on the first question, ends the round. The next `listen` goes on from there; the rest stay
  marked in the transcript.
- `--item Q12` (or `12`, or the id `i42`) asks only that question and, after "Several voices", its parts.
- `--item Q12 --answer "<text>"` answers without audio, in a round of its own, or inside the round a person is
  listening to.
- `--subscribe-answers` prints the running round's events as JSON lines (`round-start`, `answered`, `skipped`,
  `split`, `reopened`, `round-end`) while the person answers, from `questions.ndjson` in the meeting folder. It exits
  0 at the round's end (an aborted round when the listener is gone) and 2 on the `--timeout` in minutes (default
  120). `--from-start` prints every earlier round first. `--follow` stays up across rounds (the Meetings window
  answers one question per round) and exits 0 when a round ends with no open question. An `answered` line names the
  items it confirmed or rejected in `decided`; `settled` lists the other questions the same answer closed. Run it
  under a monitor, so each answer wakes the agent.
- `--clip-out <dir>` cuts each open question's clip (only `--item`'s with it) into `<dir>/<Q12>.wav`, the same clip
  and tone the terminal plays, and prints one line per clip (`--json`: `[{ question, id, clip, fromSec, toSec,
  padSec, padAfterSec?, toneAtSec }]`; `padAfterSec` is present when the pads differ). It plays nothing, starts no
  round and changes nothing; without saved pads it uses 5 s on both sides instead of asking.

A question is `Q<n>` to people: the n-th question of the record, as listen's header and the polished file number it.
`items` shows the number in its `Q` column, and `confirm`, `reject` and `listen --item` take `Q12`.

### Hearing the audio

`play` opens the meeting's audio at a moment in VLC (`playback.player`, ffplay as fallback), `--before` seconds
earlier (`playback.beforeSec`, 5).

- `--player` picks the player for one call and is refused when it is not installed (never replaced by another).
- `--json` prints `{ audioPath, startSec, player, pid }` after the player started. The Meetings window starts ffplay
  this way (`-nodisp -autoexit`, no window) and pauses, resumes and stops it through `pid`.
- `--no-start` resolves the file, the start and the player and starts nothing, so an agent or a test checks a moment
  without sound (with `--json`: the same object without `pid`).
- A time more than 30 s after the last speech the source keeps is refused with that speech's time.
- Errors exit 1 with the sentence on stderr.

`play` with `--item`, `--at` and `--to`, `--target` or `--clip` plays the Moment of a target instead: the bounded
clip `listen` would play, with its pads and the tone before the asked spot (`playback.listen.padBeforeSec`,
`padAfterSec`, `playback.listen.tone`). `--tone <sound>` overrides the sound for this call with a preset, a sound
file or a sine JSON value.

- `--item` takes an item id or a question's number, `--at` with `--to` a range, `--at` with `--clip` a time (the rest
  of its line, 4 to 15 s), and `--target` any target as JSON: `{"kind":"item","id":"Q12"}`,
  `{"kind":"time","atSec":90}`, `{"kind":"range","fromSec":60,"toSec":75}`,
  `{"kind":"selection","from":{"atSec":60,"fraction":0.5},"to":{"atSec":70}}` (words picked in the transcript: a
  line's start and how far into its text) or `{"kind":"stretch","atSec":600}` (one speaker's turn, `speaker` to pick
  whose).
- `--clip` cuts it to `<meeting folder>/moments/<label>-<key>.wav` and plays nothing; `--no-start` only plans it;
  without either the clip plays once in `playback.listen.player`.
- `--json` prints the Moment: `{ meeting, target, label, fromSec, toSec, padSec, startSec, endSec, spotSec, tone?: {
  atSec, sound }, delaySec, repeatGapSec?, screen?: [{ file, path, at, meetingSec, displayId? }], path?, player?,
  pid? }`. `screen` names the frame on each display at the spot when the screen was recorded then.
- A target the meeting does not have exits 1 with `[unknown-item]`, `[no-time]`, `[bad-range]`, `[unknown-line]`,
  `[no-speech]` or `[past-the-end]` leading the sentence.

### Attendance

`attendance --from` takes a platform or a file:

- `teams` asks `tools ms-teams` by the meeting's title. A fresh home needs `tools ms-teams sync` first. A Teams call
  that lists its people without join or leave times (its call-ended message) counts them present for the whole call,
  and the note says how many.
- `facetime` reads the macOS call history. It keeps each call's start, length and remote handles, but no join or
  leave per person, so everyone is present for the whole call, the user included. It needs Full Disk Access.
- `google-meet` keeps no attendance on this Mac (Wispr Flow reads its speaking indicator only).
- A file is read in a platform's export format. `teams:<file>` names it (the output of
  `tools ms-teams meetings attendance --json`). A bare path is read in the meeting's platform's format, else in the
  one format its text fits.

Second 0 is the source's transcript clock. `suggest`, `speakers stats` and `evidence` read the stored attendance when
no `--attendance` is given.

### Export

The folder is `projects.<p>.export.folder` unless `--to` names one. Without either, `export` (also with `--dry-run`)
exits 1 and says to pass `--to <folder>` or to set the key; a meeting without a project needs `--to`. The Meetings
window asks for a folder instead and saves it on the project. An export creates the folder when it does not exist.
The same meeting again replaces its file.
`--dry-run` says where it would go and writes nothing. When the note holds edits that the last export did not write,
`--if-edited` decides (default `global.export.ifEdited`, `beside`):

- `beside` writes the new note as `<meeting id>.export-<local time>.md` next to it.
- `refuse` writes nothing and exits 1 with `[export-edited]`.
- `replace` overwrites the edits.

### The screen note

`screen-note` writes one section per frame whose text changed on its display, with its picture and its text. The
default file is `<meeting folder>/<id>.ScreenOCR.md`. Each picture is an APFS clone in `<note name>.frames/` beside
the note (no extra disk space; a plain copy where the volume cannot clone, and the log says so), linked by a relative
path, so Genesis Markdown shows it in a vault note. A second run adds nothing, and an `--out` that is another note is
refused.

### Merging two records

`merge <meeting> --into <meeting>` moves the frames, sound and their rows into the record that stays. The recording
blocks, context, labels, people and history merge, the start is the earlier one, and a generated title
(`Meeting 14:29`) gives way to the call's.

Both folders are cloned into `~/.genesis-tools/backups/meetings/<YYYY-MM-DD-HHMM>-merge-<meeting>/` first, with a
`README.md` of restore steps. The record that goes away moves there, its editor files are made again on the next
open, and its open project question is withdrawn. `--dry-run` says what would move and changes nothing.

It is refused for records of two source meetings, a record with items (decide them first), a record being recorded,
and frame names in both.

## How it works

### Where the data lives

- `~/.genesis-tools/meetings/<YYYY-MM-DD_HH-MM>-<title>/meeting.json`: one folder per meeting. The folder also holds
  `frames/`, `ocr.jsonl`, `audio/`, `audio.jsonl`, `questions.ndjson` (the listen answer log),
  `evidence/energy.bin` (the cached channel energy, rebuilt when the audio is newer) and the editor files
  (`recording.json`, `proxy.mp4`, `proxy.transcript.json`).
- `~/.genesis-tools/meetings/config.json`: the settings (see [Configuration](#configuration)).
- `~/.genesis-tools/meetings/corrections.jsonl`: the corrections ledger. Every confirmed term or join is written here.
- `~/.genesis-tools/meetings/retention-last.json`: when the retention pass last ran.
- `~/.genesis-tools/backups/meetings/`: the backups of `merge` and `projects remove`.
- `~/.genesis-tools/recordings/live/<id>.json`: a running recorder (kind `meeting`), with its JSON-RPC socket beside
  it.
- `~/.genesis-tools/downloads/transcribe/`: the word check dictionaries, downloaded on first use.

### What it calls and needs

- **Wispr Flow** is the transcript source: its meetings, transcript, people, folders and calendar. Wispr Flow cannot
  be changed from here: its MCP tools only read, and its `wispr-flow://` scheme only opens pages.
- **Apple Calendar** (which holds the synced Outlook and Teams accounts) gives the calendar entries that overlap a
  meeting, merged with Wispr Flow's own calendar, which has the attendees' emails. It needs Full Access to Calendars
  for GenesisTools.app (`tools macos calendar doctor` checks it). Without it, the project question and
  `assign proposals` say `apple-calendar not read` with the fix, and `record start` titles a new meeting by the time.
- **`tools ms-teams`** gives Teams attendance; the macOS call history gives FaceTime attendance (Full Disk Access).
  FaceTime attendance names each handle through Contacts (GenesisTools.app's Contacts grant), else the call's own
  name, else the handle itself.
- **Screen Recording** permission for whoever captures: GenesisTools.app when it is installed, else the terminal.
  `tools macos permissions` shows the grants.
- **ax-tool** (GenesisTools' own ScreenCaptureKit recorder) captures by default; Peekaboo is the other backend.
  Vision OCR reads the frames on this Mac.
- **ffmpeg** cuts the listen clips and reads the audio energy. **VLC** or **ffplay** plays audio for `play`;
  `afplay` plays listen clips.
- **The decision inbox** of `tools question` (the widget inbox, the dev-dashboard `/qa` page and a notification)
  carries the project question.
- **The browser router** preset `meetings-play` opens a `--play-links` time at its moment.
- **The GenesisTools trash** (`tools rm`) takes expired frames and sound.

Nothing calls a paid API. The word check downloads its dictionaries from GitHub on first use. The real cost is CPU:
`record cost` prints it.

### The meeting record

Every change adds one line to the record's `history`, and a change that would make the record invalid writes nothing.

Every command that creates or changes a meeting resolves its project in this order: `--project` (a new name joins the
known projects), the meeting's own, one matching project (`projects.<name>.match`), a choice in a terminal, and
without a terminal no project. `show` then says how to set it.

A meeting has one project and any `labels`, so meetings group finer without sub-projects.

### Ask each time

A meeting that ended with no project gets one question in the decision inbox, once. It is asked when the meeting
ends, whatever started its recording: the recorder process asks after its stop, and `new --source` and `link` ask
when the source gives the meeting its end.

The watcher asks on each look too (`assign sweep`), and its sweep is what reads the answers back. So it runs while
autoRecord is on, and, with autoRecord off, while a question or a folder step waits (an end that posts a question
starts it). Only meetings that ended after the first sweep (or the first ask) are asked, within
`global.assign.lookbackHours` (48). An end that cannot be asked about (the record does not show the end, or the post
fails) is a warning in the day log that names the meeting.

The question ranks the known projects, each with its reasons, best first (`assign proposals` shows the same):

| Reason | Points |
|---|---|
| The meeting's source folder is paired (`sources.wisprflow.match.<p>.folders`) | 100 |
| An overlapping entry is in a project calendar (`match.calendar.calendars`) | 60 |
| The title has one of the project's words (`match.title.words`) | 40 |
| Paired people are on an overlapping entry, or in the transcript | 15 each, 60 at most |
| Title words the project's earlier meetings had | 8 each, 24 at most |

It also lists the calendar entries that overlap the meeting, the labels, and the Wispr folder step. A calendar that
cannot be read says so in the question; an unread calendar is never "no entries".

The answer applies everything at once: the project (a new name joins the known projects), the labels, the picked
entry (its attendees are paired with the project, `pairedBy: [{ kind: "calendar", entryId, ... }]`) and the folder
pairing. A wrong pick is undone with `projects unpair --entry <id>`: it removes only the pairings no other source
holds.

The Wispr folder ladder: a meeting in a folder no project has is offered to pair that folder. For a meeting in no
folder, the question tells you to move it in Wispr Flow, and the next sweep that sees it in a folder asks to pair that
folder. The folder step ends after `global.assign.folderWaitDays` (14).

### Recording

`record start` checks Screen Recording first, by the classic route: granted already, then the macOS prompt for the
identity that captures (GenesisTools.app when it is installed, else the terminal), then GenesisTools.app's own
permission window, and without the app it says what to install and grant. Without a terminal (`--yes`, the daemon) it
never prompts and only says what to run.

The recorder is a frame recorder from `src/utils/screen-recorder/` (`capture.backend`: `native`, GenesisTools' own
`ax-tool capture`, by default; or `peekaboo`). It records in 30 s pieces with the capture policy every recorder
follows (`capture.activeFps`, `idleFps`, `threshold`, `resolutionCap`) plus the recorder's own block
(`capture.recorders.native`: `quietMs`, `heartbeatSec`, `maxMb`; unset keeps ax-tool's own;
`capture.recorders.peekaboo` has no keys of its own). It converts each frame to JPEG under the meeting's `frames/` as
`<HH-MM-SS-mmm>-d<displayId>.jpg`, and appends Vision OCR to `ocr.jsonl` (each line names its `displayId`) in the OCR
languages of the meeting language (`languages.<global.language>.ocr`, `cs-CZ` and `en-US` for `cs`). Each capture
ends at its duration plus 30 s; a hung one is stopped and counts as a failed capture.

A frame is taken only when the screen changes, so `screen --at` shows, per display, the frame still on that screen. A
time outside the recorded spans says so and when the recording ran.

#### OCR settings

`capture.ocr` decides which kept frames OCR reads.

- `threshold` (0 to 1, default 0) is an OCR-only change threshold beside `capture.threshold`: a kept frame that
  changed less keeps the previous frame's text for its display.
- `skipTextless` (default off) reads the changed area at Vision's fast level first. A frame whose changed area holds
  no text, before or now, keeps the previous text too. A skipped frame's `ocr.jsonl` row carries the copied text and
  `skipped` (`below-threshold` or `no-text`).
- `region` (`frame` by default, or `changed`) reads only the changed areas of a frame (at most four, each grown to
  hold every line it touches) and keeps the previous frame's other lines. The row's `blocks` stay in whole-frame
  coordinates, and `regions` lists the areas read. It is off by default because a crop costs about as much as a whole
  read (each Vision call costs about 110 ms of CPU or more) and reads more small text than a whole read of a wide
  frame does, so the text would change ([benchmarks-cpu.md](../../docs/benchmarks-cpu.md), 2026-11-05).
- `read` selects `frame` or `tiles` (default) for a full-frame read, including the first frame and display switches.
  `frame` keeps the whole-image read with language correction. `tiles` reads the original image through Vision
  regions with language correction off: a grid whose cells are at most `capture.ocr.tilePx` (default 960) frame
  pixels on their longest side, top row first, so a 2880 px frame is read as 3×2. Each tile is its cell plus 3% of the
  image past each inner edge, so a tile can be larger than `tilePx` (the middle tile of a 2880 px frame is 1133 px
  wide). A line read twice, or a seam tile's cut piece of a line another tile read whole, is kept once (the whole
  line), and block bounds stay in full-image coordinates. On 12 kept frames of three displays (2026-11-09) the 3×2
  grid read 86% of the words any grid read, against 80% for the two strips and 42% for one region, at about 400 ms CPU
  per frame against 180 ms; a smaller `tilePx` reads smaller text and costs more CPU (720: 88%, 440 ms). No tile crop
  files are made. The vertical-crop fallback
  for images larger than 6000 pixels is unchanged. `region: changed` still controls changed-area crops on its own;
  `read` applies when a full-frame read is needed. The default and second-meeting measurements are in
  [benchmarks-cpu.md](../../docs/benchmarks-cpu.md).

The first frame of each capture and each display switch is always read whole.

#### Displays

`capture.displays` picks what is recorded: `all` (default) records every connected display at once, one capture per
display per piece; `main`; `follow-focus` (the display of the focused window, when the recorder supports it, else the
main one); or a screen index. Each piece reads the display list again by id, so a display that is connected joins at
the next piece, and one that is removed leaves without an error. When an asked index is not connected, the main
display stands in, and the warning says since when.

#### Sound

Sound is off by default (the transcript source records it). `capture.recorders.native.audio` (`sources`,
`micDevice`, the microphone's device UID from `ax-tool audio-devices`) or `record start --audio` turn it on. One
capture per piece records it as `--audio-sidecar` `.m4a` files, moved to `audio/`, with muted spans in `audio.jsonl`.
Peekaboo records one display at a time (its ScreenCaptureKit lock), so `displays: "all"` falls back to the main
display with a warning.

#### The live recorder and its socket

While it runs, the recorder is a live recording (`<genesis-tools root>/recordings/live/<id>.json`, kind `meeting`)
with a JSON-RPC socket beside it. The socket serves the recorder's `RecorderControl`
(`src/utils/screen-recorder/control.ts`), the one method set of every recorder kind: `status`, `pause`, `resume`,
`stop {wait}`, `displays.list|add|remove|switch|mode`, `jobs.list`, `audio.list|mute|setInput`, `settings.get|set`,
and `subscribe` (events `state`, `frame`, `displays`, `warning`, `progress`, `ended`). `RecorderClient` is the same
interface over the socket, and the `record` commands use it.

With ax-tool's `--control-stdin`, a pause, a display switch, a settings change, a mute and a microphone switch go to
the running capture without a restart, and frames reach the socket as they land. A recorder without the command
restarts that capture. The OCR backlog, the summary and the collect run on the shared job runner
(`@genesiscz/utils/jobs`) as `progress` notifications. `stop` answers after them, or at once with `{wait: false}` and
the job id.

#### The recording block

The `recording` block of the record has a schema (`RecordingBlock` in `src/utils/meetings/record.ts`): `spans` (from,
to and stop reason: `requested`, `paused`, `failed`, `error`), `frames` and `bytes` (every frame in `frames/`, also
those of an earlier start), `displays` (id, name, frames), `backend`, `displayPolicy` and `warning`. Records from
before the schema still read.

Three failed pieces in a row stop the recorder with `stopReason: "failed"`; any other error stops it with `"error"`.
Both always write the stop and post "Screen recording stopped" once per failure episode, for recordings a person
started too, and the recorder process (`record run`) then exits 1. A recording without a frame says so in its
warning.

#### Retention

Frames stay on this Mac and never go into an export. Once a day the watcher moves the `frames/`, `ocr.jsonl`,
`audio/` and `audio.jsonl` of each meeting whose newest capture file (a frame, an OCR line or a sound track) is older
than `capture.retentionDays` (30) into the GenesisTools trash (`tools rm` rules, restorable with
`tools rm restore <batch>`), so a recording with sound only expires too. The editor files made from them
(`recording.json`, `proxy.mp4`, `proxy.transcript.json`) go with them. Opening the editor rewrites those files, so it
never postpones a meeting's retention. The meeting record, its items and the recording block stay. The pass never
touches the meeting being recorded, and `retention-last.json` beside the meetings says when it last ran.

### Autostart and the watcher

`tools meetings autostart on` sets `sources.wisprflow.autoRecord.enabled` and starts the watcher; the daemon starts it
at every login while it is on. The watcher follows the first source in the source registry (`lib/sources.ts`) whose
`sources.<id>.autoRecord` is on, today Wispr Flow.

- Every 15 s the watcher asks Wispr Flow for a meeting it has not ended whose live transcript changed in the last
  `liveWithinSec` (30). It then runs `record start --source wisprflow:<id> --yes` and posts a notification (`notify`,
  default on).
- It stops only the recordings it started, when Wispr Flow ends the meeting. Silence never stops one, since a
  listener who stays quiet is still in the meeting.
- A start that failed (no grant) notifies once and is not retried for the same meeting.
- A recorder that stopped on its own while the meeting runs (`stopReason: "failed"` or `"error"`) is started again
  2 min after it stopped, with `record start --meeting <id> --yes`, and every 2 min after that; the recorder posts the
  notice. A stop the user asked for stays stopped. A stop that failed keeps the watcher's claim, so the next look
  stops it again.
- When Wispr Flow ends the meeting, the watcher links it again (title, end, people) on each look until the record has
  an end, for up to 10 min.

### Items and the rules

A rule's finding is an item with a confidence and the rules that produced it. A person confirms or rejects it; only
confirmed items change a transcript. `--with-suggested` previews the rest: it applies a suggested item at
`global.suggest.applyAbove` (0.5) or more, and one with no confidence (a person's own); a lower one is marked unclear,
as an open question is.

The rules are one documented enum, `MeetingRule` in `src/utils/meetings/rules.ts`. Two rules that reach the same item
merge into one, with the confidence 1 − (1 − a)(1 − b), at most 0.95.

- `speaker-range`: lines of a label that belong to someone else. RA (Teams attendance) names the people in the call
  as candidates, or the one person left. R1 and R5 mark a goodbye the label keeps talking after, R13 when another
  label answered it, R14 when it echoes another label's goodbye.
- `speaker-range` from the `evidence` rules: E1, the audio channel (the user's microphone is always the user; a line
  where the microphone wins below 90 % asks to listen first), with E3 (the platform's speaking indicator) and E4 (its
  live name, overruled when attendance says that person was not in the call). A range holds only consecutive lines of
  its label that carry its finding; a line without one closes it.
- The audio energy (only with a calibrated channel layout) beats the coarse live segments: 90 % or more on the
  microphone is the user (0.85, or 0.75 where the segments said the call; E3 and E4 never overrule it), 10 % or less
  is never the user. Where the segments are mixed (neither channel holds 90 %), 70 % or more is the user (0.55, to
  ask) and under 50 % is not. A line no segment covers is the user only at 90 % or more.
- The label's own voice: a label the platform named after a person (`origin: platform`) is that person's voice. The
  rules do not move its call lines to another person, even when E3 and E4 both name someone else. A mixed line under
  it stays with that person when E3 shows only that person speaking, unless 80 % or more of the energy is on the
  microphone (then it is the user's). R17: when such a person talks under their own label within 10 s of another
  label's line, and E3 shows them and one other present, the line is the other's (0.65).
- A silent call channel: where the call's channel stays at its noise floor for 5 min or more while the microphone
  hears speech, and two labels talk there (or E3 shows others speaking), the call played through the room's speakers
  and the microphone carried every voice. E1 and the energy say nothing there. R19: the label with the most sure
  microphone lines where the channels work (leading the next by 1.25 times) stands for the user there (0.5, to
  listen).
- R18, a second person in the room: a platform-named label that holds a quarter or more of the sure microphone lines
  (30 at least) and call lines of its own carries someone else on the microphone. Its microphone lines name the people
  in the call as candidates (0.4); the user's sure microphone lines are capped at 0.7 and asked, and a line under 90 %
  stays its label's.
- A stuck speaking indicator: E3 showing the same one remote person for 6 min or more while a third of the lines are
  on the microphone is ignored for that stretch.
- R20, swapped labels: in 5 min windows of a calibrated recording, the user's label sits on the call's channel (median
  microphone share 0.3 or less) while one platform-named label sits on the microphone (0.7 or more) for 10 min or
  more (from the first swapped line's start to the last one's end, within 30 s), and the two read the other way
  elsewhere in the call. The recorder swapped their names there: the other label's lines are the user's and the user's
  label's lines are the other person's, one item each over the stretch (0.5 plus half the gap of the two medians, at
  most 0.9). R16 (arrivals), R18 and the per-line rules leave those lines alone.
- `join`: a word cut between two lines ("dot" + "áhnu"), or one sentence cut between two whole words: a `joined`
  value with a space ("jsem zvědavej") keeps the space.
- `term` from the word check (rule `unknown-word`, 30 %): a word no dictionary layer knows. It proposes nothing (the
  closest terms are all below the suspect threshold, so they stay in `evidence.candidates`). A word said on purpose
  gets no item: a word family heard in two or more forms (`wordFamily`, the first four letters of the stem after one
  Czech prefix: "mokovaný", "namokovat", "nemokovaný"), or a Czech form of a known English word ("mokovat" from
  "mock"). A `keep` entry covers every form of its family.
- `term`: a misheard term and its proposed spelling, a passage read aloud from a context file (its quote and line),
  or a spoken path or identifier (its meaning after the words). A context file is read as the meeting saw it: when it
  changed or was deleted after the meeting, from its last git commit before the meeting's end; `suggest` warns when no
  copy is left. With `global.suggest.restatedIdentifiers` at `skip` (the default), a plain code name that only writes
  the said words in code form ("entity data", `EntityData`) gets no meaning; a path, a member chain or a
  CONSTANT_CODE still does. `mark` adds them all.
- `term` from the dictionary (rule `dictionary-fuzzy`): see [The dictionary](#the-dictionary).
- `label` (`meaningless: true`): the label tracks no one person from `fromSec` to `toSec`. The rules see its lines
  there under a label that names nobody, and the transcript marks each such line no range or join gives a voice as
  `[nejasné: "<label>"]`. Its outcome is the lines it marked, or shadowed when ranges gave every line a voice.
- `question`: something to decide by ear (`about`: speaker, term or text), with its time range, `choices` and the
  items it `decides`. Answering it confirms each decided item with the answer (a range's speaker, a term's spelling);
  "none of these" rejects them; a skip leaves them as they were.
- "Several voices" cuts a question at each line inside it and, in a line of 3 s or more, at each change between the
  microphone and the call (half-second energy windows). Each part shows its words and plays only its own audio. Two
  remote voices in a row stay one part. With nothing to cut, the question stays open. A speaker question shows the
  words of its span and plays only that span, from the tone on.

### Which items become questions

Only what is unsure and matters (the owner's decision, 2026-11-02: "just on those which are really important and not
sure of"):

1. Confidence under `global.suggest.listenBelow` (0.6). A mixed channel alone is no reason to ask.
2. A speaker range needs more than 5 words that are not all fillers, and 15 words or a decision or action word
   (`src/utils/transcribe/importance.ts`). A term needs two occurrences, an identifier, a person's name from the
   summary, or a decision in its line; any other low term is only marked in the transcript. An unknown word with
   nothing proposed needs an identifier's shape (`OpenAI`, `CTOčko`), or two occurrences with a capital that no
   sentence start explains (a name). A lowercase unknown word is speech (a colloquial form or slang): it stays an item
   in `items`, and gets no question and no mark in the transcript. One line gets at most one such question.
3. A goodbye or attendance range is dropped when finer audio-evidence items cover 80 % of it.
4. Speaker questions cluster only for the same single label, exact range and clip times, and choices. Separate
   neighbouring passages stay separate.
5. Priority = (1 − confidence) × impact × reach. Impact is log2(1 + words), +3 for a decision word, +3 when the
   range cites a summary action item or decision (`global.summary` headings), +2 when the answer moves an action's
   owner. Reach counts the questions with the same signature (top two choices and the people present). One unsure
   question usually scores 1 to 3, a cluster 6 or more. A question an agent adds takes `priority` on the same scale, so
   suggested and added questions sort in one order and `minPriority` means the same for both.

A meeting has at most `global.suggest.questionCap` (12) open questions, whatever the number of `suggest` runs.
`listen` asks by priority, at most `playback.listen.roundCap` (12) per round and none under `minPriority` (0.5). A
split uses no budget: its parts come next and share their parent's unit, so the header shows `3/12 · part 2/4`.

Through the service an answer can leave its look-alikes open: `decision.apply` with
`{ kind: "answer", question, answer, lookAlikes: "leave" }` decides the question and what it decides, nothing more
(the window's "Only this question" in its "This also affects" sheet). `listen` always settles them.

Each answer settles compatible look-alikes. A speaker answer requires the same single label, exact range and
signature, and an offered answer; its items gain +0.3 up to 0.9, closing questions that reach the threshold. A word
answer propagates only between questions with the same heard words and choices that decide exclusively global terms
("settled by the answer to i7"); the `answered` event lists them in `settled`, and an undo reopens them (`reopened`
with `also`).

A word question finds its heard words as whole words (`TranscriptLines` in `src/utils/transcribe/lines.ts`), so
"Ada" never matches inside "zadání". Its clip is cut around
the spot the words are said, and two questions on the same words over the same range take the first and the second
occurrence, each with its own time and line.

### Speaker candidate scores

Each speaker range the rules make carries `evidence.candidateScores`: one entry per person the voice could be,
`{ speaker, confidence, lines?, evidence: [{ kind, rule?, lines?, against? }] }`, best first (`lib/speaker-scores.ts`).
A speaker question's choices show them: `rows` and the Meetings window as each choice's `confidence`, `listen` as
`72 %` beside the name. A term keeps its own `evidence.candidateScores` (`{ term, confidence }`).

- The range's speaker keeps the rule's confidence, so one choice never shows two numbers. A range without a speaker
  gives its confidence to its candidates; the label's own person gets no score there, because the rule says the voice
  is not theirs.
- The other people share what is left by weight, per share of the range's lines: the user's microphone holds the line
  (1), E3 shows them speaking (0.5), E4 names them (0.1), they are in the call (0.2, never for the user, who is always
  in their own call), they talk under their own label within 10 s (2, the turn timing: one voice cut into two
  labels), an agent's range over the same lines names them (2 times its confidence and overlap, the polish). A voice
  the roster does not list keeps 0.2, or 0.05 when attendance is known.
- The evidence kinds are `voice`, `roster`, `timing`, `polish`, `directory` (the people directory folded two names of
  one person into one candidate) and `answer` (an answer raised the range; the others then keep their proportions).
- A person with no evidence gets no score. A question over several ranges shows a name's lowest score, and none when
  one range does not score it. A range suggested before the scores existed shows a number on its speaker only.
- Checked on 2026-11-10 on the two recorded meetings with answers: 62 fresh engine ranges whose lines an agent's
  confirmed range or an answered question names. The suggested speaker was right in 26 of 36 (mean confidence 0.69).
  The top-scored name is right in 39 of 62, and in 14 of the 26 ranges without a speaker, which had no number before.
  The other names' scores hit about as often as they say: a mean of 0.04 hit 7 %, 0.18 hit 26 %, 0.36 hit 31 %.
  Change a weight only after the same check.

### Context documents: quotes and meanings

The meeting's context files and notes feed two term rules (`@genesiscz/utils/transcribe/doc-match`). Each item is
bound to its line (`atSec`), so it never changes the same words elsewhere.

- `read-aloud`: a passage that says a document line in order, densely on both sides (a reader may skip its code
  spans), with three prose words at least. The item's `quote` holds the line. The transcript shows its exact text
  instead of the misheard words, as a quote block in Markdown and in quotation marks elsewhere, with the source
  (`(čte z Roadmap, ř. 33)`, from `languages.<global.language>.render.readAloudLabel` and `lineLabel`). The
  dictionary does not touch the quoted text.
- `spoken-identifier`: two or more words that say a document identifier in order ("employee only" for
  `employeesOnly`, "administration CMS schema" for `/administration/cms/schema`), or one path segment after "lomeno"
  or a slash (`/{type}`). A comma between the words ends the run. The words stay; `meaning` names the identifier,
  shown after them. An identifier is marked at its first mention and again after two minutes without one.

### The transcript

`transcript` applies renames, confirmed items and the dictionary.

- `--json` is the short form of `--format json`.
- `--timestamps` shows the start time of each paragraph. `--play-links` (md) links each start time to its moment
  through the router preset `meetings-play`, and implies `--timestamps`.
- `--no-frontmatter` (md) leaves out the front matter. `--no-dictionary` does not apply the dictionary.
- In md an expansion and a term's `meaning` (first mention) are a `<sup>`; txt, srt and vtt keep them in parentheses.
- An open question shows as `[nejasné: "<raw>"; 1) … 2) …]` (`languages.<global.language>.render.unclearLabel`).
  `--with-suggested` applies the top reading instead.
- Each applied item that did not change the transcript is a warning (`i42 did not apply: no "X" at 37:43`,
  `… 2 lines start at 37:43`, `… i41 changed "X" first`).
- In md the front matter's `speakers` maps each person after the corrections to their line count; `unattributed`
  holds the source labels nobody named.

#### Transcript lines and the corrections pipeline

`src/utils/transcribe/lines.ts` is the one place that knows a transcript's lines. A line's address is its index in the
source transcript plus its start. A line ends at the next timed line's start, at least 1 s on, and the last one 5 s
on. The line at a time is the one starting within 0.5 s of it; two such lines (Wispr times whole seconds) are reported
as ambiguous and never guessed. Heard words match whole words only, in any case (Czech letters too), with diacritics
as written and any run of spaces: "Ada" never matches inside "zadání". The spot where words are said is estimated
from their place in the line, and a word's clip is cut around that spot.

`correctTranscript` in `src/meetings/lib/transcript-corrections.ts` is the corrections pipeline. It takes the record's
decided items (with `--with-suggested`, also those at `applyAbove`), the dictionary and the open questions, and
applies them in one order: joins, ranges, open speaker marks (on the source label, never on a line a range or a join
already voiced), renames, quote and meaning marks, term fixes, the dictionary, open words. It returns the lines and
one outcome per item: applied (with its lines), not found, ambiguous, or shadowed by another item. A meaning is
wrapped in backticks once, also when it was stored with its own. `ledgerEntryFor` is the corrections-ledger entry of a
confirmed term or join, for every path that confirms one.

#### The opened meeting and the call timeline

`OpenedMeeting` in `lib/opened-meeting.ts` opens a record once and gives, read lazily and once: the linked source and
its meeting (the first source block that names a meeting, `sourceRefOf` in `lib/sources.ts`), the evidence with the
speaking readings dropped on a platform without an indicator, presence with the user under their own name, the energy
share, the silent call stretches, the dictionary, the summary points and the word check. Reading never writes the
record. `collect` (platform, attendance, channel layout) and `calibrate` (`evidence.channels` with `callSilent`) are
the explicit steps. They are methods, not commands: `new`, `link` and `record stop` run them, and `suggest` runs them
when their facts are missing. `suggest`, `evidence`, `evidence --raw`, `attendance`, `speakers stats` and `items` open
meetings through it.

`CallTimeline` in `lib/call-timeline.ts` owns the transcript clock: second 0 is the source's `recordingClock`, else
the clock the recorder stored from it at `record stop`, else the record's start. It loads stays from a platform
(`MEETING_PLATFORMS`: Teams, FaceTime, Google Meet) or from a file in a platform's export format
(`MeetingPlatform.attendanceFile`), names the user once, and stores stays and sections once. A new platform with an
export format is one `attendanceFile` reader.

The round of `listen` is one module, `ListenSession` in `lib/listen-session.ts`: which question comes next, the
budget, each decision as per-item changes with their inverse, look-alikes, the answer log and the ledger. A
`ListenAdapter` asks the person: the terminal (clack and audio, in `commands/listen.ts`) or `GivenAnswerAdapter` for
`--answer`.

## People

The people directory answers "who do we know" from every place a person is named: a meeting's participants,
attendance, calendar attendees, speaker renames and assignments; the projects' paired people (`projects.<p>.match.people`);
Contacts (`contacts.search`, under GenesisTools.app's Contacts grant); and the people book,
`~/.genesis-tools/meetings/people.json` (`{ version: 1, entries, merges, hidden }`: people added by hand, merges,
hidden people). One person is the same email, or, when either side has no email, the same name tokens (`nameKey`:
"Dana Exámple" and "dana example" are one person). A record is read again only when its file changed.

- **Ranking** for a meeting and a moment (`people --meeting <m> --at <time>`, the Meetings service's `people.known`):
  the people in the call at that moment, then that meeting's people, then other meetings by count and recency, then
  Contacts, then the people book. Nothing is preselected.
- **Merges** are aliases in the people book. No meeting record changes, so `unmerge` undoes a merge fully.
- **Assignments** (`people assign`, the decision journal's `assign`) live in the record as `speakers.assignments`,
  one per source label and stretch. A later assignment over the same lines wins over an earlier one and over a
  confirmed speaker range. The journal keeps each one's before and after, so its token undoes it; one changed since is
  refused with `[item-changed]`. Its plan names the other stretches it may reach: the same label inside the hint range
  around it, or in the sections with the same people present, never "sounds the same".
- A rename to a name another label holds already is planned with the warning that both labels become one person.
- `listen`'s typed answer completes from the record's people, then the directory's people for the meeting, then the
  dictionary. It never reads Contacts.
- Settings: `global.people.sources.contacts` and `global.people.sources.calendar` (both `true`). A refused Contacts
  grant is a reason in `sources`, never an empty list.
- A `people.json` that is not JSON reads as empty, and the next write moves it aside to `people.json.broken-<time>`.
  A value this build cannot read (a newer build's) is kept and written back.

### The dictionary

Entry types:

- `fix`: a misheard spelling, replaced at every whole-word match in any letter case (`DTLčko` becomes `DTOčko`, and so
  does `dtlčko`). `--case-sensitive` (config `caseSensitive: true`) keeps the exact-case match.
- `abbr`: an abbreviation. Its substitution must contain the abbreviation itself, so the original stays: `SLA`
  becomes `SLA (Service Level Agreement)`. A substitution without it is refused.
- `term`: a correct spelling the misheard-term check should know. `--spoken` lists how people say it, and
  `--meaning` stores what it means (shown after its first mention in Markdown).
- `keep`: a word the misheard-term check must never flag.

A whole-word spoken form of a `term` is replaced by the term (`--spoken jenezetka --spoken jenezetkou` for `JDZ`).
Other words are compared with the terms and their spoken forms after the Czech ending is stripped (`jenezetkama` and
`jenezetka` share `jenezet`). A level's `fuzzy: { apply, suggest }` (default 0.95 and 0.8) decides what happens: at
`apply` or above the word is replaced; from `suggest` up to `apply`, `suggest` makes a term item with the score (rule
`dictionary-fuzzy`); below it nothing happens.

Levels merge in this order, a later one winning: global, the project, the meeting. Abbreviations expand at every
mention by default (`every`); `first` expands only the first mention in a transcript, `off` none.

## Configuration

`~/.genesis-tools/meetings/config.json`. Every key has a default, so the file holds only what you changed. Read and
change it with `tools meetings config` (Settings → Meetings in GenesisTools.app holds the same settings). Every write
is checked against the whole schema, and a change that would make the file invalid is refused and leaves the file as
it was. A key that varies by recorder, source or language sits under that axis:

```jsonc
{
    "version": 4,
    "global": {
        "dictionary": { "abbrExpansion": "every", "entries": [] },
        "language": "cs",
        "capture": { "backend": "native", "activeFps": 1, "retentionDays": 30, "recorders": { "native": { "maxMb": 400 } } },
        "playback": { "player": "vlc", "beforeSec": 5, "listen": { "roundCap": 12 } },
        "suggest": { "questionCap": 12 },
        "assign": {
            "ask": true, "lookbackHours": 48, "maxProposals": 5, "calendarSlackMin": 15,
            "calendarLookbehindHours": 3, "folderWaitDays": 14, "retryFailedMin": 10
        },
        "export": { "ifEdited": "beside" },
        "people": { "sources": { "contacts": true, "calendar": true } }
    },
    "projects": {
        "work": {
            "dictionary": { "entries": [{ "type": "abbr", "value": "SLA", "substitution": "SLA (Service Level Agreement)" }] },
            "labels": ["Checkout 2.0"],
            "export": { "folder": "/Volumes/Notes/app/meetings" },
            "match": {
                "calendar": { "calendars": ["Work"] },
                "title": { "words": ["Planning"] },
                "people": [
                    {
                        "name": "Alice Novak",
                        "email": "alice@example.com",
                        "pairedBy": [{ "kind": "calendar", "from": "wisprflow", "entryId": "e1", "title": "Planning", "meetingId": "…", "at": "…" }]
                    }
                ]
            }
        }
    },
    "sources": { "wisprflow": { "autoRecord": { "enabled": false }, "match": { "work": { "folders": ["Work"] } } } },
    "languages": {
        "cs": {
            "ocr": ["cs-CZ", "en-US"], "render": { "unclearLabel": "nejasné" }, "wordCheck": "hunspell",
            "fillers": { "sounds": ["ehm", "hm"], "words": ["jako", "jakože"] }
        }
    }
}
```

The main keys and their defaults (`config show` lists every one):

- `global.capture`: `backend` (`native`), `displays` (`all`), `activeFps` (1), `idleFps` (0.1), `threshold` (0.02,
  the share of the screen that must change), `jpegQuality` (0.75), `resolutionCap` (2880, the longest side of a frame
  in pixels; smaller text is lost to OCR on a large display), `retentionDays` (30), `ocr.*` (see
  [OCR settings](#ocr-settings)), `recorders.native.*` and `recorders.native.audio.*` (see [Sound](#sound)).
- `global.playback`: `player` (`vlc`, then `ffplay`), `beforeSec` (5). `global.playback.listen`: `player` (`afplay`,
  then `vlc`, then `ffplay`), `padBeforeSec` and `padAfterSec` (both asked on the first run), `roundCap` (12), `minPriority` (0.5), `delaySec` (2),
  `tone` (`enabled` on, `leadSec` 0.4, `sound` `{ hz: 880, sec: 0.15, volume: 0.6 }`), `repeat` (on), `repeatGapSec`
  (1).
- `global.suggest`: `listenBelow` (0.6), `applyAbove` (0.5), `questionCap` (12), `restatedIdentifiers` (`skip` or
  `mark`).
- `global.summary`: `actionHeadings` and `decisionHeadings`, the summary headings that mark action items and
  decisions (Czech and English ones by default).
- `global.assign`: `ask` (on), `lookbackHours` (48), `maxProposals` (5), `calendarSlackMin` (15: an entry counts when
  it overlaps the meeting or starts this many minutes before or after it). `calendarLookbehindHours` (3) is how long
  before a meeting a calendar entry may start and still be looked up (never less than `calendarSlackMin`).
  `folderWaitDays` (14) is how long a meeting waits to be moved into a source folder before the folder question ends.
  `retryFailedMin` (10) is how long after a failed post the project question is posted again.
- `global.export.ifEdited` (`beside`). `projects.<p>.export.folder` is an absolute path and has no default. Without
  it, `tools meetings export` fails and says to pass `--to <folder>` or to set the key. A meeting without a project
  needs `--to`. The Meetings window asks for a folder and saves it on the project.
- `sources.wisprflow`: `match.<p>.folders`, `suggest.ignore` (words `dictionary suggest` skips), and `autoRecord`:
  `enabled` (off), `liveWithinSec` (30), `notify` (on). An older file's `stopAfterSilenceSec` is ignored.

### Languages

`global.language` (`cs`) picks the block in `languages` that labels the transcript and reads the screen. `languages`
has blocks for `cs` and `sk` with every default (`sk` reads OCR in `sk-SK`, `cs-CZ`, `en-US`). Another language is a
block with every key (`ocr`, `render.unclearLabel`, `readAloudLabel`, `lineLabel`).

`languages.<code>.fillers` is what `tools recorder cut-fillers` cuts for that language: `sounds` are never words,
`words` are fillers that are also real words (cut only with `--all`). `cs` and `sk` ship their lists; `en` has a
shipped list without a block, and a block of another language may omit `fillers` to keep the shipped list of its code.
An older file without these keys reads with the values above.

`languages.<code>.wordCheck` names the word check provider of a language (`hunspell`, `hunspell-cc0`, `macos` or
`off`). Without `--word-check`, `suggest` and `evidence --raw` check each language's lines with its own provider, and a
language with no provider or an unknown one uses `hunspell`. `--word-check` sets one provider for every language. The
hunspell dictionaries download on first use.

### Older config files

A version 1 file is rewritten once on the first read: `global.render` moves to `languages.cs.render`,
`playback.listen.budget` to both `global.suggest.questionCap` and `playback.listen.roundCap`, and
`projects.<p>.match.wisprflow.folders` to `sources.wisprflow.match.<p>.folders`. A version 2 file moves
`projects.<p>.match.calendar.titles` to `projects.<p>.match.title.words`, since the words test the meeting title from
any source. A version 3 file moves `playback.listen.beep` to `playback.listen.tone.enabled` and `beepLeadSec` to
`tone.leadSec`, since the tone gained its sound and belongs to every Moment. A version 4 file moves
`playback.listen.padSec` to both `padBeforeSec` and `padAfterSec`, since a clip may hear more before the asked words
than after them. The code reads only the new places. A file of a newer version still reads (the keys this code knows).

### The tone's sound

`playback.listen.tone.sound` is one of three shapes. A sine `{ hz, sec, volume }` (880 Hz, 0.15 s, 0.6 when unset; the
version 4 shape). A preset `{ preset, volume? }`: `beep`, `soft` and `click` are sines (the Meetings window's Beep, Soft
and Click), and `tink`, `pop`, `ping`, `glass`, `purr`, `bottle`, `morse`, `frog`, `funk`, `hero`, `blow`, `basso`,
`submarine` and `sosumi` are the alert sounds in /System/Library/Sounds; without `volume` a preset plays at its own. A
sound file `{ file, volume }` with an absolute path ffmpeg reads (wav, aiff, mp3, m4a). A file tone is cut to 2 s, and
its length is read once per version of the file. A file that is gone stops the cut with the command that picks another
sound. A Moment's `tone.sound` names what it played: a file answers `hz` 0, its `file` and its length in `sec`. The
service's `tone.presets` lists the presets (each with its volume, a sine's `hz` and `sec`, a file's path, and whether
this Mac has it), and `tone.preview { sound? }` cuts any of the three shapes alone for a Play button.

### Environment

`GENESIS_TOOLS_HOME` names the folder above `.genesis-tools`. When it points at the `.genesis-tools` folder itself, so
the records sit in `$GENESIS_TOOLS_HOME/meetings/` instead of `$GENESIS_TOOLS_HOME/.genesis-tools/meetings/`, a
meeting that is not found and an empty `list` say where the records are and what to set.

## For agents

- **JSON output:** `list`, `show`, `revisions`, `suggest`, `items`, `confirm`, `reject`, `reopen`, `speakers stats`,
  `evidence` (and `--raw`), `transcript` (`--json` is `--format json`), `attendance`, `screen`, `screen-note`,
  `play`, `listen --clip-out`, `overview`, `export`, `merge`, `record status`, `record set`, `record cost`,
  `record display list`, `projects list|rename|remove|people|preview`, `assign proposals|sweep`,
  `dictionary show|suggest|test`, `context list` and every `config` command take `--json`.
- **Exit codes:** 0 on success, 1 on an error or a refusal. `listen --subscribe-answers` exits 0 at the round's end
  (with `--follow`, at the end of a round with no open question) and 2 on its timeout. `screen --timeline --frame`
  exits 1 for a file the timeline does not hold. `listen` exits 130 on Ctrl-C while a clip is cut. `listen --item` on
  a question that is not open exits 1; a round with no open question exits 0.
- **Refusal codes:** a refusal a client may act on leads its `✗` line on stderr with a code in brackets, and exits 1.
  The code is for programs; the sentence after it is for people.
  - A state of the meeting: `[no-transcript-source]`, the meeting has no linked source with a transcript or audio
    (`transcript`, `speakers stats`, `suggest`, `evidence`, `export`, `play`). The Meetings window shows its empty
    state on it.
  - A conflict: `[config-stale]`, `[export-edited]`, `[export-unsafe-path]`, `[item-changed]`, `[dictionary-exists]`,
    `[source-linked]`.
- **Undo:** `confirm --json` and `reject --json` return a token; `reopen --token` undoes that one decision.
  `dictionary add --if-absent` and `config set --expect` let an Undo refuse instead of overwriting.
- **Live answers:** run `listen <meeting> --subscribe-answers` under a monitor while the person runs `listen`, and act
  on each answer as it arrives. Do not poll the record.
- **The node-repl toolset:** `tools node-repl mcp --toolset meetings` preloads `meetings.list()`,
  `meetings.open(ref)`, `meetings.overview()`, `meetings.dictionary.test()` and the project, assign, config and
  capture-cost methods. An opened meeting has `info`, `lines`, `transcript`, `evidence`, `items.list|add|suggest|
  confirm|reject|reopen`, `speakers.stats|rename`, `set`, `settings`, `setSettings`, `mark`, `screen`,
  `editorProject`, `screenTimeline`, `export` and `assign.proposals|ask|apply`. For example
  `meetings.open(id).mark(label)` marks a running recording, `meetings.open(id).screen({ at, match, boxes: { outDir }
  })` draws OCR boxes, and `editorProject()` makes the recording an editor project (`tools recorder proxy <meeting>`
  does the same).
- **The plugin skill:** `meetings` in the genesis-tools plugin (`plugins/genesis-tools/skills/meetings/`) is the
  procedure for polishing a meeting: export raw, collect facts, judge speakers and terms, let the person listen, and
  write one polished file.

## Troubleshooting

- **`[no-transcript-source]`**: the meeting has no linked source. Run `tools meetings link <meeting> wisprflow:<id>`.
- **`link` refused with `[source-linked]`**: another record holds that source meeting. Run the `merge` command the
  message prints.
- **`record start` says Screen Recording is missing**: grant it to GenesisTools.app (or the terminal without the app).
  `tools macos permissions` shows the grants. Without a grant, macOS returns frames with only the desktop and the menu
  bar, so a recording never starts without it.
- **`attendance --from facetime` fails**: the call history needs Full Disk Access for the process that reads it.
- **`attendance --from teams` finds nothing on a new Mac**: run `tools ms-teams sync` first.
- **No attendance for a Google Meet call**: nothing on this Mac keeps it; the speaking indicator still works.
- **`evidence` says "audio energy: not checked"**: the source keeps no audio on this Mac, or ffmpeg is missing.
- **`play` says "No player found"**: install VLC, or ffmpeg for ffplay. `--player` never falls back to another player.
- **`play` refuses a time**: it is more than 30 s after the last speech the source keeps; the message names that time.
- **`items add` warns that two lines start in one second**: reject that item and add it again with `"line": <index>`
  (the index the warning names), or it does not apply.
- **`export` says "has no export folder" or "has no project"**: the meeting's project has no
  `projects.<p>.export.folder`, or the meeting has no project. Pass `--to <folder>`, or set the key with
  `tools meetings config set projects.<p>.export.folder <absolute path>`. For a meeting without a project, pass `--to`
  or set its project first (`tools meetings set <meeting> --project <name>`).
- **`export` exits 1 with `[export-edited]`**: the note holds edits. Pass `--if-edited beside` or `--if-edited
  replace`.
- **`config set` refuses a path**: the path names no setting; the message names the closest one.
- **The recorder records only the main display**: Peekaboo records one display at a time, or an asked screen index is
  not connected. The warning says which.
- **The recording stopped by itself**: three failed pieces in a row or another error. With autostart, the watcher
  starts it again 2 min later; otherwise run `record start --meeting <id>`.
- **`list` is empty or a meeting is not found**: `GENESIS_TOOLS_HOME` may point one level too deep. The message says
  where the records are and what to set.
- **`window` starts a long build**: the installed app lacks the Meetings part. Pass `--no-build` to fail instead.

## Related

- [`tools wisprflow`](../wisprflow/README.md): the Wispr Flow source, its raw export and its calendar.
- [`tools ms-teams`](../ms-teams/README.md): Teams attendance (`meetings attendance --json`, `sync`).
- [`tools recorder`](../recorder/README.md): the movie editor, `proxy <meeting>` and `cut-fillers`.
- [`tools question`](../question/README.md): the decision inbox that carries the project question.
- [`tools daemon`](../daemon/README.md): starts the watcher at login.
- [`tools rm`](../rm/README.md): the trash that takes expired frames and sound.
- [`tools browser-router`](../browser-router/README.md): opens the `meetings-play` links.
- [`tools macos`](../macos/README.md): permissions and GenesisTools.app.
- [`tools node-repl`](../node-repl/README.md): the `meetings` toolset.
