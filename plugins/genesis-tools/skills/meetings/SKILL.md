---
name: meetings
description: Polish a recorded meeting (Wispr Flow, Spellar, Teams) into one trustworthy file - fix misheard terms and code identifiers, re-attribute wrong speaker labels with scored rules, check the source's own summary against the transcript, and log every change as a diff. Use for "polish the transcript", "fix the meeting notes", "who said this in the meeting", "wrong speaker in Wispr", "build a glossary for the meeting", "export and clean the meeting", or any meeting export under a vault `meetings/` folder.
---

# Meetings: export, polish, attribute

A transcript from speech recognition is evidence with known defects: jargon becomes near-misses, a code path is spoken as
words, one speaker label covers several people, and the source's own summary claims decisions nobody made. This skill
turns one meeting into ONE polished file that a developer can trust, and keeps every change checkable.

The tools do the mechanics (`tools meetings`, with `tools wisprflow` for the export); `src/meetings/README.md` lists
every command. The judgement lives here.

## Two modes

- **Three-pass, the default when an agent runs this skill.** The tool gathers the facts and judges nothing; the agent
  judges them with the meeting's context; the user answers by ear only what the agent cannot settle; the agent
  finishes with the answers.
- **Automatic, for a run without an agent or as a second opinion.** `tools meetings suggest <meeting>` scores the
  speakers and the terms with the rules and the word check, writes suggestion items, and picks the listen questions
  itself. The agent then only reviews the items and answers what `listen` left open.

Both modes share the meeting record, its items and `tools meetings listen`.

For an isolated store, prefix **every command** with the same `GENESIS_TOOLS_HOME`, including reads, playback and the
answer subscription. For example, `GENESIS_TOOLS_HOME=/path/to/isolated/home tools meetings show <meeting> --json`.

## Procedure (three-pass)

1. **Export raw, never edit it.** `tools wisprflow meetings export <id> --dir <topic>/meetings/<date>-wisprflow
   --timestamps`. The raw `Transcript.md`, `Summary.md` and `meeting.json` stay next to the
   polished file. Details: [wisprflow.md](references/wisprflow.md).
2. **Pass 1, collect the facts.** Create or link the record with
   `tools meetings new --source wisprflow:<id> --project <name>`. For an existing record, check its project and set
   it with `tools meetings set <meeting> --project <name>`. Confirm each person's join and leave window from
   `evidence --raw` before pass 2. Unknown indicator intervals are missing evidence.
   The record links the transcript, people, calendar entry, attendance and platform sections. `tools meetings
   evidence <meeting> --raw` prints the facts per line (label and its origin, text, microphone share, the people shown
   speaking or muted, who was present) and, for the terms, the vocabulary, the runs that sound like a vocabulary term
   and the words no layer of the word check knows, each with its verdict. The check uses each language's configured
   provider unless you pass `--word-check`. The `terms.documents` field lists each passage that reads a document line aloud
   (`readAloud`: the heard words, the line and its text) and each spoken path or identifier (`identifiers`). It has
   no rule weights and no confidence.
   Every timed line has `channel.micShare`, `null` when unknown. `meeting.labels` includes first own indicator/join
   and early-label counts; `meeting.indicatorGaps` names long missing observations. Indicator-only people have origin
   `indicator`. `--format lines` gives a compact legend and 48-character text prefixes with mic %, energy, speaking
   and muted names; read raw JSON for the full text. `localSpeechOutput` identifies matching local audible speech.
   For one stretch, `tools meetings look <meeting> --from 23:50 --to 25:00 --json` or `meetings.look({ meeting, from: "23:50", to: "25:00" })` returns its lines, speaker evidence, attendance, open questions, items and screen text changes. Both bounds are inclusive.
   Pull the documents the meeting discussed (read-only). Save the version the meeting read with
   `tools meetings context add <meeting> <file> --before-meeting`, or choose a known commit with `--rev <sha>`.
   The first flag uses the meeting start, not its end. Both save the chosen text and full commit inside the record;
   later file changes, deletion and duplication retain it. Check `evidence <meeting> --raw` for the expected
   `terms.documents.readAloud` and `terms.documents.identifiers`. Without either flag, the ordinary file-reference
   fallback still applies. Check the project dictionary with `tools meetings dictionary show --project <p>`.
   Ask the user about missing roles, aliases and uncertain join or leave times. Keep unknown roles open.

   **Seats and voices. Strongly recommended before pass 2.**

   - Run `tools meetings seats <meeting>` or `await meetings.seats({ meeting })` and read the reasons. Someone listed in the call may have sat in the room.
     Run `tools meetings seats <meeting> --apply` or `await meetings.applySeats({ meeting })` to save the suggestion when seats are missing. Ask where anyone
     marked unsure sat. Use `--room` and `--remote` for corrections. Use `--replace` to change saved seats.
   - Check the top-level `voice` in `tools meetings evidence <meeting> --raw` or `tools meetings show <meeting> --json`, or call `await meetings.voiceReadiness({ meeting })`.
     `people` counts project samples per attendee. `ready` means seats are set and each occupied side of the recording
     has samples from at least one person on that side. Without seats or usable samples, voice naming is off and
     people in the room or on the call can stay unnamed.
   - Run `tools meetings voices backfill --project <p>` or `await meetings.backfillVoices({ project })` to recover samples from earlier speaker answers and names
     proposed by voice that a person confirmed individually. To select meetings directly, pass their IDs in place of
     `--project <p>`. Backfill can recover a line before seats are set, using the line's mic share. Add `--dry-run`
     to see counts per meeting and person. The matching REPL call is `await meetings.backfillVoices({ meetings: [meeting], dryRun: true })`. Repeating the command counts existing samples separately.
   - Run `tools meetings voices preview <meeting>`. Check proposed names, times and refusals. The pass can also
     use certain lines from this meeting as temporary samples. It excludes the line it is scoring. A person without
     a sample can still be proposed if they are the only such person present on that seat, the voice clearly matches
     none of the enrolled seat-mates, and the lines sound like one speaker. Check that suggestion by ear.
     Run `tools meetings voices apply <meeting>` to save the speaker suggestions for review.

3. **Pass 2, the agent judges.**
   First run `meeting.items.byChannel({ label, dryRun: true })` with the stored seats, or `tools meetings items by-channel <meeting> --label <label> --dry-run`. Inspect the plan before applying with `dryRun: false`. The shipped `meetings-attribute-by-mic` REPL preset takes meeting, label, room, remote and dryRun parameters. When a line refers to something on the screen, read `screen --at` before attributing the idea.
   Attribute speakers with [speakers.md](references/speakers.md), then build the glossary and fix terms with [polishing.md](references/polishing.md). Settle
   what the context settles, and store every finding in the record with its confidence and the facts it rests on, all
   in one `tools meetings items add <meeting> --from-file <json>` call: an array of objects named like the flags
   (`tools meetings items add --help`). Before insertion, inspect the batch with
   `tools meetings items add <meeting> --from-file <json> --plan`: it previews each finding independently, naming
   zero-based line indices and each line's first eight words. Planning requires a local transcript, never falls back
   to a remote source, and writes nothing. A retry of the same batch retains equal open findings and reports their
   IDs; question refs still resolve to retained IDs. Use `--allow-duplicates` only for an intentional second copy.
   The REPL equivalent is `meeting.items.add({ findings, allowDuplicates: true })`; ordinary calls return retained
   IDs in `duplicates`. The kinds:
   - `speaker-range`: `from`, `to`, `label`, `speaker`. `to` is the START time of the last line of the range, as
     `evidence --raw` prints it: a range takes every line of its label that starts inside it, so the end time of the
     last line can pull in the next line of the same label.
   - `term`: `at`, `heard`, then one of `proposed` (the right spelling), `meaning` (a spoken path: the identifier shown
     after the heard words, D1; write it without backticks, the transcript adds them) or `quote` (`{ "text": "<the part of the document line that was read>", "source":
     "čte z <document>, ř. <line>" }`, D8). `proposed` fixes the words wherever they are heard; add `"scope": "line"`
     when the same words are right elsewhere. Put the words that agree with the fix into `heard` too ("nějakej
     implementátor" becomes "nějaká implementace"), or the fixed sentence breaks its grammar. A real word the word
     check flags needs no item: note it for the glossary of step 6 as `keep`.
   - A stem `term` may supply `heardStem` and `proposedStem` together. Recognized Czech endings are preserved across
     occurrences; `scope: "line"` still limits its reach. CLI: `--heard-stem` and `--proposed-stem`.
   - `removal`: `from`, `to`, `heard`, confidence and reason. Confirmed local speech findings hide the matching line
     only in the corrected view. Raw source text and the read-only speech history stay intact.
   - `join`: `at` (the start of the line after the cut) and `joined`. The first word of the line after the cut moves
     to the end of the line before it. For a cut word, `joined` is the whole word ("dotáhnu") and the parts are glued;
     for a sentence cut between two whole words, `joined` has a space ("jsem zvědavej") and the space stays. `label` is
     a source label: the joined line takes the voice that the ranges give to that label at that time. Leave it out to
     use the label of the line after the cut.
   - `label` with `"meaningless": true`: `from`, `to`, `label`, `reason`. The label does not track one person in this
     stretch (diarization put several voices under it, so its name says nothing there). Its lines there count as
     unlabeled: the rules take no hint from the label, and the transcript marks each line no range or join gives a
     voice as `[nejasné: "<label>"]`. One such finding replaces a range per line for the lines you cannot attribute;
     keep a `speaker-range` for each line you can.
   - Two lines can start in the same second. `items add` then warns and names both lines by index; reject
     that item and add the finding again with `"line": <index>`, or it does not apply.
   - Store only re-attributions: a line that stays with its own label needs no range. Group consecutive lines of one
     label that go to the same person on the same evidence into one range, with the lowest confidence of its lines;
     start a new range where the evidence changes.
   - `question` (for a line or a word that stays under 60 % and matters, within the question budget in speakers.md):
     `from`, `to`, `about` (`speaker` or `term`), `question`, `choices`, `heard` for a term, and `decides`. Give each
     finding the question settles a `ref` (a short name such as `"r-14"`) and list the refs in `decides`; the tool
     turns them into the new item ids, so the user's answer confirms or rejects those findings. Write the question in
     the user's language, and `choices` as a JSON array (the `--choices` flag splits at commas).

   The transcript applies the findings in this order: joins, ranges, open speaker marks, renames, quotes and meanings,
   term fixes, the project dictionary, then open words. So a quote or a meaning protects its words from the later
   fixes, and a term fix wins over a dictionary entry for the same words: when the dictionary gives the wrong
   grammatical case on one line ("UVČ" becomes "UIčko" after a genitive), store a `"scope": "line"` term fix with the
   right form ("UIčka"). `items add` and `transcript` print each item that did not apply and why (`i42 did not apply:
   no "X" at 37:43`); fix that finding instead of ignoring the warning.

   Check every `readAloud` and `identifiers` fact against the transcript before you store it: the line number can be
   off, and a match can be a false one. A context document can be newer than the meeting and already hold its
   outcomes: read the version from before the meeting (`git log --before=<meeting start> -1 -- <path>`, then `git show
   <sha>:<path>`), and use a later version for spelling only, never for who said what.
4. **Pass 3, the user listens.** Give the user `tools meetings listen <meeting>`: it shows one question, plays its clip
   with a tone before the asked words, and waits for the answer; Esc goes back one step and undoes only what the
   previous answer changed, so your own `items add` during the round stays. Use `tools meetings listen <meeting> --item <Q12|id>`
   to ask one question. Find its number in the `Q` column of `tools meetings items <meeting>`. Listen reuses a
   person's answer when it covers every line, including answers on the source meeting of a copy. It asks about
   conflicting answers, partial coverage and lines the user has yet to decide. Use `--ask-known` to hear known
   questions again. Spot-check results report the reused and newly asked answers separately. To relay an answer the
   user gives in chat: `tools meetings listen <meeting> --item Q12 --answer "<text>"`. At the same time run `tools meetings listen <meeting> --subscribe-answers` under your Monitor tool (or as a
   background command): it prints each answer as one JSON line the moment it is given and exits when the round ends,
   so you act on each answer while the user is still listening. Do not poll the record. When the user reviews in the
   Meetings window, add `--with-comments --follow`: the comments the user sends from a transcript selection arrive on
   the same stream (`"type": "comment"`, with the text, the selected words and the transcript `target`; answer lines
   then carry `"type": "answer"`), and the window names you as the listener while the command runs. Read each comment
   after acknowledging it with `tools meetings comments read <meeting> <id>`. If the user withdrew it first, skip it.
   `tools meetings rows <meeting> --json` shows the questions as the window does.
5. **The agent finishes.** Take the answers from the subscription (or `tools meetings items <meeting> --kind
   question`) and carry each one to the other lines with the same evidence. Ask what is still open in rounds (the `grilling` style): numbered questions
   with concrete quotes and timestamps, one recommendation each. Never settle a person's identity or a business term
   by guessing. `transcript` applies suggested findings only with `--with-suggested`; use that flag to preview
   unsettled findings. An open speaker question keeps its proposed voice as `[Name: NN %]` at every confidence.
   Without the flag, choices carry no borrowed range confidence. A complete supplied unclear term mark is rendered
   once. Confirm the findings settled by evidence or the user's answers with `tools meetings confirm <meeting>
   <settled-item-ids>` before writing the polished file; keep unresolved findings open and visibly marked.
6. **Write the one polished file** in the layout of [polishing.md](references/polishing.md#the-polished-file), then
   correct the source's summary against the polished transcript.
7. **Report**: the file link, the count of changes per kind, the `[nejasné: ...]` count, and every decision that
   contradicts the documents.

## Procedure (automatic)

1. Export raw (step 1 above) and `tools meetings new --source wisprflow:<id>`. For an independent automatic
   comparison of an existing meeting, run
   `tools meetings duplicate <original> --title "Automatic comparison" --without-items --json`, then use its
   returned id for the remaining steps. The copy retains sources, context, frames and sound, but starts with zero
   items and an empty decision journal; do not edit meeting.json by hand. `--no-items` is an alias. Copies inherit
   the original project and do not ask for project assignment again. A normal duplicate retains items and copied
   journal tokens with `copiedFrom`; its Undo changes only the copy. An older journal naming another meeting is
   refused: use a clean copy or resolve that incompatibility explicitly before Undo.
2. Follow the seats and voices steps above, then run `tools meetings suggest <meeting> --attendance teams`. The meeting needs its project first: without one, `suggest`
   exits 1 with the `tools meetings set <meeting> --project <name>` command (a terminal shows the project picker
   instead). Attendance uses the linked source's title and
   transcript clock, including for a renamed copy. Unavailable platform attendance warns, skips E2 and saves the
   other suggestions. If several Teams chats match, the warning shows the first three by last cached call.
   Each includes the full ID, chat participant count and command to inspect attendance. Select a known chat with `--attendance-id <threadId>`,
   or `meeting.items.suggest({ attendance: 'teams', attendanceId: '<threadId>' })` in the REPL. Invalid input and
   unreadable or malformed attendance files still fail. The term rules use each language's configured word check.
   Use `--word-check` to override it for this run. Hunspell dictionaries download on first use.
3. `tools meetings listen <meeting>` for the user, with `--subscribe-answers` for you as in step 4 above, then review
   the items (`tools meetings items <meeting>`) and decide each one
   with `tools meetings confirm <meeting> <items>` or `tools meetings reject <meeting> <items>`.
4. Continue with steps 5 to 7 above.

## Hard rules

- Read the WHOLE transcript. A sample misses a speaker who left halfway through.
- Keep the speaker's language, order and turns. Correct terms, names, identifiers and mishearings; do not rewrite style,
  shorten or add content. Keep the original wording and add the meaning next to it (see the marker rule).
- An unresolvable passage is `[nejasné: <raw text>]`. A guessed speaker is `[<name>: NN %]`.
- A name from the source's language model is a guess, not a fact (`origin: "llm"` in Wispr's `meeting.json`), and
  the label with the user's name is never "all of the user": check the microphone channel.
- A worked example with confirmed answers lives in the user's notes vault, because it holds real names. Never commit
  real names, quotes or client data to this repository. Use the example to check a result, not as a shortcut, and never
  give it to a worker you are testing the skill with.
- The tooling never calls a language model. You, the agent running this skill, propose a correction of a misheard
  word from its context and the project's dictionary, and record it with `items add` or as an answer; the user
  confirms the repeated ones through the word questions, the most heard first. The user chooses whether to add
  a confirmed spelling to the dictionary.
- Never write to the source app, ADO, Teams or the vault's git. The user commits the vault.
- Every change is visible in a `diff` block, with `//` lines that give the rule and the score.

## Listening quality and voice evidence

`transcript <meeting> --with-suggested --apply-above 70` keeps lower-confidence voices as percentage marks.
`transcript <meeting> --probe-thresholds 50,60,70,80` compares applied and open counts without changing the record.
With `--with-suggested`, proposed terms apply at 70% confidence by default (`term.applyAbove`).
Term and speaker thresholds are global settings in Settings → Meetings. Open Thresholds from a meeting to preview
which proposals change there before saving a setting for all meetings. In the CLI, `tools meetings thresholds <meeting>`
lists the names and current values, as does `await meetings.thresholds({ meeting })`. Run `tools meetings thresholds <meeting> --set <name>=<value> --preview` or `await meetings.thresholds({ meeting, set: { [name]: value }, preview: true })` to
see the changed lines, then omit `--preview` to save the value.

`listen <meeting> --spot-check 20` samples the 50 to 69 percent band without replacement. Comments leave questions
open. `listen --long-stretch-words 50` prepares the long-stretch group; `--group rules|spot-check|long-stretch|words|all`
selects a group. Long stretches split on channel voice-feature changes before naming. The group is retained in rows
JSON. A sample result measures the share changed among answered sample lines, not a known meeting error rate.

`listen --group words` asks the repeated unknown words: one question per word form heard
`global.suggest.words.minOccurrences` times or more (default 2), the most heard first, outside the question budget
and unmarked in the transcript. One answer fixes every place the form is heard (an answer equal to the heard word
keeps it as heard), and the open word questions whose heard word starts with it get the derived spelling as first
choice. The dictionary is never changed silently: a terminal asks yes or no at once (Enter is no); every other door
leaves one dictionary question (`add` or `do not add`) in the same group for the user. `--answer … --learn add`
writes the entry with the answer and `--learn none` keeps it out; an agent may not answer `add`, so relay the user's
own yes. The Undo of the answer (`reopen --token`) takes the entry back while it is unchanged.

Several voices takes ordered people. A confirmed line can keep word-indexed segments and render separate turns.
Unmatched prose remains a comment. The people picker matches accents and name order. Playback pauses while typing;
space pauses and resumes with choices focused. The progress bar marks the asked span and tone.

`listen <meeting> --enrol-voices` explicitly uses an already installed model, calibrated channels and canonical remote
seats. Enrolment uses isolated-call solo windows or confirmed lines and excludes each scored line's own window.
Cosine and margin are evidence, not probabilities. Missing models, quiet audio, incompatible embeddings and ambiguous
scores remain unknown. Ordinary reads never provision models. Preserve raw microphone, isolated call and optional
estimated-clean tracks separately.

`voices [--project <p>]` lists each person's samples (meeting, seat, track, time, words); `voices play <person>
[--sample <n>]` plays one. `voices preview <meeting>` prints the lines the voice labeler would name, with scores and
refusal reasons. A preview can cache line embeddings. `voices apply <meeting>` saves the names as suggestions.
`voices remove <person> [--sample <n>]` retires that person's voice-named suggestions first. `play <meeting> --track
<track>` plays one track; `show` lists the tracks. The first voice pass of a meeting embeds every line once and caches
it (172 minutes: about 90 s at normal priority); later passes read the cache in about half a second. Its priority and
worker count are `global.speakerLabels.voice.compute` (`priority: normal` by default, `workers: auto` takes the free
performance cores, at most four).

Set `global.capture.recorders.native.audio.mode` to `session` for continuous sound in 60-second files; the default
`pieces` records the sound inside the screen pieces, with up to 5 seconds missing every 30 seconds, and `record status`
explains a fall back.
