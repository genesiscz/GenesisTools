# Audio transcription gotchas (`tools transcribe`, `ask --sst`)

Hard-won; do not relearn these by trial:

- **Audio transcode/convert utils belong in `src/utils/audio/`**, never tied
  into a tool (e.g. NOT new methods on `src/ask/audio/AudioProcessor.ts`).
  Reuse/extend `converter.ts`.
- **AI SDK `transcribe()` has no top-level `language`.** A language hint
  ONLY works via `providerOptions.<providerId>.language`. Passed anywhere
  else it is silently dropped → Whisper auto-detects per-30s and
  hallucination-loops on Czech/non-English. Provider-option keys are
  **camelCase** (`language`, `temperature`, `timestampGranularities`,
  `smartFormat`, `detectLanguage`).
- **`transcribe()` model spec must match the installed `ai` major.** On
  `ai@7` (current), providers are spec-v3/v4 and `@ai-sdk/deepgram@3.x`
  works unpinned; `transcribe` is a stable export (the `experimental_`
  alias remains but is unnecessary). Mismatched majors throw
  `AI_UnsupportedModelVersionError` — bump the provider with `ai`, never
  mix lines. (Historical: `ai@5` required `@ai-sdk/deepgram@^1.0.28`.)
- **Deepgram via AI SDK exposes only raw lowercase per-word segments**;
  the smart-formatted transcript is solely in `result.text`. SRT/VTT need
  word→sentence realignment (see `mapResultSegments` in
  `TranscriptionManager.ts`).
- **`gpt-4o-transcribe`/`gpt-4o-mini-transcribe` reject many containers**
  ("does not support the format") and return **no segment timestamps**.
  Cloud uploads are normalized to 16kHz-mono MP3 (`convertFileToMonoMp3`)
  in `AICloudProvider.transcribe`; for these models SRT degrades to text.
- **`whisper-1` still loops on some audio even configured correctly** —
  it's a model limitation, not a bug. Offer `gpt-4o-transcribe` or
  Deepgram nova-3 (robust + ~5× faster) as the alternative.
- Non-TTY transcribe must use the quiet spinner (no clack frames),
  transcript → stdout, status → stderr.
