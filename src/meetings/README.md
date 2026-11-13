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
| `list [--project <name>] [--limit <n>] [--json [--full]]`, `show <meeting> [--json]` | The records, newest first. `list --json` prints one row per meeting (`id`, `title`, `start`, `end`, `project`, `labels`, `sources`, `context`, `items` counts, `recording`); `--full` prints the whole records, as `show --json` prints one. `--limit` keeps the newest n, after `--project` |
| `set <meeting> --project <name> \| --title <text>` | Change a field |
| `link <meeting> wisprflow:<id>` | Attach a source's meeting to an existing record. A source meeting that another record holds is refused with `[source-linked]` and the `merge` command, because two records would split one call. When the call started before the record (a record made when a screen recording started), the record's start becomes the call's, so its times match the transcript |
| `merge <meeting> --into <meeting> [--dry-run] [--json]` | Make two records of one call one: the frames, sound and their rows move into the record that stays, the recording blocks, context, labels, people and history merge, the start is the earlier one, and a generated title (`Meeting 14:29`) gives way to the call's. Both folders are cloned into `~/.genesis-tools/backups/meetings/<YYYY-MM-DD-HHMM>-merge-<meeting>/` first, with a `README.md` of restore steps; the record that goes away moves there, its editor files are made again on the next open, and its open project question is withdrawn. Refused for records of two source meetings, a record with items (decide them first), a record being recorded, and frame names in both |
| `revisions <meeting> [--json]` | Revision tokens for each part of the Meetings window, so clients can skip unchanged reads. These are change tokens, not saved versions to restore |
| `duplicate <meeting> [--title <text>] [--without-items] [--json]` | Create an independent record under a new id, keeping sources, context, frames and sound. Normal copies retain items and journal tokens, rewrite journal meeting IDs and keep `copiedFrom`; Undo affects the copy only. `--without-items` (alias `--no-items`) starts with zero items and an empty decision journal, ready for an independent automatic run. Copies inherit the project and do not trigger another automatic project-assignment question. Stop an active recording first |
| `word-timings generate <meeting> --from <seconds> --to <seconds> --model <id> [--language <code>] [--json]` | Generate local word timing evidence for a bounded audio range with an already cached timestamp-enabled model; save coverage and provenance for later playback |
| `context add <meeting> [file\|url] [--title] [--note] [--rev <sha>\|--before-meeting]`, `context list`, `context remove` | Reference material. An ordinary file keeps its path. Revision selection saves the full resolved commit and document text in the meeting, so later edits, deletion and duplication retain that version. The two revision flags cannot be combined and require a file |
| `speakers stats <meeting> [--attendance <platform>\|<file>]` | Per label: origin, turns, spoken time, spans, with hints. A span joins turns up to `--gap` apart (2 minutes): it says when the label was there. `--json` also lists each turn by itself as `talk`, which the Meetings window draws as the talk-time lanes |
| `speakers rename <meeting> <label> <name>` | Rename a label for this meeting |
| `people [query] [--meeting <meeting> [--at <time>]] [--limit <n>] [--hidden] [--json]` | The people directory: everyone the meetings, the projects, Contacts and the people book name, one row per person, matched with case and accents ignored and ranked (see [People](#people)). `--json` prints `{ query, people, total, sources }`; a source that is off or refused says why in `sources` |
| `people add <name> [--email <address>] [--note <text>]`, `people hide <person> [--show]` | Add a person to the people book, or give one it has an email or a note; hide a person from every list, or show them again |
| `people merge <a> <b> [--name <name>] [--yes]`, `people unmerge <token>` | Show two people as one. Without `--yes` it prints the meetings that name either of them and the speaker labels renamed to them, and writes nothing; with `--yes` it writes the merge and prints its token, which `unmerge` takes. No meeting record changes |
| `people assign <meeting> <person> --from <time> [--to <time>] [--label <label>] [--line <time>]… [--plan]`, `people unassign <meeting> <token>` | Give lines of one meeting to a person without renaming the whole label: a stretch (one label's lines with `--label`, every voice's without it) or single lines by their start. The corrected transcript, `show` and `speakers stats` show them as that person. `--plan` prints what it would give and the other stretches it may reach, and saves nothing. `unassign` undoes it by the token it printed |
| `evidence <meeting> [--attendance <platform>\|<file>] [--files] [--json]` | Which voice each label's lines are: audio channel and the platform's speaking indicator, plus the volume check (`--format json`, or its short form `--json`: one row per line) |
| `suggest <meeting> [--rules speakers,evidence,terms] [--attendance <platform>\|<file>] [--attendance-id <threadId>]` | Run the rules and add what they find as suggested items. A second run adds no item it already made and no question while the meeting has `questionCap` open. It first retires (rejects, with `evidence.retired`) the suggested words that a dictionary entry or the slang rule settles now, and the questions that decided only them |
| `items <meeting> [--status …] [--kind …]` | The items with status, confidence and rules |
| `rows <meeting> [--all] [--json]` | The review rows, as the Meetings window shows them: questions first in the order `listen` asks (priority, then time), then the other items by time; a decided row keeps its place. Each row has its question as parts (who, what was said, when, what it asks, what it settles, the reason), its choices with their role (suggested, presumed, candidate, heard, earlier answer, none of these, several voices, skip) and the engine's confidence where it has one, its edit kind, what it needs, its sources and who decided it last. Open questions below `playback.listen.minPriority` are counted, and `--all` shows them. `--json` prints `{ meeting, rows, hidden }` (REPL: `meetings.open(id).items.rows()`; the Meetings service: `meeting.rows`) |
| `confirm <meeting> <ids…> [--speaker <name>] [--proposed <text>] [--reason <text>] [--json]`, `--min-confidence 0.9` | Confirm items; a range nobody named needs `--speaker`. An item confirmed already is left as it is (`needs: "nothing"` in `--json`, exit 0), so its first Undo token still works; a skip that needs a value or an answer exits 1. `--reason` is kept in the decision journal and on each item it decided. `--json` prints `{ decided, token, skipped, entry }`; `entry` is the journal entry, with who decided (the actor), the reason and every item before and after |
| `reject <meeting> <ids…> [--reason <text>] [--json]`, `--min-confidence 0.9` | Reject items; they are never suggested again. `--json` prints `{ decided, token, skipped, entry }`, as `confirm --json` does; the token is what `reopen --token` takes |
| `decide <meeting> --action '<json>' [--reason <text>] [--plan] [--json]` | Plan or apply any typed journal action, including respell, assign and scoped/replacement answers, through the service or the same in-process adapter. `--plan` writes nothing. Applying refuses a decision already made by another caller. |
| `journal <meeting> [--item i42\|Q12] [--limit <n>] [--json]` | Who decided what in the meeting, when and why, newest first: one entry per decision (a person in the window, a person in `listen`, a person at the command line, an agent with its harness and session, a rule), with its reason and the items it changed. An Undo names the entry it undid. Comments sent to the listening agent are entries too (kind `comment`). `--json` prints `{ meeting, entries }` |
| `serve [--detach] [--status] [--stop] [--no-idle]` | The Meetings service: the one owner of the meetings store while it runs, which the window, the CLI and agents reach over `<genesis-tools>/meetings-service/service.sock` (`service.json` beside it names its pid and checkout). A command finds it by itself and answers in its own process when none runs, with the same output. It exits after 10 minutes with no connection and when its code changes. `--stop` stops it (none running is no failure). The settings page's library is on it too: `projects.add`, `projects.rename`, `projects.remove`, `projects.labels`, `projects.unpair`, `projects.preview`, `dictionary.show`, `dictionary.add`, `dictionary.remove`, `dictionary.test` and `config.edit`, which `projects`, `dictionary` and `config edit` call with the same output |
| `reopen <meeting> <ids…> [--token <token>] [--reason <text>] [--json]` | Put confirmed or rejected items back to suggested (the Undo of confirm and reject). `--token` undoes one decision, by the token that `confirm --json` or `reject --json` printed; when another decision changed one of its items since, it is refused with `[item-changed]`. A question is reopened only by `listen`, and a confirm's line in the corrections ledger stays |
| `transcript <meeting> [--format md\|txt\|json\|srt\|vtt] [--json] [--with-suggested] [--timestamps] [--play-links] [--no-frontmatter] [--no-dictionary]` | The transcript with renames, confirmed items and the dictionary. `--json` is the short form of `--format json`. `--timestamps` shows the start time of each paragraph; `--play-links` (md) links each start time to its moment through the router preset `meetings-play`, and implies `--timestamps`; `--no-frontmatter` (md) leaves out the front matter; `--no-dictionary` does not apply the dictionary. In md an expansion and a term's `meaning` (first mention) are a `<sup>`; txt, srt and vtt keep them in parentheses. An open question shows as `[nejasné: "<raw>"; 1) … 2) …]` (`languages.<global.language>.render.unclearLabel`); `--with-suggested` includes suggestions, but a range owned by an open speaker question remains a guess `[Name: NN %]` at every confidence until answered or confirmed. Without that flag, question choices carry no borrowed range confidence. A term proposal that is already a complete unclear mark is rendered once. Each applied item that did not change the transcript is a warning (`i42 did not apply: no "X" at 37:43`, `… 2 lines start at 37:43`, `… i41 changed "X" first`). In md the front matter's `speakers` maps each person after the corrections to their line count; `unattributed` holds the source labels nobody named |
| `record start [--meeting <ref> \| --source wisprflow:<id> \| --title <text>] [--project] [--display all\|follow-focus\|main\|<index>]` | Record the screen: a frame when it changes, OCR per frame; creates the meeting (with the calendar event around now) unless one is named |
| `record pause`, `record resume`, `record stop`, `record status` | Control the running recording over its socket; stop answers after the last frames, the summary and the collect, and lists the frames per display in status |
| `record mark <label>` | A marker at this moment of the running recording (REPL: `meetings.open(id).mark(label)`): the record keeps it, and the meeting's `recording.json` lists it at its movie time, so the editor shows it |
| `record start --audio mic,system`, `record mute\|unmute <source>`, `record set [--active-fps] [--idle-fps] [--threshold] [--max-long-side] [--ocr\|--no-ocr] [--ocr-languages en-US,cs-CZ] [--ocr-min-chars N]` | Sound beside the frames (`.m4a` in `audio/`, listed in `audio.jsonl`), a muted source (silence in its file), live settings: the values the REPL's `meeting.setSettings()` takes, checked by the same schema |
| `record display list\|add <id>\|remove <id>\|switch <id>\|mode <policy>` | Which displays the running recording records; a change applies at once |
| `screen <meeting> --at 1:23:50 [--window 30s]` | The OCR text of each recorded screen around a transcript time |
| `screen <meeting> [--at <time>] --boxes [--match <text>] [--level block\|line] --out <dir>` | The OCR boxes of those frames in frame pixels: the ones holding `--match`, or without it the ones that changed since the display's frame before, drawn numbered on each frame (`<frame>.boxes.png`) with a PNG crop of each (`<frame>.<n>.png`). `--match` without `--at` searches every frame (`--limit 5`). REPL: `meetings.open(id).screen({ at, match, boxes: { outDir } })`, and `editorProject()` makes the recording an editor project (`tools recorder proxy <meeting>` does the same) |
| `ocr <meeting> [--follow] [--retry-failed] [--reread-empty-since <time>] [--json]` | Read the screen text of the meeting's kept frames that have no `ocr.jsonl` row yet (the recorder starts it with `--follow`, and the watcher starts it again for a recent meeting with frames left). `--retry-failed` reads the rows marked `failed` again, `--reread-empty-since 15:56` (local time of the meeting's day, or a full date) the rows with no text from then on; both rewrite `ocr.jsonl` in place, in its order |
| `screen-note <meeting> [--out <note.md>]` | Write the screen OCR as a note: one section per frame whose text changed on its display, with its picture and its text (default `<meeting folder>/<id>.ScreenOCR.md`). Each picture is an APFS clone in `<note name>.frames/` beside the note (no extra disk space; a plain copy where the volume cannot clone, and the log says so), linked by a relative path, so Genesis Markdown shows it in a vault note. A second run adds nothing, and an `--out` that is another note is refused |
| `autostart on\|off\|status` | Record the screen whenever Wispr Flow records a meeting (default off) |
| `watch [--once]` | The watcher behind autostart and "ask each time"; the daemon starts it at login when autostart is on or a project question waits |
| `attendance <meeting> [--from <platform>\|<file>]` | Store who was in the call and when, and the sections derived from it (one per join or leave); suggest, speakers stats and evidence read them when no `--attendance` is given. A file is read in a platform's export format: `teams:<file>` names it, a bare path is read in the meeting's platform's format, else in the one format its text fits (Teams: `tools ms-teams meetings attendance --json` output). Second 0 is the source's transcript clock. A Teams call that lists its people without join or leave times (its call-ended message) counts them present for the whole call, and the note says how many. A fresh home needs `tools ms-teams sync` first |
| `listen <meeting> [--item Q12] [--reason <text>]` | Answer the open questions by ear, one at a time: each range is cut with ffmpeg (padding `playback.listen.padBeforeSec` before it and `padAfterSec` after it, asked once on the first run for both sides), with a short tone just before the asked words (`playback.listen.tone`: `enabled`, `leadSec`, and its `sound`: a sine `{ hz, sec, volume }`, a preset `{ preset, volume? }` or a sound file `{ file, volume }`, see "The tone's sound"), and played `delaySec` (2) after the question shows, then again after each `repeat.gapSec` (1) pause until the question is answered (`repeat.enabled`, on by default), also while a "Something else…" answer is typed. A word question shows the line its heard words are in, with the words marked and the lines before and after it. When the round already answered the same heard words at another time, that answer is the first choice and the question says when it was given. A speaker question shows each name's score beside it (`72 %`, see "Speaker candidate scores"); a name without one shows none. Esc goes back one step: from the comment to the choices, from the choices to the previous question, whose answer is undone. "Enough for now", or Esc on the first question, ends the round; the next `listen` goes on from there. Undo reverts only what that answer changed, so an item added meanwhile stays. `--item Q12` (or `12`, or the id `i42`) asks only that question and, after "Several voices", its parts. `--item Q12 --answer "<text>"` answers without audio, in a round of its own, or inside the round a person is listening to. `--reason` is kept in the decision journal with each answer |
| `listen <meeting> --subscribe-answers [--follow] [--from-start] [--timeout 120]` | For an agent: prints the running round's events as JSON lines (`round-start`, `answered`, `skipped`, `split`, `reopened`, `round-end`) while the person answers, from `questions.ndjson` in the meeting folder, and exits 0 at the round's end (an aborted round when the listener is gone), 2 on the timeout in minutes. `--follow` stays up across rounds (the Meetings window answers one question per round) and exits 0 when a round ends with no open question. `--with-comments` adds the comments the person sends from the window to the same stream: one line per comment with `"type": "comment"` (`id`, `text`, `quote`, the transcript `target`, the journal `token`), and every answer line then starts with `"type": "answer"`. Without the flag the stream is unchanged. While it runs, the window names it as the listener a send reaches. An `answered` line names the items it confirmed or rejected in `decided`; `settled` lists the other questions the same answer closed. Run it under a Monitor, so each answer wakes the agent |
| `listen <meeting> --clip-out <dir> [--item Q12] [--json]` | For an agent or a test: cuts each open question's clip (only `--item`'s with it) into `<dir>/<Q12>.wav`, the same clip and tone the terminal plays, and prints one line per clip (`--json`: `[{ question, id, clip, fromSec, toSec, padSec, padAfterSec?, toneAtSec }]`; `padSec` is the pad before the range, `padAfterSec` the pad after it when the two differ). It plays nothing, starts no round and changes nothing; without saved pads it uses 5 s on both sides instead of asking |
| `items add <meeting> --kind speaker-range --from 38:12 --to 38:20 --label "<raw label>" --speaker <name> --confidence 0.85 --reason "…"` | Store an agent's finding (rule `agent`, the reason in `evidence.reason`); it stays suggested until a person confirms it |
| `items add <meeting> --kind term --at 1:02 --heard <words> [--proposed <spelling>] --confidence 0.4 --reason "…"` | The same for a term; without `--proposed` it is asked as free text when it matters |
| `items add <meeting> --listen --from 37:43 --to 37:51 --question "…" [--choices "A,B"] [--decides i7] [--priority 2]` | Add a question of your own for `listen`; `--priority` is on the scale suggest scores its own questions with (below), and one under `playback.listen.minPriority` (0.5) is asked only with `--item` |
| `items add <meeting> --from-file findings.json [--allow-duplicates]` | Equal open findings retain their existing IDs; replaying the same batch adds nothing and names the retained items. Batch refs resolve to those IDs. Confirmed/rejected history does not suppress a new finding. `--allow-duplicates` deliberately appends equal findings. A batch in one write: an array (or `{ "findings": [...] }`) of objects with the flags' names (`kind`, `from`, `to`, `at`, `label`, `speaker`, `heard`, `proposed`, `scope`, `joined`, `question`, `choices`, `decides`, `priority`, `confidence`, `reason`), plus `meaning` or `quote` on a term, and `line` (the line's index, as an `items add` warning names it) on a join or a term when two lines start in one second; times as seconds or "37:43". Kinds: `speaker-range`, `label` (`label`, `from`, `to`, `"meaningless": true`, `reason`: the label tracks no one person in that stretch, so its lines there count as unlabeled for the rules and render as `[nejasné: "<label>"]` unless a range or join gives them a voice), `join`, `term`, `question`. A finding may carry a `ref`, and a question's `decides` may list the refs of its own batch: they become the new ids. A `speaker-range` that a question of the same batch decides may leave out `speaker`: the answer names the voice. A term's `proposed` fixes the words everywhere unless `"scope": "line"`. One bad entry adds nothing. Each join and each term bound to a line is anchored to its line (`evidence.transcriptLine`); a time where no line, or two lines, start is a warning, and so is each new item that would not apply |
| `items add <meeting> --from-file findings.json --plan` | Preview each finding independently through the shared transcript-corrections pipeline: affected line indices (zero based), each line's first eight words, status and warnings. Requires a local transcript, with no remote fallback. Writes no meeting, history, journal or project question |
| `evidence <meeting> --raw [--word-check hunspell\|hunspell-cc0\|macos\|off]` | The facts per line as JSON for an agent: label, text, channel, speaking, muted, present, the people, the silent call stretches (`meeting.callSilent`), the term part and the summary; no rule and no confidence. Reads existing evidence and cached energy without writing. `new`, `link` and `record stop` collect the platform and attendance facts and calibrate the channel energy, and `suggest` does both when they are missing; neither step has a command of its own |
| `play <meeting> --at 1:23:50 [--before 5] [--player vlc\|ffplay] [--json] [--no-start]` | Play the meeting's audio from a moment in VLC (`playback.player`, ffplay as fallback), to hear a voice before `confirm`. `--player` picks the player for one call and is refused when it is not installed (never replaced by another). `--json` prints `{ audioPath, startSec, player, pid }` after the player started; the Meetings window starts ffplay this way (`-nodisp -autoexit`, no window) and pauses, resumes and stops it through `pid`. `--no-start` resolves the file, the start and the player and starts nothing, so an agent or a test checks a moment without sound (with `--json`: the same object without `pid`). A time more than 30 s after the last speech the source keeps is refused with that speech's time. Errors exit 1 with the sentence on stderr |
| `play <meeting> --item Q12\|i42 \| --at 1:49:48 [--to 1:50:02] \| --target '<json>' [--clip] [--no-start] [--tone <sound>] [--json]` | The Moment of a target: the bounded clip `listen` would play, with its pads and the tone before the asked spot (`playback.listen.padBeforeSec`, `padAfterSec`, `playback.listen.tone`). `--tone` plays this call with another tone: a preset's name (`soft`, `tink`), a sound file's path, or a tone setting as JSON (`{"hz":440,"sec":0.2}`), and it sounds even when `playback.listen.tone.enabled` is off; it needs a Moment, so `--at` alone refuses it. `--item` takes an item id or a question's number, `--at` with `--to` a range, `--at` with `--clip` a time (the rest of its line, 4 to 15 s), and `--target` any target as JSON: `{"kind":"item","id":"Q12"}`, `{"kind":"time","atSec":90}`, `{"kind":"range","fromSec":60,"toSec":75}`, `{"kind":"selection","from":{"atSec":60,"fraction":0.5},"to":{"atSec":70}}` (words picked in the transcript: a line's start and how far into its text) or `{"kind":"stretch","atSec":600}` (one speaker's turn, `speaker` to pick whose). `--clip` cuts it into the clip cache, `<genesis-tools>/meetings-cache/moments/<meeting>/<label>-<key>.wav` (at most 500 MB; the clips used longest ago go first, and the same Moment of the same recording is cut once), and plays nothing; `--no-start` only plans it; without either the clip plays once in `playback.listen.player`. `--json` prints the Moment: `{ meeting, target, label, fromSec, toSec, padSec, padAfterSec?, startSec, endSec, spotSec, tone?: { atSec, sound: { hz, sec, volume, file?, preset? } }, delaySec, repeatGapSec?, screen?: [{ file, path, at, meetingSec, displayId? }], path?, player?, pid? }`; `screen` names the frame on each display at the spot when the screen was recorded then. A target the meeting does not have exits 1 with `[unknown-item]`, `[no-time]`, `[bad-range]`, `[unknown-line]`, `[no-speech]` or `[past-the-end]` leading the sentence |
| `projects list` | The known projects, with their dictionary size, labels and match rules (`--json`) |
| `projects add <name>` | Add a known project |
| `projects rename <name> <new-name> [--json]` | Rename a project everywhere it is named: its block (dictionary, labels, match rules, export folder), its source folder pairings and the project of its meetings. Refused when the new name is taken |
| `projects remove <name> [--unassign] [--json]` | Remove a project; its block and pairings go into `~/.genesis-tools/backups/meetings/<time>-project-<name>.json` first. Refused while meetings have it, unless `--unassign` leaves them without a project |
| `projects labels <name> [--add <label...>] [--remove <label...>]` | The labels a meeting of the project can carry ("Checkout 2.0") |
| `projects pair <name> --person "Name <email>"...` | Pair people with a project by hand; a later meeting with them proposes it |
| `projects unpair --entry <id>` / `projects unpair <name> --person <who>` | Remove the pairings one calendar entry made (a person another source pairs stays), or one person from a project |
| `projects people [name] [--json]` | The paired people of each project, with the sources that paired them |
| `set <meeting> --label <text...> --unlabel <text...>` | Add or remove a meeting's labels; a new label joins the project's labels |
| `assign proposals <meeting> [--json]` | The ranked project proposals of a meeting and why, the overlapping calendar entries and the folder step; reads only |
| `assign ask <meeting> [--force]` | Post the meeting's project question to the decision inbox now |
| `assign apply <meeting> --project <name>\|--none [--label <text...>] [--entry <id>] [--pair-folder]` | Apply an answer without the inbox |
| `assign sweep [--json]` | One "ask each time" pass, as the watcher runs it |
| `dictionary show [--project <name>]` | The merged dictionary: global, then the project (`--json`) |
| `dictionary add <value> [substitution] --type fix\|abbr\|term\|keep [--case-sensitive] [--project <name>] [--replace <value>] [--if-absent]` | Add or replace an entry; a new project name is added to the known projects. `--replace <value>` renames: the entry replaces the one with that value in one write, and a refused entry keeps the old one. `--if-absent` only adds: an entry with that value in the level stays as it is, and the command exits 1 with `[dictionary-exists]` (an Undo needs this) |
| `dictionary suggest [--project <name>] [--apply 1,3\|all]` | Entries proposed from the source's own dictionary (Wispr Flow) and from corrections confirmed twice |
| `dictionary expansion every\|first\|off [--project <name>]` | How abbreviations expand |
| `dictionary remove <value> [--project <name>]` | Remove an entry |
| `dictionary test "<phrase>" [--project <name>] [--json]` | The phrase after the dictionary, with each entry that fired and the words close to a term; reads only |
| `overview [--days 14] [--json]` | The recent meetings by day with their badges (no project, open questions, unclear speakers, recording only, transcript only, suggestions at or above `global.suggest.applyAbove`) and the meetings that wait for you; the Meetings window reads it |
| `projects preview [--draft <json>] [--limit 20] [--json]` | Which project each recent meeting matches by the saved rules, and with a draft (`{"work":{"titleWords":["sync"],"calendars":[],"folders":{"wisprflow":[]}}}`); reads only |
| `screen <meeting> --timeline [--all] [--json]` | Every frame in time order with the OCR lines that changed since the display's earlier frame, in frame pixels |
| `screen <meeting> --timeline --frame <file> [--json]` | One frame of that timeline (its file as the timeline names it), with its changed lines and every line |
| `record cost [--json]` | The CPU each capture choice costs: 368.6 ms per kept frame (the meetings-ocr bench) and the newest recording's frame rate |
| `export <meeting> [--to <folder>] [--dry-run] [--if-edited beside\|refuse\|replace] [--json]` | The polished transcript (md, play links, dictionary, confirmed items) as `<folder>/<meeting id>.md`; the folder is `projects.<p>.export.folder` unless `--to` names one; the same meeting again replaces its file. When the note holds edits that the last export did not write, `--if-edited` decides (default `global.export.ifEdited`, `beside`): `beside` writes the new note as `<meeting id>.export-<local time>.md` next to it, `refuse` writes nothing and exits 1 with `[export-edited]`, `replace` overwrites the edits |
| `window [meeting] [--place needs\|all\|<project>] [--tab transcript\|screen\|items\|speakers\|context] [--no-focus] [--no-build]` | Open the Meetings window of GenesisTools.app (the `meetings` app part); Settings → Meetings holds its pages. When the installed app lacks the Meetings part, the command builds it first; `--no-build` fails instead and says how to build it |
| `config show [path] [--json]` (alias `config get`), `config set <path> <json>`, `config unset <path>`, `config edit '[{"path": …, "value": …, "expect": …}, {"path": …, "unset": true}]'` | Read and write one setting; the path is dotted (`global.capture.activeFps`) or a JSON array of keys (`["projects","a.b","labels"]`); a write that would make the config invalid writes nothing. A path that names no setting (`global.capture.activFps`) is refused by `show` and `set` with the closest setting; `unset` still removes such a key. `config edit` makes several changes in one write: all of them, or none when one is refused |

## Permanent source audio

`source-audio/` inside each meeting record holds verified, content-addressed source media. The record stores its source ID, source meeting ID, SHA256, byte count, saved time and path under `audio.sources`. `show` prints the hash, `list` marks preserved audio, and the native list shows Audio preserved. These files are independent of screen recordings. Capture retention and automatic cleanup presets keep them. Explicit deletion of a meeting remains a separate user action.

`sources.wisprflow.preserveAudio` defaults to `true`, with a toggle in Meetings settings under Recording → Source audio. The login daemon starts the watcher, which checks local files every 15 seconds even when screen capture autostart is off. It skips the current live upload and retries delayed publications. A completed local file is normally archived on the next tick, within one minute when the watcher is running and a copy can finish in that time. If the app is stopped, disk writes fail or the provider has not published audio, the next successful look retries. Nothing downloads from a remote provider for discovery or backfill.

Historical backfill is explicit. Save and inspect the read-only plan, then apply that exact file:

```bash
./tools meetings audio plan > /absolute/private/audio-plan.json
./tools meetings audio apply /absolute/private/audio-plan.json
```

The plan reconciles every local provider file, the legacy `meetings-audio-archive/` files and owned media. It reports missing, conflicting, live and unmatched sources, including orphan files whose metadata disappeared. Apply revalidates file hashes, sizes, availability, live state, store root and record links. It creates records only for sources with local metadata, never changes originals, and supports retry after partial progress. Files whose provider and legacy digests disagree are left for investigation. Once provider files are gone, the owned copy still serves playback, listen clips and evidence audio. Audio reads do not archive or mutate records.

The shared service exposes `sourceAudio.plan` and `sourceAudio.apply({ plan })`. The REPL exposes `meetings.audio.plan()` and `meetings.audio.apply(plan)` through the same implementation. Apply is an explicit write operation. Plan performs local reads only.

## The meeting record

One folder per meeting, `~/.genesis-tools/meetings/<YYYY-MM-DD_HH-MM>-<title>/meeting.json`. A meeting is named by its
id, a unique prefix of it, `last`, or a source reference such as `wisprflow:1a2b3c4d`. Every change adds one line to
the record's `history`, and a change that would make the record invalid writes nothing.

A refusal a client may act on leads its `✗` line on stderr with a code in brackets, and exits 1. A state of the
meeting: `[no-transcript-source]`, the meeting has no linked source with a transcript or audio (`transcript`,
`speakers stats`, `suggest`, `evidence`, `export`, `play`); the Meetings window shows its empty state on it. A conflict:
`[config-stale]`, `[export-edited]`, `[export-unsafe-path]`, `[item-changed]`, `[dictionary-exists]`, `[source-linked]`. The code is for
programs; the sentence after it is for people.

Every command that creates or changes a meeting resolves its project in this order: `--project` (a new name joins
the known projects), the meeting's own, one matching project (`projects.<name>.match`), a choice in a terminal, and
without a terminal no project. `show` then says how to set it.

A meeting has one project and any `labels`, so meetings group finer without sub-projects.

### Ask each time

A meeting that ended with no project gets one question in the decision inbox (the widget inbox, the dev-dashboard
`/qa` page and a notification), once. It is asked when the meeting ends, whatever started its recording: the recorder
process asks after its stop, and `new --source` and `link` ask when the source gives the meeting its end. The watcher
asks on each look too (`assign sweep`), and its sweep is what reads the answers back, so it runs while autoRecord is
on and, with autoRecord off, while a question or a folder step waits (an end that posts a question starts it). Only
meetings that ended after the first sweep (or the first ask) are asked, within `global.assign.lookbackHours` (48). An
end that cannot be asked about (the record does not show the end, or the post fails) is a warning in the day log that
names the meeting. The question ranks the known projects, each with
its reasons, best first (`assign proposals` shows the same):

| Reason | Points |
|---|---|
| The source folder the meeting is in is paired with the project (`sources.wisprflow.match.<p>.folders`) | 100 |
| An overlapping calendar entry is in one of the project's calendars (`match.calendar.calendars`) | 60 |
| The title has one of the project's words (`match.title.words`) | 40 |
| People paired with the project are on an overlapping entry, or in the transcript | 15 each, 60 at most |
| Title words the project's earlier meetings had | 8 each, 24 at most |

It also lists the calendar entries that overlap the meeting (Apple Calendar, which holds the synced Outlook and Teams
accounts, merged with Wispr Flow's own calendar, which has the attendees' emails), the labels, and the Wispr folder
step. A calendar that cannot be read says so in the question; an unread calendar is never "no entries". The answer
applies everything at once: the project (a new name joins the known projects), the labels, the picked entry (its
attendees are paired with the project, `pairedBy: [{ kind: "calendar", entryId, ... }]`) and the folder pairing.
A wrong pick is undone with `projects unpair --entry <id>`: it removes only the pairings no other source holds.

The Wispr folder ladder: Wispr Flow cannot be changed from here (its MCP tools only read; its `wispr-flow://` scheme
only opens pages). A meeting in a folder no project has is offered to pair that folder. A meeting in no folder: the
question tells you to move it in Wispr Flow, and the next sweep that sees it in a folder asks to pair that folder.

## Recording

`record start` checks Screen Recording first, by the classic route: granted already, then the macOS prompt for the
identity that captures (GenesisTools.app when it is installed, else the terminal), then GenesisTools.app's own
permission window, and without the app it says what to install and grant. Without a terminal (`--yes`, the daemon) it
never prompts and only says what to run.

The recorder is a frame recorder from `src/utils/screen-recorder/` (`capture.backend`: `native`, GenesisTools'
own `ax-tool capture`, by default; or `peekaboo`). It records in 30 s pieces with the capture policy every recorder follows (`capture.activeFps`,
`idleFps`, `threshold`, `resolutionCap`) plus the recorder's own block (`capture.recorders.native`: `quietMs`,
`heartbeatSec`, `maxMb`, unset keeps ax-tool's own; `capture.recorders.peekaboo` has no keys of its own), converts
each frame to JPEG under the meeting's `frames/` as `<HH-MM-SS-mmm>-d<displayId>.jpg`, and lists it in the frame
index `frames.jsonl` (`file`, `at`, `displayId`, `changePercent`, `reason`, `motionBoxes`). Each capture ends at its
duration plus 30 s; a hung one is stopped and counts as a failed capture.

OCR is a second phase in a process of its own, so a stuck OCR never holds or stops the capture. The recorder starts
`tools meetings ocr <meeting> --follow` at its start: one worker per meeting (`ocr.pid` in the meeting folder) reads
each indexed frame that has no `ocr.jsonl` row yet, in index order, with Vision in the OCR languages of the meeting
language (`languages.<global.language>.ocr`, `cs-CZ` and `en-US` for `cs`), appends its row (each names its
`displayId`), and ends once the recording stopped and every frame has a row. A restart goes on where `ocr.jsonl` ends.
A read that throws is tried again; after 3 failed reads in a row the worker starts a fresh OCR helper (a long-lived
one answered every read with `CRImageReaderError error 1` for an hour on 2026-11-11). When the fresh helper fails too,
the worker reads a different frame right after: when that one reads, the first frame is bad and gets a row with
`failed`, `attempts` and no text. When it fails as well, Vision is down on this Mac (on 2026-11-11 every read timed
out for hours while `ANECompilerService` ran at 96% CPU): the worker writes nothing, waits on the same frame (30 s,
1 min, 2 min, then every 5 min) and tries it again, and a `--follow` worker keeps waiting through the outage. One
notice per outage says "Text reading (OCR) fails on this Mac", and "Text reading works again" at its end, as
`capture.failureNotices` sets (`failing-and-recovered`, `failing` or `off`). After reads work again the worker gives
each failed row another round, at most 3 rounds per frame; `ocr --retry-failed` reads every failed row again. The watcher starts a
worker for a meeting of the last two days whose index lists frames without a row while no worker runs. A meeting
recorded before the index has only `ocr.jsonl`; every reader takes its rows as the frame list.

`capture.ocr` decides which kept frames OCR reads. `threshold` (0 to 1, default 0) is an OCR-only change threshold
beside `capture.threshold`: a kept frame that changed less keeps the previous frame's text for its display.
`skipTextless` (default off) reads the changed area at Vision's fast level first, and a frame whose changed area holds
no text, before or now, keeps the previous text too. A skipped frame's `ocr.jsonl` row carries the copied text and
`skipped` (`below-threshold` or `no-text`). `region` (`frame` by default, or `changed`) reads only the changed areas
of a frame (at most four, each grown to hold every line it touches) and keeps the previous frame's other lines; the
row's `blocks` stay in whole-frame coordinates and `regions` lists the areas read. It is off by default because a crop
costs about as much as a whole read (each Vision call costs about 110 ms of CPU or more) and reads more small text than
a whole read of a wide frame does, so the text would change (`docs/benchmarks-cpu.md`, 2026-11-05). The first frame of
each capture and each display switch is always read whole.

`capture.ocr.read` selects `frame` or `tiles` (default) for a full-frame read, including the first frame and display switches.
`frame` keeps the existing whole-image read with language correction. `tiles` reads the original image through Vision
regions, with language correction off: a grid whose tiles are at most `capture.ocr.tilePx` (default 960) frame pixels
on their longest side, top row first, so a 2880 px frame is read as 3×2. Each tile extends 3% of the image past its
inner edges. A line read twice, or a seam tile's cut piece of a line another tile read whole, is kept once (the whole
line); block bounds stay in full-image coordinates. On 12 kept frames of three displays (2026-11-09) the 3×2 grid read
86% of the words any grid read, against 80% for the two strips and 42% for one region, at about 400 ms CPU per frame
against 180 ms; a smaller `tilePx` reads smaller text and costs more CPU (720: 88%, 440 ms). No tile crop files are made. The existing vertical-crop fallback for images
larger than 6000 pixels remains unchanged. `region: changed` still controls changed-area crops independently; `read`
applies when a full-frame read is needed. The default and second-meeting measurements are recorded in
`docs/benchmarks-cpu.md`.

`capture.displays` picks what is recorded: `all` (default) records every connected display at once, one capture per
display per piece; `main`; `follow-focus` (the display of the focused window, when the recorder supports it, else the
main one); or a screen index. Each piece reads the display list again by id, so a display that is connected joins at
the next piece and one that is removed leaves without an error. When an asked index is not connected, the main
display stands in and the warning says since when.

Frames stay on this Mac and never go into an export. Once a day the watcher moves the `frames/`, `frames.jsonl`,
`ocr.jsonl`, `audio/` and `audio.jsonl` of each meeting whose newest capture file (a frame, an OCR line or a sound track) is older
than `capture.retentionDays` (30) into the GenesisTools trash (`tools rm` rules, restorable with
`tools rm restore <batch>`), so a recording with sound only expires too. The editor files made from them
(`recording.json`, `proxy.mp4`, `proxy.transcript.json`) go with them; opening the editor rewrites those files, so it
never postpones a meeting's retention. The meeting record, its items and the recording block stay. It
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
episode, for recordings a person started too, and the recorder process (`record run`) then exits 1. A recording
without a frame says so in its warning. `show` prints
the recording's state, frames per display, spans and warning.

### Autostart

`tools meetings autostart on` sets `sources.wisprflow.autoRecord.enabled` and starts the watcher; the daemon starts
it at every login while it is on. The watcher follows the first source in the source registry (`lib/sources.ts`)
whose `sources.<id>.autoRecord` is on, today Wispr Flow. Every 15 s the watcher asks Wispr Flow for a meeting it has not ended whose live
transcript changed in the last `liveWithinSec` (30). It then runs `record start --source wisprflow:<id> --yes` and
posts a notification (`notify`, default on). It stops only the recordings it started, when Wispr Flow ends the
meeting. Silence never stops one, since a listener who stays quiet is still in the meeting. A start that failed (no grant) notifies once and is not
retried for the same meeting. A recorder that stopped on its own while the meeting runs (`stopReason: "failed"` or
`"error"`) is started again 2 min after it stopped, with `record start --meeting <id> --yes`, and every 2 min after
that; the recorder posts the notice. A stop the user asked for stays stopped. A stop that failed keeps the watcher's
claim, so the next look stops it again. When Wispr Flow ends the meeting, the watcher links it again (title, end,
people) on each look until the record has an end, for up to 10 min.

## Items

A rule's finding is an item with a confidence and the rules that produced it. A person confirms or rejects it; only
confirmed items change a transcript. `--with-suggested` previews the rest: it applies a suggested item at
`global.suggest.applyAbove` (0.5) or more, and one with no confidence (a person's own); a lower one is marked unclear,
as an open question is. A range owned by an open speaker question stays a guess at every confidence until
answered or confirmed.

Suggest uses the linked source's title and transcript clock when it looks up attendance, including for a renamed
copy. Unavailable platform attendance produces a warning, skips E2 and saves the other suggestions. A missing or
ambiguous Teams chat lists cached candidate titles and IDs, ordered by last-message proximity rather than call
start. These candidates do not prove which chat belongs to the call. Select a known chat with
`tools meetings suggest <meeting> --attendance teams --attendance-id <threadId>` or the REPL's
`meeting.items.suggest({ attendance: 'teams', attendanceId: '<threadId>' })`. Invalid input and unreadable or
malformed attendance files still fail.

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
- When the source favors the microphone but measured energy favors the call, a platform label stays open with known
  people as candidates. The conflict alone confirms nobody; the range asks for listening.
- A stuck speaking indicator: E3 showing the same one remote person for 6 min or more while a third of the lines are on
  the microphone is ignored for that stretch.
- R20, swapped labels: in 5 min windows of a calibrated recording, the user's label sits on the call's channel (median
  microphone share 0.3 or less) while one platform-named label sits on the microphone (0.7 or more) for 10 min or
  more, and the two read the other way elsewhere in the call. The recorder swapped their names there: the other
  label's lines are the user's and the user's label's lines are the other person's, one item each over the stretch
  (0.5 plus half the gap of the two medians, at most 0.9). R18 and the per-line rules leave those lines alone.
- `join`: a word cut between two lines ("dot" + "áhnu"), or one sentence cut between two whole words: a `joined`
  value with a space ("jsem zvědavej") keeps the space.
- `term` from the word check (rule `unknown-word`, 30 % without a strong proposal): a word no dictionary layer knows.
  A one-edit match to a scoped term also spoken correctly, or a stronger acronym spelling observed in this meeting,
  supplies a proposal at 80 %. Weak matches stay in `evidence.candidates`. A word said on purpose
  gets no item: a word family heard in two or more forms (`wordFamily`, the first four letters of the stem after one
  Czech prefix: "mokovaný", "namokovat", "nemokovaný"), or a Czech form of a known English word ("mokovat" from
  "mock"). A `keep` entry covers every form of its family.
- `term`: a misheard term and its proposed spelling, a passage read aloud from a context file (its quote and line),
  or a spoken path or identifier (its meaning after the words). A context file is read as the meeting saw it: when it
  changed or was deleted after the meeting, from its last git commit before the meeting's end; `suggest` warns when no
  copy is left. For an explicit saved version, use `context add <meeting> <file> --before-meeting` (the last
  committed version before the meeting start) or `--rev <sha>`. Later reads use the saved text and commit for
  `evidence --raw`'s `terms.documents.readAloud` and `terms.documents.identifiers`. With `global.suggest.restatedIdentifiers` at `skip` (the default), a plain code name that only writes
  the said words in code form ("entity data", `EntityData`) gets no meaning; a path, a member chain or a CONSTANT_CODE
  still does. `mark` adds them all.
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
the explicit steps. They are methods, not commands: `new`, `link` and `record stop` run them, and `suggest` runs them
when their facts are missing. suggest, evidence, `evidence --raw`, attendance, speakers stats and items open meetings through it.

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
   summary, or a decision in its line; any other low term is only marked in the transcript. An unknown word with
   nothing proposed needs an identifier's shape (`OpenAI`, `CTOčko`), or two occurrences with a capital that no
   sentence start explains (a name). A lowercase unknown word is speech (a colloquial form or slang): it stays an item
   in `items`, and gets no question and no mark in the transcript. One line gets at most one such question.
3. A goodbye or attendance range is dropped when finer audio-evidence items cover 80 % of it.
4. Speaker questions cluster only for the same single label, exact range and clip times, and choices.
   Separate neighbouring passages stay separate.
5. Priority = (1 − confidence) × impact × reach. Impact is log2(1 + words), +3 for a decision word, +3 when the
   range cites a summary action item or decision (`global.summary` headings), +2 when the answer moves an action's
   owner. Reach counts the questions with the same signature (top two choices and the people present). One
   unsure question usually scores 1 to 3, a cluster 6 or more. A question an agent adds takes `priority` on the same
   scale, so suggested and added questions sort in one order and `minPriority` means the same for both.

A meeting has at most `global.suggest.questionCap` (12) open questions, whatever the number of `suggest` runs; `listen` asks by priority, at most
`playback.listen.roundCap` (12) per round and none under `minPriority` (0.5). A split
uses no budget: its parts come next and share their parent's unit, so the header shows `3/12 · part 2/4`. Each
answer settles compatible look-alikes. A speaker answer requires the same single label, exact range and signature,
and an offered answer; its items gain +0.3 up to 0.9, closing questions that reach the threshold. A word answer
propagates only between questions with the same heard words and choices that decide exclusively global terms ("settled by the answer to i7"); the `answered` event lists them in `settled`, and an undo
reopens them (`reopened` with `also`). "Enough for now" ends the round; the rest stay marked in the transcript.
Through the service an answer can leave its look-alikes open: `decision.apply` with
`{ kind: "answer", question, answer, lookAlikes: "leave" }` decides the question and what it decides, nothing more
(the window's "Only this question" in its "This also affects" sheet). `listen` always settles them.

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
  in their own call), an agent's range over the same lines names them (2 times its confidence and overlap, the
  polish). A voice the roster does not list keeps 0.2, or 0.05 when attendance is known.
- Rule R17 counts against a person: a line where they talk under their own label within 10 s is the other side of
  that dialogue, not their voice, so that line's share is taken off their weight. Their score lists it as `timing`
  evidence with `against: true`. Until 2026-11-13 this timing counted for the person (weight 2, read as one voice cut
  into two labels), which contradicted R17.
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
  spans), with three prose words at least. The item's `quote` holds the line; the transcript shows its exact text
  instead of the misheard words, as a quote block in Markdown and in quotation marks elsewhere, with the source
  (`(čte z WikiProposals, ř. 33)`, from `languages.<global.language>.render.readAloudLabel` and `lineLabel`). The dictionary does not
  touch the quoted text.
- `spoken-identifier`: two or more words that say a document identifier in order ("employee only" for
  `employeesOnly`, "administration CMS schema" for `/administration/cms/schema`), or one path segment after "lomeno"
  or a slash (`/{type}`). A comma between the words ends the run. The words stay; `meaning` names the identifier,
  shown after them. An identifier is marked at its first mention and again after two minutes without one.

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

## The dictionary

- `fix`: a misheard spelling, replaced at every whole-word match in any letter case (`DTLčko` becomes `DTOčko`, and so
  does `dtlčko`). `--case-sensitive` (config `caseSensitive: true`) keeps the exact-case match.
- `abbr`: an abbreviation. Its substitution must contain the abbreviation itself, so the original stays:
  `MOP` becomes `MOP (Obchodní partner podnikatel)`. A substitution without it is refused.
- `term`: a correct spelling the misheard-term check should know; `--spoken` lists how people say it.
- `keep`: a word the misheard-term check must never flag.

Whole-word matching keeps hyphens inside a token: an entry for `Tavo` does not rewrite part of `Tavo-taa`.
The same boundary protects spoken forms, abbreviation expansion and term meanings. Fuzzy candidates also keep
the whole hyphenated token.

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
    "version": 4,
    "global": {
        "dictionary": { "abbrExpansion": "every", "entries": [] },
        "language": "cs",
        "capture": { "backend": "native", "activeFps": 1, "retentionDays": 30, "recorders": { "native": { "maxMb": 400 } } },
        "playback": { "listen": { "roundCap": 12 } },
        "suggest": { "questionCap": 12 },
        "assign": {
            "ask": true, "lookbackHours": 48, "maxProposals": 5, "calendarSlackMin": 15,
            "calendarLookbehindHours": 3, "folderWaitDays": 14, "retryFailedMin": 10
        },
        "people": { "sources": { "contacts": true, "calendar": true } }
    },
    "projects": {
        "work": {
            "dictionary": { "entries": [{ "type": "abbr", "value": "MOP", "substitution": "MOP (Obchodní partner podnikatel)" }] },
            "labels": ["Checkout 2.0"],
            "export": { "folder": "/path/to/the/vault/folder" },
            "match": {
                "calendar": { "calendars": ["Work"] },
                "title": { "words": ["Wiki"] },
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

`global.assign` timings: `calendarLookbehindHours` (3) is how long before a meeting a calendar entry may start and still
be looked up (never less than `calendarSlackMin`), `folderWaitDays` (14) is how long a meeting waits to be moved into a
source folder before the folder question ends, and `retryFailedMin` (10) is how long after a failed post the project
question is posted again. `languages.<code>.fillers` is what `recorder cut-fillers` cuts for that language: `sounds` are
never words, `words` are fillers that are also real words (cut only with `--all`). `cs` and `sk` ship their lists; `en`
has a shipped list without a block, and a block of another language may omit `fillers` to keep the shipped list of its
code. An older file without these keys reads with the values above.

`languages` has blocks for `cs` and `sk` with every default; another language is a block with every key
(`ocr`, `render.unclearLabel`, `readAloudLabel`, `lineLabel`). `global.language` picks the block that labels the
transcript and reads the screen.

Older settings are migrated in memory when read; `config show` and other reads do not rewrite the file.
An explicit edit saves the migrated shape under the config lock. For version 1, `global.render` moves to `languages.cs.render`,
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

`languages.<code>.wordCheck` names the word check provider of a language (`hunspell`, `hunspell-cc0`, `macos` or
`off`). Without `--word-check`, suggest and `evidence --raw` check each language's lines with its own provider, and a
language with no provider or an unknown one uses `hunspell`; `--word-check` sets one provider for every language.

A change that would make the file invalid is refused, and the file stays as it was.

`GENESIS_TOOLS_HOME` names the folder above `.genesis-tools`. When it points at the `.genesis-tools` folder itself, so
the records sit in `$GENESIS_TOOLS_HOME/meetings/` instead of `$GENESIS_TOOLS_HOME/.genesis-tools/meetings/`, a
meeting that is not found and an empty `list` say where the records are and what to set.

### Per-call silence and choice order

`play <meeting> --item Q1 --no-tone` suppresses the tone for that Moment without changing the saved setting. The service methods `moment.plan` and `moment.clip` accept `tone: false` for the same purpose, including when an explicit `toneSound` is supplied. Omitting it keeps the saved behavior.

Review-row choices put all scored values highest first, including an earlier answer or the suggested speaker. Their roles and actions stay attached to the same values; unscored choices and actions follow in their existing order. The interactive terminal keeps its existing answer-key order.

## Comments and read receipts

Select words in the transcript to stage a comment. A send records delivery; it remains unread until its receiver acknowledges it. An unread comment can be withdrawn. The comment history shows Unread, Read or Withdrawn.

```sh
tools meetings comments list <meeting> --json
tools meetings comments read <meeting> <comment-id> --json
tools meetings comments withdraw <meeting> <comment-id> --json
```

A receiving agent must acknowledge a comment before acting on it. If withdrawal won the race, acknowledgement fails with `withdrawn-comment`; if acknowledgement won, withdrawal fails with `already-read`. The live `--with-comments` stream emits a `comment-withdrawn` record so a receiver can remove work it has not acknowledged yet. Read receipts and withdrawals remain in the meeting's append-only comment log.

In the REPL, the same operations are `meeting.comments()`, `meeting.readComment(id)` and `meeting.withdrawComment(id)`. They use the same service or in-process implementation as the window and CLI. The CLI also provides `comments stage`, `comments unstage` and `comments send` for scripts and for the window's fallback path.

Routed timestamp links prefer the already-open Meetings window and push their Moment onto its playback stack. `play --moment --window` uses the same path, retaining per-call tone, padding, length and screen options. With no open Meetings window it uses the command player. An explicit `--player`, `--clip`, `--json` or `--no-start` keeps the command's existing behavior.

## Where the data lives

The default root is `~/.genesis-tools/meetings/`; `GENESIS_TOOLS_HOME` selects another GenesisTools data home.
`config.json` holds projects, source matching, the dictionary and playback/capture settings. Each meeting has its
own folder and `meeting.json`; ordinary context files outside it remain references. An explicitly selected
context revision keeps its document text and full commit inside the meeting record. The current API groups the repeat switch
and gap under `global.playback.listen.repeat`. The saved version 7 file retains the boolean `repeat` and numeric
`repeatGapSec` that older stable builds read; the loader groups them for current callers.

A recorded meeting keeps images in `frames/`, their times and displays in `frames.jsonl`, and recognized text in
`ocr.jsonl`. OCR can lag behind capture; a missing OCR row does not mean a missing frame. The decision journal is
`decisions.ndjson`, and listen/answer events are in `questions.ndjson`. Keep these files with the record when making
a backup. Merge and project-change backups are kept under `~/.genesis-tools/backups/meetings/`.

## Speaker evidence and review

Speaker labels are source labels, not person identities. Sure microphone lines offer the recording user and the
explicitly listed people sharing that microphone. The user is capped at 70% for a platform label. Shared microphone
membership stays uncertain until another source identifies the voice. A remote goodbye never closes the recording
user's later lines, and an ambiguous goodbye leaves the departing person unresolved.

Speaking observations expire after at most ten seconds and at the next read. Failed or occluded reads are unknown,
not silence and not a repeated speaker. One assessment ignores an indicator that dominates more than 80% of all
lines with at least twenty samples, or at least 90% of call lines in a long stretch with competing remote speakers.
Raw evidence keeps its observations and reports why the indicator was ignored. A label swap applies only to lines
whose own channel agrees; the review row and transcript selection detail report skipped contradictory lines.

Suggestion collection retains raw and estimated cleaned microphone metrics separately. Linear echo subtraction is
an estimate, so a mixed raw microphone line does not become a remote identity just because its residual is small.
Term candidates come from the meeting dictionary, context, people, user vocabulary and stronger acronym spellings
observed in the same meeting. Vocabulary sources appear on term review rows. No developer-tool glossary is added
implicitly, and a known Czech word form is not rewritten by a phonetic guess.

The Meetings window offers a clean-copy action, shows copy provenance, displays shared microphone groups and lets
you edit their members. Selected transcript lines show the applied rules and ignored indicator metadata. Context
files can be pinned with `context add <meeting> <file> --rev <commit>` or `--before-meeting`. Short listen rounds accept
`listen <meeting> --questions <refs>`; the CLI help describes the question file and item-reference forms.

## Troubleshooting

- If the service is unavailable, use `tools meetings serve --status`. Start it with `tools meetings serve --detach`;
  `--no-idle` keeps it running without an idle timeout.
- If recording fails or gives only the desktop, check `tools meetings record status` and `tools control doctor`
  before changing capture settings. A missing privacy grant is not proof of an empty screen.
- If frames have no text yet, use `tools meetings ocr <meeting> --follow`. Use `--retry-failed` for failed reads, or
  `--reread-empty-since 15:56` for empty reads since that local time on the meeting's day.
- Inspect failed command records with `tools genesis-tools logs failures`. The failure's saved context belongs to
  that event; opening Details does not run the failed command again.
- To take back a review decision, use its journal token with `tools meetings journal <meeting>` and the Undo/reopen
  command it names. `revisions` only reports change tokens; it does not restore older transcript content.

### Choosing a short listen round and adding a question

`listen <meeting> --questions Q2,Q7` asks only the named open questions, including any parts split from them. Explicit selection bypasses the minimum priority filter. Unknown or closed IDs refuse the whole selection before a round starts. It also works with `--clip-out` for a read-only export of those stored questions.

`listen <meeting> --questions questions.json` reads a JSON array such as:

```json
[{"from":"1:19:28","to":"1:19:40","about":"text","question":"Who owns the export?","choices":["Alice","Bob"]}]
```

The questions enter the normal decision journal once the interactive adapter and player are ready. Answers, answer subscriptions, split, and Esc use the same path as stored questions. An omitted `decides` saves an answer without changing another finding. Existing equal open questions are reused. `--questions -` accepts one JSON line pasted into the interactive terminal. A piped/noninteractive invocation cannot play an interactive round; add findings with `items add --from-file -` first, then listen by their stored IDs.

Line-scoped terms with a dead or ambiguous anchor are refused. The diagnostic distinguishes a missing time, words in a different line, and words absent from the transcript. `items add --force` deliberately saves an invalid anchor and retains the diagnostic. The decision API and REPL `items.add` accept the same optional `force` flag.

The Meetings window offers Add question or term, clean duplication, question priority, saved document revision, and an indicator tooltip naming a stuck signal and why it was ignored. Its dictionary editor can preview an unsaved entry on pasted transcript lines. The read-only command equivalent is `dictionary test '<lines>' --entry '<dictionary-entry JSON>' --json`.

The transcript's native confidence selector defaults to 70 percent. The service loads the available threshold previews together, and changing the selector chooses a loaded result without a new source read. The selector is saved per app; it changes no meeting or global suggestion configuration. CLI `transcript --with-suggested --apply-above 70` uses the same corrections engine for a one-off preview. Open question ranges keep their guessed speaker percentage until answered.

For a meeting-local room person, use `attendance <meeting> --add "Alice Example" --from 0 --to 600 --at-mic`. `--via "Bob Example"` instead names a remote device owner. These finite stays and canonical microphone groups reopen from the meeting record. The native people strip and `meeting.people.edit` use the same implementation. Imported platform speaking and muted names also join automatic question candidates. `Meeting.editPerson` exposes the same operation in the REPL.

## Listening with uncertain evidence

Speaker-question selection and the terminal/native queue rank by `(1 - confidence) × words × distinct answer targets`.
The displayed priority and its minimum filter keep their existing scale. Questions without word counts, including older
records, retain priority order. Matching candidate names alone never multiply reach or establish one voice identity.

Suggested speaker names under 70% remain explicit guesses by default. `transcript <meeting> --with-suggested
--apply-above 80` and `rows <meeting> --apply-above 80` change the read's threshold; they do not change saved
confidences. The Meetings transcript has the same local threshold picker and Probe. Confirmed answers remain applied.

`transcript <meeting> --probe-thresholds 50,60,70,80` prints the applied, guessed, open and long-stretch counts at each threshold.
`--spot-check 20` samples distinct lines at 50–69%, asks a short round and keeps its changed/answered result.
`--long-stretch-words 50` prepares longer uncertain stretches, split at canonical call-channel pitch/level or turn
changes. `--prepare-only` saves questions without playback. `--group rules|spot-check|long-stretch|all` selects a group.
The native Items tab has the same preparation controls, group counts, sample result and history. Preparation counts
are adjustable there. `global.suggest.longStretchWords` sets automatic long-stretch preparation.

A speaker answer must match a known person. Accents, name order and parenthetical affiliations do not affect matching.
Unmatched prose is kept as a comment and the question remains open. Somebody else chooses a person; Something else
writes a comment. Multiple names in speaking order store ordered voices; sentence boundaries split turns when they
are available. Native Two voices also accepts an explicit word boundary. Ambiguous boundaries retain both names in
an unclear mark. Space pauses/resumes the terminal clip at its current position; entering text pauses playback.
Split clips use saved acoustic word timings when available, otherwise a bounded quiet-gap search, with at least
1.5 seconds before the split. All question clips include the final quoted line through its end.

The source roster keeps self, first-seen times and finite manual windows. A failed, obscured or missing speaking read
is unknown, never an empty-room observation or a repeated speaker. A good read expires at the earlier of the next
read and ten seconds, exclusively. `collect` persists person stays from canonical identified departure events;
later valid speaking observations or confirmed voice assignments veto the inferred leave. Silence requires an
observed quiet call window, with `global.suggest.leaveSilenceMinutes` (10 by default); its confidence remains 50%.
Manual `attendance --add/--remove`, `--from/--to` and the native people strip use the same room-person editor.

`listen <meeting> --enrol-voices` explicitly extracts isolated-call voice embeddings using an already installed
canonical model. Calibrate physical channels and set remote seats first. Enrollment uses solo remote windows or
human-confirmed single-voice lines. A held-out window cannot score itself. Cosine similarity is not a probability;
ambiguous, unavailable or below-gate lines stay unknown with provenance in `voice-embeddings.json`. The original
source audio is never rewritten. The native people controls show enrollment results and canonical voice features.
No model is downloaded by a read or ordinary listening command.

The REPL Meeting handle exposes `editPerson`, `voiceFeatures`, `prepareListen`, and `enrolVoices`, routed through the
same service contracts. `lines({withSuggested:true,applyAbove:0.8})` and `items.rows({applyAbove:0.8})` accept thresholds
as fractions. The CLI threshold uses percentages. Set the project before polishing so its dictionary can apply;
project suggestions use earlier shared attendees/title words, and an unassigned meeting warns when dictionaries exist.
Agent findings may attach an explicit `signature` and `candidates` to speaker ranges and the same `signature` to their
question. Only matching labels and evidence identities propagate an answer to unasked ranges. Unknown call-channel
observations produce unresolved candidate ranges, never an inferred shared voice identity or propagated answer.

### Indicator facts, compact evidence and local speech

`evidence <meeting> --raw --json` always includes `channel: { micShare: number | null }` on each timed transcript line.
`null` means no overlapping channel segment, and is distinct from a measured zero. `energyMicShare` remains the
separate calibrated energy measurement. People found only in speaking or muted observations have `origin: "indicator"`.

`evidence <meeting> --voice-features` (or `--voices <n>`, which clusters the lines into that many voices) measures
each line's RMS, low-band share, tilt and pitch for both physical audio channels and puts them in a new field,
`voiceFeatures`, on each JSON or raw line. `voice` stays the voice match. Without one of those flags nothing is
measured, and both flags print only with `--format json`, `--format lines` or `--raw`.

`meeting.labels` reports each platform label's `firstOwnIndicatorSec`, optional `firstJoinSec`, and its earlier-line
count. Ten or more lines before the first own indicator or join produce one `platform-prehistory` label finding at
80 %, with `meaningless: true`. Speaker scoring ignores that label inside the finding's stretch. This rule has its
own id because the existing R20 id already names swapped labels.

`meeting.indicatorGaps` contains `{ fromSec, toSec, reason }` for intervals of at least 60 seconds without a usable
speaking or muted observation while transcript lines are spoken. Empty observations do not establish anyone's absence.
Suggest prints these gaps as warnings. The generic missing-indicator reason does not infer a screen share from silence.

`evidence <meeting> --format lines` prints a name legend and one compact row per timed transcript line:
`index|time|person|micNN%|eENERGY|s[people]|m[people]|text prefix`. Unknown microphone share and energy print `?`.
Text prefixes are bounded to 48 Unicode characters; use raw JSON to read the full transcript. The Meetings Speakers
pane's Evidence facts disclosure uses the same formatter and lists label prehistory, indicator gaps, indicator-only
people and local speech. Its service read is `meeting.speakers` with `evidence: true`; existing readers omit it.

Completed audible calls from the local speech history are matched against transcript words within 15 seconds of the
recording clock. Written files, muted calls and failed calls are excluded. Raw lines carry `localSpeechOutput: true`;
suggest offers `kind: "removal"` at 90 % with reason `local speech output`. Confirmation hides only the matching
line in the corrected transcript; the source transcript stays intact. The speech history is opened read-only.

### Stem term findings and scoped vocabulary

A term finding can supply `heardStem` and `proposedStem` together. For example, `heard: "i na browser"`,
`heardStem: "i na browser"`, `proposedStem: "in-app browser"` replaces the base plus its recognized Czech endings,
keeping each ending. CLI flags are `--heard-stem` and `--proposed-stem`. The finding preview and correction outcomes
list the lines it reaches. Line scope still limits its reach. An unrelated longer word is left alone.

Automatic candidates come from the meeting's resolved dictionary, context documents, people and source user
vocabulary. The shared developer-tool glossary is not injected. Known Czech words and known inflected stems are
kept, and a run ending in a Czech copula is not glued into a technology name. An observed acronym candidate needs a
stronger spelling in the same meeting and keeps its heard suffix. No missing context is invented to supply a proposal.

`window <meeting> --new-window` forwards an independent-window request to the Meetings face. Each extra window keeps
its own meeting model; `--tab` and `--no-focus` are preserved. Helpers transform themselves into background-only
processes while retaining the signed identity needed for TCC. AppleScript can select the real window process with
`first application process whose bundle identifier is "com.genesiscz.genesistools" and background only is false`.
A desktop check after the parent installs the reconciled app must verify two independent windows and that process selection.

### Seats, project roles and channel attribution

Store confirmed seating with `tools meetings set <meeting> --seats '<json>'` or `meeting.set({seats})`. The shared shape is `{room: string[], remote: {name, label?, fromSec?, toSec?}[], microphones?: {id, label?, people: string[], deviceId?}[]}`. A microphone group contains only room people or only remote people. ID `self` is the owner's microphone; `deviceId` identifies the device owner. Join is inclusive, leave exclusive. Old remote strings load as named remote seats without changing the source file.

`tools meetings projects people <project> --person <name> --role <role> --alias <names...>` edits explicit project details. The role column and `evidence --raw` show them. Unknown roles stay unknown. Notes never become roles.

`tools meetings items by-channel <meeting> --label <label> --dry-run` plans ranges from channel shares, using saved seats unless `--room` and JSON `--remote` override them. `--mic-max` defaults to 0.2, `--mic-min` to 0.85, `--min-chars` to 25. The REPL equivalent is `meeting.items.byChannel({label,dryRun:true})`. Inspect the plan, then apply explicitly. `replace:{kinds:["speaker-range","question"],by:"agent"}` rejects old suggested agent items in the same journal transaction, only those of the planned `--label`; it applies even when the new plan finds nothing. Shared room voices remain unresolved; `askRoom:{minSec:8,max:6}` makes bounded questions. Each such question decides a speaker-range in the same batch, and that range has no speaker until the question is answered. The shipped `meetings-attribute-by-mic` preset is a worked example. CLI calls without `--dry-run` apply; REPL calls default to a dry run.

A known manual annotation stays separate from channel inference. Supply it through `meeting.items.add({findings:[{kind:"speaker-range",from:60,to:62,label:"Room",speaker:"Alice",confidence:0.7,reason:"Manual annotation: confirmed screen or listening evidence"}]})`, or `items add --from-file`. Keep its actual provenance in `reason`. Do not describe manual ranges as inferred from microphone share.

`tools meetings reject <meeting> --kind speaker-range --where 'confidence<0.6'` selects suggested items with a numeric confidence/priority comparison. It does not evaluate JavaScript. `tools meetings evidence <meeting> --table --from 60 --to 120` and `meeting.evidence({table:true,from:60,to:120})` return bounded per-line evidence. When a line refers to the screen, read `screen --at` before attributing the idea.

`listen --subscribe-answers --follow` keeps following empty rounds until its deadline. Rejected questions emit `questions-rejected` and a subscriber `round-ended` event. Existing `round-end` log events remain supported. Deadline exit 2 prints an explicit timeout diagnostic on stderr.
