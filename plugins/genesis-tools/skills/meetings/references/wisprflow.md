# Wispr Flow as a meeting source

The full tool reference is `tools wisprflow --readme` (source: `src/wisprflow/README.md`). This page names what a
polisher needs from it and where it falls short. Checked 2026-11-02 19:30.

## Commands a polisher uses

| Need | Command |
|---|---|
| Find the meeting | `tools wisprflow meetings list "<query>"` (`--since`, `--attendee`) |
| Raw export, unchanged | `tools wisprflow meetings export <id> --dir <dir> --timestamps` (no `--fix-term`) |
| Invitees and the Teams link | `tools wisprflow calendar search "<title>" --format json` -> `events[].attendees`, `conferenceUrl` |
| Candidate term errors | `tools wisprflow meetings transcript <id> --vocab <file> --min-confidence 50 -o <scratch file>` |
| Per-label stats, spans and "several people" hints | `tools wisprflow meetings speakers <id> --attendance teams` (`--gap 2m`, `--format json`). With `--attendance` it runs rule RA first (`absent-speaker`, `sole-attendee`). The spans come from silences, not from goodbyes, so still scan for leave phrases (R1) |
| Renames not yet on the server | `tools wisprflow doctor`, `--cross-check` |

`<id>` is the meeting id, a share link or its slug.

## What `meeting.json` holds

- `meeting.start`, `meeting.end` in UTC: convert to Prague time before you show them.
- `meeting.participants[]`: `speakerId`, `name`, `origin` (`platform` = named by Teams, `llm` = guessed by Wispr's
  model), `isSelf`. A speaker number without a participant entry is shown as "Speaker N".
- `meeting.transcript[]`: one line per entry with `startSec`, `speakerId`, `speaker`, `text`. The Markdown export groups
  lines into turns; count speakers from the JSON, not from the turns.
- `meeting.summary`: Wispr's own summary. Treat each claim as unverified.
- The export does NOT include the calendar invitees; take them from `calendar search`.

## Known limits (requests are in the design document)

- Read-only: no speaker rename, no per-turn re-attribution, no dictionary write.
- The misheard-term check matches Czech words to the English developer glossary (329 suspects on the example meeting,
  mostly false) and misses identifiers spoken with Czech suffixes or as syllables.
- The Wispr summary's name suggestions can have the wrong grammatical case; check what the verb requires.
- Join and leave times come from Teams (`tools ms-teams meetings attendance`), not from Wispr.
- The raw meeting folder `~/Library/Application Support/Wispr Flow/meetings/<id>/` holds the evidence for speaker
  attribution (read-only, copy before you parse): `live.ndjson` (segments with `speaker.source` `mic`/`system` and
  millisecond times; `system` segments carry the Teams name of the active speaker), `speakers.observations.ndjson`
  (Teams' speaking indicator per participant), `native-language-evidence.json` (token counts for `mic` and `system`),
  `audio-devices.json`, and `upload.ogg` (the recording; in the example it was stereo with the user's microphone on one
  channel, but that is a measurement of one recording, not a format guarantee: the tool calibrates the layout per
  recording and drops the energy check when it cannot tell). Play a passage with
  `tools meetings play <meeting> --at <time>` (VLC), and read the per-line evidence with `tools meetings evidence
  <meeting> --attendance teams`; `tools meetings suggest <meeting> --rules evidence` writes it as items to confirm.
