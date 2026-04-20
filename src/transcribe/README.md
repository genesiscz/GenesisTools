# Transcribe

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Audio / video transcription across cloud and local providers.**

Feed `transcribe` any audio or video file and get back plain text, SRT, VTT, or JSON. Supports multiple providers via the shared `utils/ai` stack — pick OpenAI Whisper, Groq, or a local model. Shares the same audio preprocessing pipeline as `ask`.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Many formats** | mp3, wav, m4a, aac, ogg, flac, aiff, webm, opus, mov, mp4, ... |
| **Multi-provider** | OpenAI, Groq, JinaAI, local — via `AI.transcribe()` |
| **Output formats** | text, srt, vtt, json |
| **Language hints** | `--lang cs` to bias transcription |
| **Clipboard / file** | Pipe to a file or copy straight to the clipboard |

---

## Quick Start

```bash
# Plain text
tools transcribe meeting.m4a

# SRT subtitles to a file
tools transcribe interview.mp4 --format srt -o interview.srt

# Copy to clipboard
tools transcribe memo.mp3 --clipboard

# Force a specific provider + model
tools transcribe call.wav --provider openai --model whisper-1

# Hint the language
tools transcribe recording.m4a --lang cs
```

---

## Options

| Option | Description |
|--------|-------------|
| `<file>` | Path to the input audio/video file |
| `--provider <name>` | Explicit provider (openai, groq, jinaai, ...) |
| `--local` | Prefer a local transcription backend |
| `--format <fmt>` | Output format: `text` (default), `srt`, `vtt`, `json` |
| `--lang <code>` | Language hint (e.g. `en`, `cs`, `de`) |
| `--model <id>` | Override provider model |
| `-o, --output <file>` | Write result to a file |
| `--clipboard` | Copy result to the clipboard |

---

## Notes

- Files are validated with the same pipeline as `ask` (via `AudioProcessor`) — unsupported formats fail fast.
- SRT / VTT output uses the shared `transcription-format` helpers so timestamps match the `ask` audio workflow.
- For YouTube URLs, prefer `tools youtube transcribe` which fetches captions first.
