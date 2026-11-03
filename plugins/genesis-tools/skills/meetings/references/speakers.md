# Speaker attribution

Status 2026-11-02 20:15. The user reviewed the content rules: R1, R2, R3, R6 and R10 are confirmed, R7 is narrowed,
R4, R5, R8 and R9 are rewritten after the user's questions. The evidence tiers E1 to E4 are new, measured on one
meeting. Show a re-attribution as a suggestion until the user confirms the rule set.

A worked example with every number exists for a real client meeting. It holds real names, so it lives in the user's
notes vault, not in this repository; ask the user for its path. Read it after this page, not instead of it.

## Why labels are wrong

Diarization groups audio into speaker numbers, and the source names each number afterwards. In Wispr Flow's
`meeting.json` every participant has an `origin`: `platform` (Teams named it), `llm` (Wispr's model guessed it) or
`self`. A guessed label is a hypothesis, and one label can hold several voices, including the user's own.

The most expensive mistake: treating the label that carries the user's name as "all of the user". In a measured
meeting the user's microphone recorded four times the words of the user's label; most of the user's speech sat under
other people's labels.

## Evidence tiers: physical facts first

**The tool collects the hard data; the agent does not parse raw files.** Start with `tools meetings new --source
wisprflow:<id>` (or `link`): the record, with the transcript, the people, the calendar entry, and the attendance and
`sections[]` from the meeting platform. Then, by mode (SKILL.md):

- **Three-pass (default):** `tools meetings evidence <meeting> --raw` gives the facts per line with no weights. Apply
  the tiers below and the content rules yourself, and store each finding with `tools meetings items add --kind
  speaker-range ... --confidence <0..1> --reason "<the tiers and rules it rests on>"`. Store every line you can
  attribute, interjections too ("Hm." under the label of a person who has left): they render with the right name.
  Only the questions skip them.
- **Automatic:** `tools meetings suggest <meeting> --rules evidence --attendance <platform>` applies the tiers and
  writes scored suggestion items. `tools meetings evidence <meeting>` shows why an item scored as it did.

In both modes the agent's work is the lines the tiers leave under 80 %, the content rules below, and the questions for
the user. Parse a raw file yourself only when the tool cannot read it yet, and then report the gap to the tool's owner.

The meeting platform is a provider, not a fixed source. Teams is one (attendance from the Teams client log, the speaking
indicator from Wispr's observations); FaceTime or another platform plugs in with what it can supply. A tier that the
platform cannot supply is skipped, never guessed.

| Tier | Weight | Supplied by | What it decides |
|---|---|---|---|
| E1 channel | 10 | The recorder: Wispr's live segments tagged `mic` or `system`. The recording's own channels count only after the tool has calibrated, for that recording, which channel (if any) carries the microphone; a mono file, another recorder or an unclear calibration gives no energy evidence. Never assume a channel layout. | The user's confidence comes from the energy table below, not from the formula. Echo (similar text on both channels at once) or loud speakers at the same moment lower it. |
| E2 attendance | 6 | The platform provider: join and leave times, one row per join, so a person who comes back is attributable again. | A person who was not in the call did not speak. When one person is left, that person spoke. 5 s tolerance. |
| E3 speaking indicator | 5 | The platform provider (for Teams: Wispr's observations of the call window). | Narrows the remote candidates to the people shown as speaking during the line. Also a negative signal: a person shown as **muted** during the line did not speak it (RM). The user is usually never shown as speaking, so E3 never counts against the user. An indicator that shows one person on most lines of the meeting (a pinned or stuck tile) is no evidence for that person: use it only where it changes. A person missing from the indicator is never evidence against that person. |
| E4 live names | 2 | The recorder's live segments. | A weak hint. The name belongs to a live voice, not a person; at the start of a meeting and after a person leaves it is often stale. Drop it when E2 or E3 contradicts it. |

The tool applies three of these limits itself (`suggest`): a call channel silent for 5 min or more while two labels
talk makes E1 say nothing there (R19 lets the microphone's own label stand for the user at 0.5); a platform-named label
with a quarter of the sure microphone lines and call lines of its own is a second person in the room (R18: candidates
at 0.4, the user capped at 0.7 and only on sure microphone lines); and E3 stuck on one remote person for 6 min with a third of the lines on the
microphone is ignored there. Read the rules in an item before you trust an E1 range.

### E1 energy table

`energyMicShare` in `evidence --raw` is the share of the line's energy on the microphone. The confidence that the user
said the line, and how often it was true on one measured meeting (1,144 lines):

| Share on the microphone | The user | Measured |
|---|---|---|
| 90 % or more | 0.85 (0.75 where the live segments said the call). Content rules can raise it to 0.95. A reply of one to three words counts too. | 99 % were the user |
| 70 % to 90 % | 0.6 to 0.75 by content; ask when it matters | 82 % |
| 50 % to 70 % | Open: decide by content, at 0.6 or less, or ask | 42 % |
| 10 % to 50 % | Not the user (0.75), unless the content says so | 5 % |
| Under 10 % | Never the user | 0 % |

A line that is not the user's goes to the remote candidates, and the formula below scores them.

## Inputs the agent still gathers

1. **The roles. Ask the user before scoring**: who is the analyst, the architect, the backend and frontend developers,
   the organiser. An analyst speaks in business terms, an architect about structure and less about code, a developer
   about code he owns ("mám to na frontendu").
2. The documents the meeting discussed, for the content rules R2, R3 and R12.
3. Whatever the tool reported as missing (a platform without attendance, a recording without a second channel).
4. A label the platform named after a person is that person's voice, but it can still hold another remote voice. Move
   such a line by content only, at 0.75 or less.

## Content rules (for what E1 to E4 leave open)

Score per remote candidate in the pool that E1 to E4 leave (the user's own confidence comes from the energy table).
Tiers and rules go into one sum: `net` is the weights of every tier
and rule that speaks for the candidate minus the weights of those against it, and `confidence = 50 + 50 * net /
sum(weights that apply)` when `net > 0`. A candidate with `net <= 0` is excluded.

Example: E1 is mixed and gives nothing; E3 shows Petr speaking (+5); R6 says Petr spoke three turns ago (+3); R8
markers lean to Pavel (-2 for Petr). For Petr, `net = 5 + 3 - 2 = 6` over weights `5 + 3 + 2 = 10`, so 80 %.

`tools meetings transcript --with-suggested` applies a stored range at 50 % or more (`global.suggest.applyAbove`) and
shows a lower one as `[nejasné: "<label>"; 1) <name> NN %]`. Under 60 % (`listenBelow`) a range that matters is a
question candidate (below).

| Rule | Weight | Statement | Status |
|---|---|---|---|
| R1 departure | 5 | A person who said goodbye does not speak after that. | confirmed |
| R2 third person | 5 | A speaker who names X in the third person ("Pavel teďka říkal") is not X. | confirmed |
| R3 vocative | 3, +1 per repeat | A speaker who addresses X ("Tomáši", "Petře") is not X. X gains score when the NEXT turn is long and on topic; each such case adds 1 (cap +3). A vocative can refer to something X said earlier ("co říkáš, Petře" after a line from someone else), so the turn just before is not proof. | confirmed, refined |
| R4 overlap | 1 | Two turns that start in the same second under different labels may be two people. Weak: a 1-second timestamp cannot separate them, and in the example 6 such pairs were both on the user's microphone. Use it only with sub-second times from `live.ndjson`. | kept at weight 1, millisecond times only (decision 24) |
| R5 inheritance | 2 | After a person leaves, the label they had tends to go to another voice for the rest of the call (see below). It names no voice: score each line with E1 and the other rules. | example given |
| R6 recency | 3 | A wrong label probably belongs to someone who spoke in the last ten turns. | confirmed |
| R7 absence | 4 | "X tu není" or "X se omlouval" removes X. A statement like "já jsem nebyl u toho" proves nothing: it can mean another meeting. | narrowed |
| R8 idiolect | 2 | Build a profile per person from lines that E1 to E3 already prove: marker words (Slovak "teďkom", "nazad", "aj"; fillers "ty vole", "hele", "jakoby"), and score an open line by how many of one person's markers it has. | generalised |
| R9 the user | - | The user's lines come from E1. The user confirms only the mixed ones (25 % to 75 % `mic`) and content claims about the user. | rewritten |
| R10 presence | 2 | A speaker who reports what X said "before X left" was present before X left. | confirmed |
| R11 company | 3 | A speaker who dismisses a silent colleague ("Jano, klidně běž") shares the colleague's company suffix. Only where the attendance shows suffixes. | proposed |
| R12 role | 2 | The line fits the role the user named: code someone owns, the generator, the database design, business requirements. | proposed |
| R13 farewell reply | 3 | A leave phrase is a departure only when another label answers it within about 15 s. | proposed |
| R14 echo | 4 | A leave phrase with "taky" right after another label's leave phrase is a different person. | proposed |
| R15 label drift | 3 | A present attendee whose own label goes silent for a long stretch has moved into another label. Check with E1. | proposed |
| RM muted | 5 | A person the platform shows as muted during the line did not speak it. The mute state can lag by a second, so use the observations inside the line, not at its edge. | proposed |
| R16 arrival | 4 | A greeting ("čus", "ahoj", "zdravím") or a newcomer's question ("o co jsem přišel", "slyšíte mě?") within about a minute after a join belongs to the person who just joined, unless E1 or E3 says otherwise. | proposed |

### R5 in one example

Invented: the tester had label 3 and left at `22:10`. Label 3 kept speaking for another 200 lines. The source did not
create a new label; the voices of the people still in the call were filed under label 3. So the stretch after a
departure must be attributed line by line, never as one block. R5 only says: "this stretch needs work".

### R8 as a general rule

1. Take the lines that E1 to E3 prove at 90 % or more for each person.
2. Count, per person, the words that are rare in the meeting overall (dialect forms, fillers, phrases).
3. For an open line, count how many of each person's markers it contains, relative to that person's rate.
4. Add R8 only when one person's markers clearly lead; never let it decide alone.

## Uncertain lines: ask the user to listen, but only what matters

The user's time is the scarcest input. Ask about a line only when it is both unsure and important, and let each answer
settle as many other lines as possible. On the example meeting this cut 250 candidate questions to about 12.

1. **Unsure**: the best candidate is under 60 %. Two channels at once is not a reason by itself.
2. **Important**: the range has at least 15 words, or a decision or action word ("domluvíme", "souhlas", "udělám",
   "zavolám", "napíšu", "zítra"), or the summary cites it (an action item's owner depends on it). Never ask about an
   interjection ("jo", "hm", "mhm", "čau") or a range of five words or fewer.
3. **Not already covered**: drop a coarse question when finer evidence covers most of its lines; merge questions that
   overlap or lie within 30 s of each other and offer the same people.
4. **Highest value first**: priority = (1 - confidence) x impact x reach, where reach counts the other unsure ranges
   with the same evidence (the same live voice, the same people present, the same top candidates).
5. **Propagate**: an answer raises every range with the same evidence; re-rank, and ask the next only if it is still
   under 60 %. A word answer also answers every other open question on the same heard words, so one word is never
   asked twice; the `answered` event lists those questions in `settled`.
6. **Budget**: about 12 questions per meeting; the user can say "enough". A split does not count: its parts come next
   and share its place. The rest stay suggestions and render as
   `[nejasné: "<label>"; 1) Petr 55 % 2) Pavel]` (only the known confidence is shown).
7. **Split**: when the user hears several voices in one range, "Several voices" in `listen` cuts it at each line and at
   each change between the microphone and the call, then asks each part with its words. Two remote voices in a row
   stay one part: the user answers it with "Something else…" ("Novák, then Dvořák"). In three-pass mode, a long line
   at 40 % to 60 % microphone energy gets a range for the voice that says most of it and a question, so the user can
   split it by ear.

In the automatic mode the tool applies these rules (`tools meetings suggest`, then `tools meetings listen`). In the
three-pass mode the agent applies them when it adds questions with `tools meetings items add --kind question`, which
warns about a question whose text repeats another open question (name the time or quote the words instead), one that
decides no item, and one with no priority. Give each question `priority` (0 to 1, `--priority` or the batch field):
listen asks the highest first, and one under `playback.listen.minPriority` (0.5) only with `--item`. The
budget is one for speakers and terms together (`playback.listen.budget`, 12 by default). In both, the
agent answers only what the listen round left open, in the chat round, with the evidence.

## Joins and splits

A turn that ends without punctuation and a next turn that starts in lower case within one second ("při" | "pravím")
are one sentence. Store a `join` finding (SKILL.md, pass 2): the tool moves the word into the first turn and
attributes the whole sentence (E1 first).

## What a diff of a re-attributed turn looks like

```diff
- **Pavel Novák:** `52:10` Dobře, tak já to ještě projdu s Petrem a pošlu vám to zítra.
+ **[Tomáš Dvořák: 99 %]:** `52:10` Dobře, tak já to ještě projdu s Petrem a pošlu vám to zítra.
// E1: 100 % mic (live.ndjson), energy 100 % on the mic channel; the user is Tomáš. E2: Pavel left at 22:10.
```
