# tools meetings

> **Meetings as one record each: the projects they belong to, the dictionary that polishes their transcripts, and
> the meeting record, recording and review.**

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
| `speakers stats <meeting> [--attendance <platform>\|<file>]` | Per label: origin, turns, spoken time, spans, with hints |
| `speakers rename <meeting> <label> <name>` | Rename a label for this meeting |
| `evidence <meeting> [--attendance <platform>\|<file>] [--files]` | Which voice each label's lines are: audio channel and the platform's speaking indicator, plus the volume check (`--format json`: one row per line) |
| `suggest <meeting> [--rules speakers,evidence,terms] [--attendance <platform>\|<file>]` | Run the rules and add what they find as suggested items |
| `items <meeting> [--status …] [--kind …]` | The items with status, confidence and rules |
| `confirm <meeting> <ids…> [--speaker <name>] [--proposed <text>]`, `--min-confidence 0.9` | Confirm items; a range nobody named needs `--speaker` |
| `reject <meeting> <ids…>` | Reject items; they are never suggested again |
| `transcript <meeting> [--format md\|txt\|json\|srt\|vtt] [--with-suggested]` | The transcript with renames, confirmed items and the dictionary. In md an expansion and a term's `meaning` (first mention) are a `<sup>`; txt, srt and vtt keep them in parentheses. An open question shows as `[nejasné: "<raw>"; 1) … 2) …]` (`languages.<global.language>.render.unclearLabel`); `--with-suggested` applies the top reading instead. Each applied item that did not change the transcript is a warning (`i42 did not apply: no "X" at 37:43`, `… 2 lines start at 37:43`, `… i41 changed "X" first`). In md the front matter's `speakers` maps each person after the corrections to their line count; `unattributed` holds the source labels nobody named |
| `record start [--meeting <ref> \| --source wisprflow:<id> \| --title <text>] [--project] [--display all\|follow-focus\|main\|<index>]` | Record the screen: a frame when it changes, OCR per frame; creates the meeting (with the calendar event around now) unless one is named |
| `record pause`, `record resume`, `record stop`, `record status` | Control the running recording over its socket; stop answers after the last frames, the summary and the collect, and lists the frames per display in status |
| `record start --audio mic,system`, `record mute\|unmute <source>`, `record set [--active-fps] [--idle-fps] [--threshold] [--max-long-side]` | Sound beside the frames (`.m4a` in `audio/`, listed in `audio.jsonl`), a muted source (silence in its file), live settings |
| `record display list\|add <id>\|remove <id>\|switch <id>\|mode <policy>` | Which displays the running recording records; a change applies at once |
| `screen <meeting> --at 1:23:50 [--window 30s]` | The OCR text of each recorded screen around a transcript time |
| `autostart on\|off\|status` | Record the screen whenever Wispr Flow records a meeting (default off) |
| `watch [--once]` | The watcher behind autostart; the daemon starts it at login when autostart is on |
| `attendance <meeting> [--from <platform>\|<file>]` | Store who was in the call and when, and the sections derived from it (one per join or leave); suggest, speakers stats and evidence read them when no `--attendance` is given. A file is read in a platform's export format: `teams:<file>` names it, a bare path is read in the meeting's platform's format, else in the one format its text fits (Teams: `tools ms-teams meetings attendance --json` output). Second 0 is the source's transcript clock. A Teams call that lists its people without join or leave times (its call-ended message) counts them present for the whole call, and the note says how many. A fresh home needs `tools ms-teams sync` first |
| `listen <meeting> [--item Q12]` | Answer the open questions by ear, one at a time: each range is cut with ffmpeg (padding `playback.listen.padSec`, asked on the first run), with a short tone just before the asked words (`beep`, `beepLeadSec`), and played `delaySec` (2) after the question shows, then again after each `repeatGapSec` (1) pause until the question is answered (`repeat`, on by default), also while a "Something else…" answer is typed. A word question shows the line its heard words are in, with the words marked and the lines before and after it. When the round already answered the same heard words at another time, that answer is the first choice and the question says when it was given. Esc goes back one step: from the comment to the choices, from the choices to the previous question, whose answer is undone. "Enough for now", or Esc on the first question, ends the round; the next `listen` goes on from there. Undo reverts only what that answer changed, so an item added meanwhile stays. `--item Q12` (or `12`, or the id `i42`) asks only that question and, after "Several voices", its parts. `--item Q12 --answer "<text>"` answers without audio, in a round of its own, or inside the round a person is listening to |
| `listen <meeting> --subscribe-answers [--from-start] [--timeout 120]` | For an agent: prints the running round's events as JSON lines (`round-start`, `answered`, `skipped`, `split`, `reopened`, `round-end`) while the person answers, from `questions.ndjson` in the meeting folder, and exits 0 at the round's end (an aborted round when the listener is gone), 2 on the timeout in minutes. Run it under a Monitor, so each answer wakes the agent |
| `items add <meeting> --kind speaker-range --from 38:12 --to 38:20 --label "<raw label>" --speaker <name> --confidence 0.85 --reason "…"` | Store an agent's finding (rule `agent`, the reason in `evidence.reason`); it stays suggested until a person confirms it |
| `items add <meeting> --kind term --at 1:02 --heard <words> [--proposed <spelling>] --confidence 0.4 --reason "…"` | The same for a term; without `--proposed` it is asked as free text when it matters |
| `items add <meeting> --listen --from 37:43 --to 37:51 --question "…" [--choices "A,B"] [--decides i7] [--priority 2]` | Add a question of your own for `listen`; `--priority` is on the scale suggest scores its own questions with (below), and one under `playback.listen.minPriority` (0.5) is asked only with `--item` |
| `items add <meeting> --from-file findings.json` | A batch in one write: an array (or `{ "findings": [...] }`) of objects with the flags' names (`kind`, `from`, `to`, `at`, `label`, `speaker`, `heard`, `proposed`, `scope`, `joined`, `question`, `choices`, `decides`, `priority`, `confidence`, `reason`), plus `meaning` or `quote` on a term, and `line` (the line's index, as an `items add` warning names it) on a join or a term when two lines start in one second; times as seconds or "37:43". Kinds: `speaker-range`, `label` (`label`, `from`, `to`, `"meaningless": true`, `reason`: the label tracks no one person in that stretch, so its lines there count as unlabeled for the rules and render as `[nejasné: "<label>"]` unless a range or join gives them a voice), `join`, `term`, `question`. A finding may carry a `ref`, and a question's `decides` may list the refs of its own batch: they become the new ids. A term's `proposed` fixes the words everywhere unless `"scope": "line"`. One bad entry adds nothing. Each join and each term bound to a line is anchored to its line (`evidence.transcriptLine`); a time where no line, or two lines, start is a warning, and so is each new item that would not apply |
| `evidence <meeting> --raw [--word-check hunspell\|hunspell-cc0\|macos\|off]` | The facts per line as JSON for an agent: label, text, channel, speaking, muted, present, the people, the silent call stretches (`meeting.callSilent`), the term part and the summary; no rule and no confidence. Reads existing evidence and cached energy without writing. Run collect for platform and attendance facts and calibrate for channel energy |
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

The recorder is a frame recorder from `src/utils/screen-recorder/` (`capture.backend`: `native`, GenesisTools'
own `ax-tool capture`, by default; or `peekaboo`). It records in 30 s pieces with the capture policy every recorder follows (`capture.activeFps`,
`idleFps`, `threshold`, `resolutionCap`) plus the recorder's own block (`capture.recorders.native`: `quietMs`,
`heartbeatSec`, `maxMb`, unset keeps ax-tool's own; `capture.recorders.peekaboo` has no keys of its own), converts
each frame to JPEG under the meeting's `frames/` as `<HH-MM-SS-mmm>-d<displayId>.jpg`, and appends Vision OCR to
`ocr.jsonl` (each line names its `displayId`) in the OCR languages of the meeting language
(`languages.<global.language>.ocr`, `cs-CZ` and `en-US` for `cs`). Each capture ends at its duration plus 30 s; a
hung one is stopped and counts as a failed capture.

`capture.displays` picks what is recorded: `all` (default) records every connected display at once, one capture per
display per piece; `main`; `follow-focus` (the display of the focused window, when the recorder supports it, else the
main one); or a screen index. Each piece reads the display list again by id, so a display that is connected joins at
the next piece and one that is removed leaves without an error. When an asked index is not connected, the main
display stands in and the warning says since when.

Frames stay on this Mac and never go into an export. Once a day the watcher moves the `frames/` and `ocr.jsonl` of
each meeting whose newest frame is older than `capture.retentionDays` (30) into the GenesisTools trash (`tools rm`
rules, restorable with `tools rm restore <batch>`); the meeting record, its items and the recording block stay. It
never touches the meeting being recorded, and `retention-last.json` beside the meetings says when it last ran. When a source is linked, `record stop` stores its clock, so
`screen --at` takes transcript times. A frame is taken only when the screen changes, so `screen --at` shows, per
display, the frame still on that screen; a time outside the recorded spans says so and when the recording ran.

While it runs, the recorder is a live recording (`<genesis-tools root>/recordings/live/<id>.json`, kind `meeting`)
with a JSON-RPC socket beside it. The socket serves the recorder's `RecorderControl`
(`src/utils/screen-recorder/control.ts`), the one method set of every recorder kind: `status`, `pause`, `resume`,
`stop {wait}`, `displays.list|add|remove|switch|mode`, `jobs.list`, `audio.list|mute|setInput`,
`settings.get|set`, and `subscribe` (events `state`, `frame`, `displays`, `warning`, `progress`, `ended`).
`RecorderClient` is the same interface over the socket, and the `record` commands use it. With ax-tool's
`--control-stdin`, a pause, a display switch, a settings change, a mute and a microphone switch go to the running
capture without a restart, and frames reach the socket as they land. A recorder without the command restarts that
capture. The OCR backlog, the summary and the collect run on the shared job runner (`@genesiscz/utils/jobs`) as
`progress` notifications. `stop` answers after them, or at once with `{wait: false}` and the job id.

Sound is off by default (the transcript source records it). `capture.recorders.native.audio` (`sources`,
`micDevice`) or `record start --audio` turn it on. One capture per piece records it as `--audio-sidecar` `.m4a`
files, moved to `audio/`, with muted spans in `audio.jsonl`. Peekaboo records one display at a time (its
ScreenCaptureKit lock), so `displays: "all"` falls back to the main display with a warning.

The `recording` block of the record has a schema (`RecordingBlock` in `src/utils/meetings/record.ts`): `spans` (from,
to and stop reason: `requested`, `paused`, `failed`, `error`), `frames` and `bytes` (every frame in `frames/`, also
those of an earlier start), `displays` (id, name, frames), `backend`, `displayPolicy` and `warning`. Records from
before the schema still read. Three failed pieces in a row stop the recorder with `stopReason: "failed"`; any other
error stops it with `"error"`; both always write the stop and post "Screen recording stopped" once per failure
episode, for recordings a person started too. A recording without a frame says so in its warning. `show` prints
the recording's state, frames per display, spans and warning.

### Autostart

`tools meetings autostart on` sets `sources.wisprflow.autoRecord.enabled` and starts the watcher; the daemon starts
it at every login while it is on. The watcher follows the first source in the source registry (`lib/sources.ts`)
whose `sources.<id>.autoRecord` is on, today Wispr Flow. Every 15 s the watcher asks Wispr Flow for a meeting it has not ended whose live
transcript changed in the last `liveWithinSec` (30). It then runs `record start --source wisprflow:<id> --yes` and
posts a notification (`notify`, default on). It stops only the recordings it started, when Wispr Flow ends the
meeting or stays silent for `stopAfterSilenceSec` (120). A start that failed (no grant) notifies once and is not
retried for the same meeting. A recorder that stopped on its own while the meeting runs (`stopReason: "failed"` or
`"error"`) is started again 2 min after it stopped, with `record start --meeting <id> --yes`, and every 2 min after
that; the recorder posts the notice. A stop the user asked for stays stopped. A stop that failed keeps the watcher's
claim, so the next look stops it again. When Wispr Flow ends the meeting, the watcher links it again (title, end,
people) on each look until the record has an end, for up to 10 min.

## Items

A rule's finding is an item with a confidence and the rules that produced it. A person confirms or rejects it; only
confirmed items change a transcript. `--with-suggested` previews the rest: it applies a suggested item at
`global.suggest.applyAbove` (0.5) or more, and one with no confidence (a person's own); a lower one is marked unclear,
as an open question is.

- `speaker-range`: lines of a label that belong to someone else. RA (Teams attendance) names the people in the call
  as candidates, or the one person left; R1 and R5 mark a goodbye the label keeps talking after, R13 when another
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
  microphone (then it is the user's). R17: when such a person talks under their own label within 10 s of another label's line, and E3 shows them
  and one other present, the line is the other's (0.65).
- A silent call channel: where the call's channel stays at its noise floor for 5 min or more while the microphone
  hears speech, and two labels talk there (or E3 shows others speaking), the call played through the room's speakers
  and the microphone carried every voice. E1 and the energy say nothing there. R19: the label with the most sure
  microphone lines where the channels work (leading the next by 1.25 times) stands for the user there (0.5, to listen).
- R18, a second person in the room: a platform-named label that holds a quarter or more of the sure microphone lines
  (30 at least) and call lines of its own carries someone else on the microphone. Its microphone lines name the people
  in the call as candidates (0.4); the user's sure microphone lines are capped at 0.7 and asked, and a line under 90 %
  stays its label's.
- A stuck speaking indicator: E3 showing the same one remote person for 6 min or more while a third of the lines are on
  the microphone is ignored for that stretch.
- `join`: a word cut between two lines ("dot" + "áhnu"), or one sentence cut between two whole words: a `joined`
  value with a space ("jsem zvědavej") keeps the space.
- `term`: a misheard term and its proposed spelling.
- `label` (`meaningless: true`): the label tracks no one person from `fromSec` to `toSec`. The rules see its lines
  there under a label that names nobody, and the transcript marks each such line no range or join gives a voice as
  `[nejasné: "<label>"]`. Its outcome is the lines it marked, or shadowed when ranges gave every line a voice.
- `question`: something to decide by ear (`about`: speaker, term or text), with its time range, `choices` and the
  items it `decides`. Answering it confirms each decided item with the answer (a range's speaker, a term's
  spelling); "none of these" rejects them; a skip leaves them as they were; "Several voices" cuts it at each line inside it and, in a line of 3 s or more, at each change between the microphone and the call (half-second energy windows); each part shows its words and plays only its own audio. Two remote voices in a row stay one part. With nothing to cut, the question stays open. A speaker question shows the words of its span and plays only that span, from the tone on.

### The opened meeting and the call timeline

`OpenedMeeting` in `lib/opened-meeting.ts` opens a record once and gives, read lazily and once, the linked source and
its meeting (the first source block that names a meeting, `sourceRefOf` in `lib/sources.ts`), the evidence with the
speaking readings dropped on a platform without an indicator, presence with the user under their own name, the energy
share, the silent call stretches, the dictionary, the summary points and the word check. Reading never writes the
record: `collect` (platform, attendance, channel layout) and `calibrate` (`evidence.channels` with `callSilent`) are
the explicit steps. suggest, evidence, `evidence --raw`, attendance, speakers stats and items open meetings through it.

`CallTimeline` in `lib/call-timeline.ts` owns the transcript clock: second 0 is the source's `recordingClock`, else
the clock the recorder stored from it at `record stop`, else the record's start. It loads stays from a platform
(`MEETING_PLATFORMS`) or from a file in a platform's export format (`MeetingPlatform.attendanceFile`), names the user
once and stores stays and sections once. A new platform with an export format is one `attendanceFile` reader.

### Transcript lines and the corrections pipeline

`src/utils/transcribe/lines.ts` is the one place that knows a transcript's lines. A line's address is its index in the
source transcript plus its start. A line ends at the next timed line's start, at least 1 s on, and the last one 5 s
on. The line at a time is the one starting within 0.5 s of it; two such lines (Wispr times whole seconds) are reported
as ambiguous and never guessed. Heard words match whole words only, in any case (Czech letters too), with diacritics as
written and any run of spaces: "Ada" never matches inside "zadání". The spot where words are said is estimated from
their place in the line, and a word's clip is cut around that spot.

`correctTranscript` in `src/meetings/lib/transcript-corrections.ts` is the corrections pipeline. It takes the
record's decided items (with `--with-suggested`, also those at `applyAbove`), the dictionary and the open questions,
and applies them in one order: joins, ranges, open speaker marks (on the source label, never on a line a range or a
join already voiced), renames, quote and meaning marks, term fixes, the dictionary, open words. It returns the lines
and one outcome per item: applied (with its lines), not found, ambiguous, or shadowed by another item. A meaning is
wrapped in backticks once, also when it was stored with its own. `ledgerEntryFor` is the corrections-ledger entry of a
confirmed term or join, for every path that confirms one.

The rules are one documented enum, `MeetingRule` in `src/utils/meetings/rules.ts`. Two rules that reach the same item
merge into one, with the confidence 1 − (1 − a)(1 − b), at most 0.95.

### Which items become questions

Only what is unsure and matters (Martin, 2026-11-02: "just on those which are really important and not sure of"):

1. Confidence under `global.suggest.listenBelow` (0.6). A mixed channel alone is no reason to ask.
2. A speaker range needs more than 5 words that are not all fillers, and 15 words or a decision or action word
   (`src/utils/transcribe/importance.ts`). A term needs two occurrences, an identifier, a person's name from the
   summary, or a decision in its line; any other low term is only marked in the transcript.
3. A goodbye or attendance range is dropped when finer audio-evidence items cover 80 % of it.
4. Speaker questions cluster only for the same single label, exact range and clip times, and choices.
   Separate neighbouring passages stay separate.
5. Priority = (1 − confidence) × impact × reach. Impact is log2(1 + words), +3 for a decision word, +3 when the
   range cites a summary action item or decision (`global.summary` headings), +2 when the answer moves an action's
   owner. Reach counts the questions with the same signature (top two choices and the people present). One
   unsure question usually scores 1 to 3, a cluster 6 or more. A question an agent adds takes `priority` on the same
   scale, so suggested and added questions sort in one order and `minPriority` means the same for both.

`suggest` makes at most `global.suggest.questionCap` (12) questions; `listen` asks by priority, at most
`playback.listen.roundCap` (12) per round and none under `minPriority` (0.5). A split
uses no budget: its parts come next and share their parent's unit, so the header shows `3/12 · part 2/4`. Each
answer settles compatible look-alikes. A speaker answer requires the same single label, exact range and signature,
and an offered answer; its items gain +0.3 up to 0.9, closing questions that reach the threshold. A word answer
propagates only between questions with the same heard words and choices that decide exclusively global terms ("settled by the answer to i7"); the `answered` event lists them in `settled`, and an undo
reopens them (`reopened` with `also`). "Enough for now" ends the round; the rest stay marked in the transcript.

The round is one module, `ListenSession` in `lib/listen-session.ts`: which question comes next, the budget, each
decision as per-item changes with their inverse, look-alikes, the answer log and the ledger. A `ListenAdapter` asks
the person: the terminal (clack and audio, in `commands/listen.ts`) or `GivenAnswerAdapter` for `--answer`.

A question is `Q<n>` to people: the n-th question of the record, as listen's header and the polished file number it.
`items` shows the number in its `Q` column, and `confirm`, `reject` and `listen --item` take `Q12`. `items add` warns
about a question whose text repeats another open question, one that decides no item, and one with no priority.
A word question finds its heard words as whole words (`TranscriptLines` in `src/utils/transcribe/lines.ts`), so
"Ada" never matches inside "zadání"; its clip is cut around the spot the words are said, and two questions on the
same words over the same range take the first and the second occurrence, each with its own time and line.

A confirmed term or join is also written to `~/.genesis-tools/meetings/corrections.jsonl`.

### Context documents: quotes and meanings

The meeting's context files and notes feed two term rules (`@genesiscz/utils/transcribe/doc-match`). Each item is
bound to its line (`atSec`), so it never changes the same words elsewhere.

- `read-aloud`: a passage that says a document line in order, densely on both sides (a reader may skip its code
  spans), with three prose words at least. The item's `quote` holds the line; the transcript shows its exact text
  instead of the misheard words, as a quote block in Markdown and in quotation marks elsewhere, with the source
  (`(čte z WikiProposals, ř. 33)`, from `languages.<global.language>.render.readAloudLabel` and `lineLabel`). The dictionary does not
  touch the quoted text.
- `spoken-identifier`: two or more words that say a document identifier in order ("employee only" for
  `employeesOnly`, "administration CMS schema" for `/administration/cms/schema`), or one path segment after "lomeno"
  or a slash (`/{type}`). A comma between the words ends the run. The words stay; `meaning` names the identifier,
  shown after them. An identifier is marked at its first mention and again after two minutes without one.

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

`~/.genesis-tools/meetings/config.json`. Every key has a default, so the file holds only what you changed. A key
that varies by recorder, source or language sits under that axis:

```jsonc
{
    "version": 2,
    "global": {
        "dictionary": { "abbrExpansion": "every", "entries": [] },
        "language": "cs",
        "capture": { "backend": "native", "activeFps": 1, "retentionDays": 30, "recorders": { "native": { "maxMb": 400 } } },
        "playback": { "listen": { "roundCap": 12 } },
        "suggest": { "questionCap": 12 }
    },
    "projects": {
        "work": {
            "dictionary": { "entries": [{ "type": "abbr", "value": "MOP", "substitution": "MOP (Obchodní partner podnikatel)" }] },
            "match": { "calendar": { "titles": ["Wiki"] } }
        }
    },
    "sources": { "wisprflow": { "autoRecord": { "enabled": false }, "match": { "work": { "folders": ["Work"] } } } },
    "languages": { "cs": { "ocr": ["cs-CZ", "en-US"], "render": { "unclearLabel": "nejasné" }, "wordCheck": "hunspell" } }
}
```

`languages` has blocks for `cs` and `sk` with every default; another language is a block with every key
(`ocr`, `render.unclearLabel`, `readAloudLabel`, `lineLabel`). `global.language` picks the block that labels the
transcript and reads the screen.

A version 1 file is rewritten once on the first read: `global.render` moves to `languages.cs.render`,
`playback.listen.budget` to both `global.suggest.questionCap` and `playback.listen.roundCap`, and
`projects.<p>.match.wisprflow.folders` to `sources.wisprflow.match.<p>.folders`. The code reads only the new places.

`languages.<code>.wordCheck` names the word check provider of a language (`hunspell`, `hunspell-cc0`, `macos` or
`off`). Without `--word-check`, suggest and `evidence --raw` check each language's lines with its own provider, and a
language with no provider or an unknown one uses `hunspell`; `--word-check` sets one provider for every language.

A change that would make the file invalid is refused, and the file stays as it was.

`GENESIS_TOOLS_HOME` names the folder above `.genesis-tools`. When it points at the `.genesis-tools` folder itself, so
the records sit in `$GENESIS_TOOLS_HOME/meetings/` instead of `$GENESIS_TOOLS_HOME/.genesis-tools/meetings/`, a
meeting that is not found and an empty `list` say where the records are and what to set.
