# Token efficiency: the cheap door of each step

Read this before you read a large meetings output or start a pass-2 agent. A pass costs what it reads: every model
call reads the whole context again, so a big output read early is paid again on every later call. The judgement
itself is cheap.

The sizes come from one 986-line call of 2 h 16 min, measured on 2026-11-25. The agent figures come from the token
measurement of the same day. Every command and REPL call named here exists; `tools meetings schema <output>` prints the
keys of its JSON.

## Three-pass, door by door

1. **Seats.** `tools meetings seats <m> --json` is 1.3 KB; the box table is 5.1 KB.
   REPL: `meetings.seats({ meeting })`.
2. **Voices.** `tools meetings voices preview <m> --json` is 260 KB for 985 lines. Read it in a script and keep only
   the fields you need, or use `--format tsv` (one row per line). In a pipe the default is JSON. REPL:
   `meetings.voices.preview({ meeting })`. `voices apply` and `suggest` print the indicator gaps as one summary line;
   `--verbose` lists them.
3. **Facts and the line table.** `tools meetings pack <m> --out <dir>` (a new or empty folder) writes `facts.md`
   (about 2 KB) and `lines-<n>.tsv` chunks of about 25,000 characters, each cut at a change of label and each starting
   with the legend. REPL: `meeting.pack({ out })`. `facts.md` holds the seats, each person's stays with their source,
   the output device, the absent people, the legend and the lines per label. The table of the 986-line call is
   106 KB, 82 KB of it the full text, in 4 chunks. For one stretch, use
   `evidence <m> --format tsv --with-voices --from <seconds> --to <seconds>` (REPL: `meeting.lineTable({ ... })`), or
   `look <m> --from <t> --to <t> --json` (31 KB a minute). Do not read `evidence --json` (1.2 MB) or `show --json`
   (182 KB) into a context. `evidence --format lines` (75 KB) cuts each text at 48 characters, which is too short to
   judge a speaker. The table joins the voice verdict by line index, never by time: two lines can start in the same
   second.
4. **The keys of a JSON output.** `tools meetings schema <output>` prints the declared types (3,223 characters for
   evidence; `--format json-schema` for a validator). REPL: `meetings.schema({ name })`. Do not run
   `tools json schema` on an output: it infers 3,500 characters with false unions such as `number | number`. Trial
   reads with `Object.keys` cost 5 model calls in the measured pass.
5. **Pass 2, the speakers.** Give one Sonnet agent the pack directory and the brief below. Sonnet with a 19 KB table
   made 4 model calls (peak context 124k) and named the same person as an Opus three-pass on 209 of 221 lines
   (94.6 %). An Opus agent with a 144 KB hand-built table made 19 model calls with a peak of 234k.
6. **Findings from the decisions.** `tools meetings items from-decisions <m> --file <decisions.json> --plan`, then the
   same command without `--plan`. REPL: `meeting.items.fromDecisions({ decisions, dryRun })`. It drops the lines whose
   label is right, joins runs into ranges and gives a same-second line its index. An unknown speaker name stops the
   whole batch and lists the known people. Send the terms in one `items add --from-file` batch too.
7. **Pass 3 and the finish.** `tools meetings items <m> --format tsv` (the default in a pipe) is 77.5 KB for 855 items;
   `items --json` is 1.7 MB and the box table 567 KB. Filter with `--kind` and `--status`, or call
   `meeting.items.list({ kind, status })`. `rows --json` is 3.3 MB: filter it in a script.

## Automatic, door by door

1. `tools meetings duplicate <m> --without-items --json` makes the comparison copy.
2. Seats and voices are steps 1 and 2 above.
3. `tools meetings suggest <m> --attendance teams` takes about 12 s and no model tokens. It prints its indicator gaps
   as one summary line.
4. Review the items with `items <m> --format tsv`: the 996 items of the automatic copy are 97.2 KB, against 623 KB as
   `--json` and 660 KB as the box table.
5. Do not trust the result unread. It named the same person as the three-pass on 153 of 221 test lines (69.2 %) and
   left 233 lines open. Read the open lines with the pass-2 brief.

## The pass-2 agent brief

A parent sends this as the whole prompt and fills the angle brackets. An agent that gets only this file and a pack
follows it as written. The example names are invented.

```text
Pass-2 speaker judgement for meeting <m>.
- Input: the pack in <dir>. Read facts.md, then each lines-<n>.tsv once, in order. Open no other file.
- Context the record does not hold (optional): <roles, language habits, who did what before the call>.
  Example: "Bob runs the call and asks what is missing. Carol answers in Slovak forms."
- facts.md names the seats, the stays, the output device and the absent people. Never name an absent person.
- Columns: idx, t, label, mic (0..100, empty = unknown), spk (shown speaking by the platform), voice (best voice and
  score, ? = the voice pass named nobody, - = no voice reading), next (the runner-up voice), text. The "# legend" line
  maps each initial to a person and a seat.
- Decide each line from its content first: who answers whom, a name in the vocative. Then mic: under 10 means remote.
  Then voice. Use spk last: it lags and has gaps.
- When the room's device plays the call through its speakers, remote voices reach the microphone too. A high mic then
  does not prove that the room spoke.
- Keep the decisions in one REPL variable keyed by idx. Store the decisions of a chunk in the same script that reads
  the next chunk. Write the file once, with one write() at the end. Never print the table back.
- Output <dir>/decisions.json: [{"idx":0,"speaker":"Alice","confidence":0.8,"reason":"answers Bob"}, ...] for EVERY
  line, also the lines whose label is right. speaker is a name from the legend, or "?" when you cannot decide. Reuse
  one reason for a run of lines that you decided the same way: consecutive lines of one label with one speaker and one
  reason become one range.
- Return three lines: the path, how many lines differ from their label, and how many model calls you made.
```

## Code mode: what agents get wrong

- Keep the per-line decisions in one REPL variable and write them once. The measured Opus agent held its table to the
  end and grouped the ranges in its own scripts. That grouping is the job of `items from-decisions`.
- After a script ends, the `.then` of its last unawaited call cannot make a tool call. `write()` rejects, and `$`
  exits 1 with the reason only in `.error`, silently when nothing catches it. Await every write inside the script, and
  let a `.then` only set a variable.
- Read `--json` and `schema`, never text output. A regex on the text of `voices preview` matched 496 of
  986 lines, because one-digit hours broke it, and it swapped two same-second lines. That cost 3 extra model calls.
- The `tool_uses` of a task notification counts the shell calls inside REPL scripts. The Opus agent showed 617 tool
  uses for 19 model calls. Count the model calls before you call an agent a runaway.
- Give an agent the pack directory (or the table of step 3), not the raw evidence. A 144 KB table that the agent held
  to the end gave a peak of 234k.
