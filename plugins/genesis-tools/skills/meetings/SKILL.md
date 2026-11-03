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

## Procedure (three-pass)

1. **Export raw, never edit it.** `tools wisprflow meetings export <id> --dir <topic>/meetings/<date>-wisprflow
   --timestamps`, without `--fix-term`. The raw `Transcript.md`, `Summary.md` and `meeting.json` stay next to the
   polished file. Details: [wisprflow.md](references/wisprflow.md).
2. **Pass 1, the tool collects the facts.** `tools meetings new --source wisprflow:<id>` builds the meeting record
   (transcript, people, calendar entry, attendance and `sections[]` from the meeting platform). `tools meetings
   evidence <meeting> --raw` prints the facts per line (label and its origin, text, microphone share, the people shown
   speaking or muted, who was present) and, for the terms, the vocabulary, the runs that sound like a vocabulary term
   and the words no layer of the word check knows, each with its verdict (`--word-check hunspell` by default). Its
   `terms.documents` lists, for the meeting's context documents, each passage that reads a document line aloud
   (`readAloud`: the heard words, the line and its text) and each spoken path or identifier (`identifiers`). It has
   no rule weights and no confidence.
   Pull the documents the meeting discussed (read-only) and check the project dictionary (`tools meetings dictionary
   show`). **Ask the user for each person's role** before you judge anything.
3. **Pass 2, the agent judges.** Attribute speakers with [speakers.md](references/speakers.md) first (a term fix often
   depends on who spoke), then build the glossary and fix terms with [polishing.md](references/polishing.md). Settle
   what the context settles, and store every finding in the record with its confidence and the facts it rests on, all
   in one `tools meetings items add <meeting> --from-file <json>` call: an array of objects named like the flags
   (`tools meetings items add --help`). The kinds:
   - `speaker-range`: `from`, `to`, `label`, `speaker`. `to` is the START time of the last line of the range, as
     `evidence --raw` prints it: a range takes every line of its label that starts inside it, so the end time of the
     last line can pull in the next line of the same label.
   - `term`: `at`, `heard`, then one of `proposed` (the right spelling), `meaning` (a spoken path: the identifier shown
     after the heard words, D1) or `quote` (`{ "text": "<the part of the document line that was read>", "source":
     "čte z <document>, ř. <line>" }`, D8). `proposed` fixes the words wherever they are heard; add `"scope": "line"`
     when the same words are right elsewhere. Put the words that agree with the fix into `heard` too ("nějakej
     implementátor" becomes "nějaká implementace"), or the fixed sentence breaks its grammar. A real word the word
     check flags needs no item: note it for the glossary of step 6 as `keep`.
   - `join`: `at` (the start of the line after the cut) and `joined`. The first word of the line after the cut moves
     to the end of the line before it. For a cut word, `joined` is the whole word ("dotáhnu") and the parts are glued;
     for a sentence cut between two whole words, `joined` has a space ("jsem zvědavej") and the space stays. `label` is
     a source label: the joined line takes the voice that the ranges give to that label at that time. Leave it out to
     use the label of the line after the cut.
   - Store only re-attributions: a line that stays with its own label needs no range. Group consecutive lines of one
     label that go to the same person on the same evidence into one range, with the lowest confidence of its lines;
     start a new range where the evidence changes.
   - `question` (for a line or a word that stays under 60 % and matters, within the question budget in speakers.md):
     `from`, `to`, `about` (`speaker` or `term`), `question`, `choices`, `heard` for a term, and `decides`. Give each
     finding the question settles a `ref` (a short name such as `"r-14"`) and list the refs in `decides`; the tool
     turns them into the new item ids, so the user's answer confirms or rejects those findings. Write the question in
     the user's language, and `choices` as a JSON array (the `--choices` flag splits at commas).

   The transcript applies the findings in this order: joins, ranges, quotes and meanings, term fixes, then the project
   dictionary. So a quote or a meaning protects its words from the later fixes, and a term fix wins over a dictionary
   entry for the same words: when the dictionary gives the wrong grammatical case on one line ("UVČ" becomes "UIčko"
   after a genitive), store a `"scope": "line"` term fix with the right form ("UIčka").

   Check every `readAloud` and `identifiers` fact against the transcript before you store it: the line number can be
   off, and a match can be a false one. A context document can be newer than the meeting and already hold its
   outcomes: read the version from before the meeting (`git log --before=<meeting start> -1 -- <path>`, then `git show
   <sha>:<path>`), and use a later version for spelling only, never for who said what.
4. **Pass 3, the user listens.** Give the user `tools meetings listen <meeting>`: it shows one question, plays its clip
   with a tone before the asked words, and waits for the answer; Esc goes back one step and undoes only what the
   previous answer changed, so your own `items add` during the round stays. Name a question by its number, `Q12`, in
   `listen --item`, `confirm` and `reject`; `tools meetings items` shows it in the `Q` column. To relay an answer the
   user gives in chat: `tools meetings listen <meeting> --item Q12 --answer "<text>"`. At the same time run `tools meetings listen <meeting> --subscribe-answers` under your Monitor tool (or as a
   background command): it prints each answer as one JSON line the moment it is given and exits when the round ends,
   so you act on each answer while the user is still listening. Do not poll the record.
5. **The agent finishes.** Take the answers from the subscription (or `tools meetings items <meeting> --kind
   question`) and carry each one to the other lines with the same evidence. Ask what is still open in rounds (the `grilling` style): numbered questions
   with concrete quotes and timestamps, one recommendation each. Never settle a person's identity or a business term
   by guessing.
6. **Write the one polished file** in the layout of [polishing.md](references/polishing.md#the-polished-file), then
   correct the source's summary against the polished transcript.
7. **Report**: the file link, the count of changes per kind, the `[nejasné: ...]` count, and every decision that
   contradicts the documents.

## Procedure (automatic)

1. Export raw (step 1 above) and `tools meetings new --source wisprflow:<id>`.
2. `tools meetings suggest <meeting> --attendance teams`. The term rules use the word check (`--word-check hunspell`,
   the default; `hunspell-cc0`, `macos` or `off`). Its dictionaries download on first use.
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
- Never write to the source app, ADO, Teams or the vault's git. The user commits the vault.
- Every change is visible in a `diff` block, with `//` lines that give the rule and the score.
