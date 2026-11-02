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
   and the words no layer of the word check knows, each with its verdict (`--word-check hunspell` by default). It has
   no rule weights and no confidence.
   Pull the documents the meeting discussed (read-only) and check the project dictionary (`tools meetings dictionary
   show`). **Ask the user for each person's role** before you judge anything.
3. **Pass 2, the agent judges.** Attribute speakers with [speakers.md](references/speakers.md) first (a term fix often
   depends on who spoke), then build the glossary and fix terms with [polishing.md](references/polishing.md). Settle
   what the context settles, and store every finding in the record with its confidence and the facts it rests on:
   `tools meetings items add <meeting> --kind speaker-range --from <time> --to <time> --label <label> --speaker <name>
   --confidence 0.85 --reason "<text>"`, or `--kind term --at <time> --heard <words> [--proposed <spelling>]`. Write
   many in one call with `--from-file <json>` (an array of objects named like the flags). For a line or a word that
   stays under 60 % and matters, add a listen question: `tools meetings items add <meeting> --kind question --from
   <time> --to <time> --about speaker|term --question "<text>" --choices <list>`, within the question budget in
   speakers.md.
4. **Pass 3, the user listens.** Give the user `tools meetings listen <meeting>`: it shows one question, plays its clip
   with a tone before the asked words, and waits for the answer; Esc goes back one step and undoes the previous
   answer. At the same time run `tools meetings listen <meeting> --subscribe-answers` under your Monitor tool (or as a
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

- Read the WHOLE transcript. A sample misses the speaker who left at minute 37.
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
