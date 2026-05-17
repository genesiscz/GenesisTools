# Plan: Transcribe — repetition cleanup + speaker diarization

**Detailed task-by-task plan:** `.claude/plans/2026-05-17-TranscribeDiarizationAndRepetitionCleanup.super.md`
(this file = executive summary; the `.super.md` has the bite-sized TDD steps with full code).

## Context

The transcription bug-fix work (language-drop root cause, deepgram pin, MP3
normalize, spinner, SRT realignment) is complete + verified, **present as
uncommitted working-tree changes** (confirmed via `git status` + file
contents — not stashed/reverted; Phase 0 Task 0.0 commits it first). This is
the follow-on the user requested, planned as one effort:

- OpenAI hosted `whisper-1` still ∞-loops on some Czech audio (`gth-jaqt-rcw`:
  `"Zkusíme zpátky…"`/`"ještě ještě…"` ×30) while the rest is correct; the
  hosted API exposes no anti-loop decode params → must clean **post-hoc**.
- The user wants speaker attribution ("who spoke when") converging to the
  quality of `~/Downloads/{1,2,5}.srt` (pyannote `SPEAKER_00`-style) — and
  it must work even for Whisper, like Spokenly's "Online (Whisper) + Identify
  Speakers". `*-chatgpt.md` are a **quality benchmark only**, not an output.

Three background research reports (repetition heuristics; diarization
feasibility; Spokenly/pyannote/sherpa-onnx) + two advisor passes pinned every
spec. sherpa-onnx-node has a prebuilt darwin-arm64 binary (no Python) and the
pyannote/WeSpeaker ONNX models are on ungated GitHub releases — both advisor
install gates cleared.

## Approach (phases — see `.super.md` for tasks)

- **Phase 0** — Task 0.0 commit the existing verified bug-fix (one clean
  commit, so feature TDD commits stay bisectable); then
  `tests/transcribe/verify-against-reference.ts` convergence metric (WER-proxy
  + speaker-agreement vs reference SRTs, pure max-overlap match) + `baseline`
  captured before any change; `normalizeSpeakerLabel` (single label source).
- **Phase A** — always-on repetition cleanup util (consecutive-run collapse:
  single-token run≥5, phrase 2–8w run≥3, adjacent-only so scattered legit
  repeats survive; cross-segment dedup <2s; zlib = windowed flag only;
  idempotent). Applied at TranscriptionManager + stitched-Transcriber levels.
  `--no-clean`/`--raw` escape. Delete dead `wordTimestamps`.
- **Phase B1** — Deepgram native diarization: `diarize+utterances`, parse raw
  `result.responses[0].body.results.utterances` (typed, no `any`),
  `TranscriptionSegment.speaker?`, speaker-boundary in coalescing, SRT/VTT/text
  rendering, `--diarize`/`--speakers`, split-bypass (one call ⇒ global labels).
- **Phase B2** — local pyannote via `sherpa-onnx-node@^1.13.2` (pinned;
  segmentation `sherpa-onnx-pyannote-segmentation-3-0/model.onnx`, embedding
  `wespeaker_en_voxceleb_resnet34_LM.onnx`; cache
  `~/.genesis-tools/transcribe/models/diarization/`). Preflight asserts the
  prebuilt binary. whisperX max-overlap alignment, segment granularity,
  `fillNearest:true`, clustering `numClusters:2/threshold:0.5` (`--speakers`
  → numClusters; omit → auto). Pipeline order: **transcribe → cleanup →
  diarize the UN-SPLIT audio → align onto cleaned segments** (global label
  space; no cross-chunk remapping).
- **Phase B3** — word-level alignment enhancement (whisper-1
  `timestampGranularities:["segment","word"]` + Deepgram words → word-overlap
  speaker assignment + re-segmentation at mid-segment turn changes; recovers
  short backchannels). Spike-confirms SDK word exposure first; **kept only if
  it improves speaker-agreement vs reference, else reverted.** gpt-4o has no
  words → stays segment-level. (Promoted from out-of-scope per user.)
- **Phase C** — convergence gate: scored vs `~/Downloads/{1,2,5}.srt` using
  the fixed mapping (1,2↔gth-jaqt-rcw; 5↔xyf-csts-ptr; btf no reference);
  numbers recorded; WER must not regress, speaker-agreement > 0.
- **Phase D** — `src/ask/audio/AudioProcessor.ts` → `src/utils/audio/`
  (probe/split/convert), move-only, one method/commit. **GATED on Phase C.**

## Critical files
New: `repetition-cleanup.ts`, `speaker-label.ts`, `align-speakers.ts`,
`diarize-local.ts`, `diarize-models.ts`, `tests/transcribe/verify-against-reference.ts`.
Modify: `types.ts`, `TranscriptionManager.ts`, `Transcriber.ts`,
`transcription-format.ts`, `AICloudProvider.ts`, `transcribe/index.ts`,
`package.json`. Phase D: `AudioProcessor.ts` → `src/utils/audio/{probe,split}.ts` + `converter.ts`.

## Verification
Per-task TDD (failing test → run-fail → impl → run-pass → commit), `tsgo`
0 errors, `bun test`. E2E: cleanup kills `gth` loop & preserves `xyf`
interviewer repeats; Deepgram + local-pyannote diarization on the 3 files
scored by the metric harness vs `~/Downloads/{1,2,5}.srt`; iterate clustering
until speaker-agreement maximized; Phase C records the numbers and gates D.

## Scope notes
Cross-chunk speaker remapping is **designed out, not deferred** — diarization
always runs on the un-split source ⇒ one global label space; only multi-hour
audio is an edge (documented limit). Word-level alignment is **in scope
(Phase B3)**, metric-gated. Out of scope: AssemblyAI/Gladia (no Czech / dep
absent); LLM polish (`*-chatgpt.md` is a benchmark, not output); confirming
Spokenly internals (closed-source — architecture replicated).
