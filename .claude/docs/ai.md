# AI Models, Providers & Embedding Knowledge Base

## Provider Architecture

### Provider Types (`AIProviderType`)

```
"local-hf" | "darwinkit" | "coreml" | "ollama" | "cloud" | "openai" | "groq" | "openrouter" | "google"
```

- `"cloud"` is a backward-compat alias for auto-detect (tries groq → openrouter → openai)
- `"openai"`, `"groq"`, `"openrouter"` are first-class types — each maps to `AICloudProvider(cloudType)`
- `isCloudProvider()` helper in `ai.types.ts` checks membership in `CLOUD_PROVIDER_TYPES` Set

### Cloud Provider Internals (`AICloudProvider`)

Parameterized with `CloudType = "openai" | "groq" | "openrouter" | "auto"`:

| CloudType | ENV var | Default LLM model | Supports |
|-----------|---------|-------------------|----------|
| groq | `GROQ_API_KEY` | `groq/llama-3.1-8b-instant` | transcribe, summarize, chat |
| openrouter | `OPENROUTER_API_KEY` | `openrouter/google/gemma-2-9b-it:free` | summarize, translate, chat |
| openai | `OPENAI_API_KEY` | `openai/gpt-4o-mini` | transcribe, summarize, translate, embed, chat |

Auto mode fallback order: groq → openrouter → openai.

`isAvailable()` in auto mode checks: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`, `GLADIA_API_KEY` (hoisted to `AUTO_API_KEY_VARS` module constant — no per-call allocation).

### DarwinKit Provider Details

**Package:** `@genesiscz/darwinkit` v0.6.4 — TypeScript SDK for Apple's on-device ML via JSON-RPC to a Swift binary.

**NLP namespace** (`getDarwinKit().nlp`):
- `embed({ text, language, type })` — single text, 512-dim sentence embedding
- `distance()`, `neighbors()`, `tag()`, `sentiment()`, `language()`
- **NO `embedBatch`** — the TypeScript wrapper doesn't expose it, and Apple's `NLEmbedding` API has no batch method either

**CoreML namespace** (`getDarwinKit().coreml`):
- `embed({ model_id, text })` — single embedding via loaded CoreML model
- `embedBatch({ model_id, texts })` → `{ vectors: number[][], dimensions: number, count: number }`
- `loadContextual({ id: "NLContextualEmbedding", language })` — loads Apple's built-in BERT contextual model
- `contextualEmbed({ model_id, text })` — single contextual embedding
- `embedContextualBatch({ model_id, texts })` — **batch contextual embedding** (used by DarwinKit provider fix)

**Contextual embedding (NLContextualEmbedding):**
- macOS 14+ only
- 512-dim (same as NLP sentence embedding — indexes are compatible)
- Runs on Neural Engine + CPU via Core ML
- No way to swap the model — Apple's bundled model only
- Quality uncharacterized against MTEB benchmarks

**Notification capabilities** (`getDarwinKit().notifications`):
- `UNUserNotificationCenter` — action buttons, text input, scheduled triggers, attachments
- Can set `NSApp.applicationIconImage` for custom app icon (like terminal-notifier)
- Sound: `{ named: "Purr" }` etc.
- GitHub issue filed: `genesiscz/darwinkit-swift#16` for full notification feature parity with terminal-notifier

### Apple NaturalLanguage Framework (research findings)

**NLEmbedding** (macOS 10.15+):
- Static word/sentence embeddings from bundled models
- `vector(for: String)` — single string only, no batch
- `enumerateNeighbors` is for ANN search within existing vocabulary, NOT for embedding external text

**NLContextualEmbedding** (macOS 14+):
- BERT-based contextual embeddings
- `embeddingResult(for: String, language:)` — single string only, no batch
- Can be parallelized via Swift `TaskGroup` (4-8 concurrent tasks)
- Theoretical throughput with concurrency: 500-2000 emb/s on M2 (unverified)

### Ollama on Apple Silicon

- **Version 0.19+**: Switched from llama.cpp to Apple's MLX backend on Apple Silicon
- Current version: 0.20.2
- Embedding models run 100% on Metal GPU (verified via `api/ps` → `size_vram == size`)
- `/api/embed` endpoint supports native batching (JSON array of strings)
- `OLLAMA_NUM_PARALLEL` env var increases parallelism

### transformers.js v4 + ONNX Runtime

- Version: 4.0.1
- **CoreML EP IS available** on macOS (verified: `onnxruntime-node.listSupportedBackends()` → `["cpu", "webgpu", "coreml"]`)
- `resolveDevice()` in `src/utils/ai/device.ts` detects CoreML and passes to pipeline
- **But**: ONNX→CoreML dispatch overhead for small BERT models (22-137M params) negates acceleration
- Result: 38 emb/s vs Ollama's 172 emb/s for the same class of model
- The overhead is in the ONNX Runtime CoreML Execution Provider bridging, not the model itself
- Better for larger models (7B+) where the Neural Engine throughput dominates

## Embedding Benchmarks (2026-04-08, Apple Silicon)

All GPU-verified. Mixed-length realistic email texts (50% short, 35% medium, 15% long).

### Ollama (Metal GPU, 100% VRAM)

| Model | Batch | emb/s | 300K est. | Dims |
|-------|-------|------:|-----------|------|
| nomic-embed-text | parallel 4x100 | **176** | **28 min** | 768 |
| nomic-embed-text | batch=500 sustained | **172** | 29 min | 768 |
| nomic-embed-text | batch=200 | 161 | 31 min | 768 |
| nomic-embed-text | batch=100 | 158 | 32 min | 768 |
| nomic-embed-text | batch=50 | 153 | 33 min | 768 |
| snowflake-arctic-embed:137m | batch=500 sustained | **161** | 31 min | 768 |
| snowflake-arctic-embed:137m | batch=100 | 145 | 34 min | 768 |

**Optimal batch size:** 500 (batch=1000 doesn't improve throughput).

### DarwinKit / CoreML (macOS native)

| Provider | Mode | emb/s | 300K est. | Dims | Accel |
|----------|------|------:|-----------|------|-------|
| CoreML contextual | batch=200 | 66 | 76 min | 512 | Neural Engine |
| CoreML contextual | batch=100 sustained | **71** | **70 min** | 512 | Neural Engine |
| CoreML contextual | batch=32 | 65 | 77 min | 512 | Neural Engine |
| DarwinKit NLP | sequential (no batch API) | **37** | **136 min** | 512 | None |

### Local HF ONNX (transformers.js v4)

| Model | Batch | emb/s | 300K est. | Dims | Accel |
|-------|-------|------:|-----------|------|-------|
| Xenova/all-MiniLM-L6-v2 | batch=50 | 38 | 132 min | 384 | CoreML EP |

### Text length impact

Short texts (~80 chars) show misleadingly high rates:

| Provider | emb/s (short) | emb/s (real emails) | Slowdown |
|----------|--------------|--------------------:|----------|
| Ollama nomic | ~150 | 172 | None (batching hides it) |
| DarwinKit NLP | 126 | 37 | 3.4x (no batching, IPC per call) |
| CoreML contextual | 83 | 71 | 1.2x |

### Research findings (not benchmarked locally)

From HuggingFace research agent:
- **Python sentence-transformers + PyTorch MPS**: 500-1500 emb/s on Apple Silicon (fastest path, but requires Python)
- **MLX embedding (qwen3-embeddings-mlx)**: 44K tokens/s = ~440 emb/s for 100-token chunks on M2 Max
- **Apple ANE theoretical**: distilbert at seqLen 128 = 3.47ms on iPhone 13 A15, M2 ANE ~2.5x faster
- **mxbai-embed-large degrades** significantly at docs >2K chars (0.46 R@1 at 8K chars)
- **nomic-embed-text-v2-moe**: no ONNX weights available — unusable for local-hf

## Embedding Models

### Recommended for Mail Indexing

| Model | Provider | Dims | Context | Speed | License | Notes |
|-------|----------|------|---------|-------|---------|-------|
| **nomic-embed-text** | ollama | 768 | 8192 | fast | Apache-2.0 | Best speed/quality. GPU Metal. Default. |
| **snowflake-arctic-embed:137m** | ollama | 768 | 8192 | fast | Apache-2.0 | Comparable to nomic. |
| **Snowflake/snowflake-arctic-embed-l-v2.0** | local-hf | 1024 | 8192 | medium | Apache-2.0 | BEIR 55.6, MIRACL 55.8. Full ONNX quantization. |
| **Xenova/bge-m3** | local-hf | 1024 | 8192 | medium | MIT | Highest multilingual. Hybrid sparse+dense. |
| **ibm-granite/granite-embedding-278m-multilingual** | local-hf | 768 | 8192 | medium | Apache-2.0 | Explicitly supports Czech. MIRACL 58.3. |
| **Qwen3-Embedding-0.6B** | ollama | ? | 32768 | fast | Apache-2.0 | Newest (June 2025), SOTA MMTEB 64.64. No ONNX yet. |

### All Embedding Models (by provider)

#### Ollama (GPU Metal)

| Model | Dims | Context | Speed | RAM | Best For | Task Prefix |
|-------|------|---------|-------|-----|----------|-------------|
| nomic-embed-text | 768 | 8192 | fast | 0.3GB | code, mail, general | `search_document:` / `search_query:` |
| snowflake-arctic-embed:137m | 768 | 8192 | fast | 0.3GB | code, mail, general | — |
| mxbai-embed-large | 1024 | 512 | medium | 0.7GB | general, mail | — |
| all-minilm | 384 | 256 | fast | 0.1GB | general | — |

#### Local HF (ONNX, CoreML EP on macOS)

| Model | Dims | Context | Speed | RAM | Best For | Task Prefix |
|-------|------|---------|-------|-----|----------|-------------|
| jinaai/CodeRankEmbed | 768 | 512 | fast | 1.5GB | code | — |
| nomic-ai/nomic-embed-code-v1 | 768 | 2048 | fast | 1.5GB | code | `search_document:` / `search_query:` |
| jinaai/jina-embeddings-v3 | 1024 | 8192 | fast | 2.5GB | code, general, mail | `search_document:` / `search_query:` |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 8192 | medium | 2.0GB | code, mail, general | — |
| ibm-granite/granite-embedding-278m-multilingual | 768 | 8192 | medium | 1.5GB | mail, general | — |
| nomic-ai/nomic-embed-text-v1.5 | 768 | 8192 | fast | 1.0GB | general, mail | `search_document:` / `search_query:` |
| Xenova/bge-m3 | 1024 | 8192 | medium | 2.5GB | code, general, mail | — |
| onnx-community/gte-multilingual-base | 768 | 8192 | medium | 1.0GB | general | — |
| Xenova/multilingual-e5-small | 384 | 512 | fast | 0.5GB | general | — |
| Xenova/multilingual-e5-base | 768 | 512 | medium | 1.0GB | general | — |
| Xenova/multilingual-e5-large | 1024 | 512 | slow | 2.0GB | general | — |
| Xenova/paraphrase-multilingual-MiniLM-L12-v2 | 384 | 512 | fast | 0.5GB | general | — |
| Xenova/all-MiniLM-L6-v2 | 384 | 256 | fast | 0.1GB | general (legacy) | — |
| nvidia/NV-EmbedCode-7b-v1 | 4096 | 2048 | slow | 15GB | code (needs GPU/M4 Pro Max) | — |

#### macOS Native

| Model | Dims | Context | Speed | Notes |
|-------|------|---------|-------|-------|
| darwinkit (NL sentence) | 512 | 512 | fast | Always available. No batch API. Sequential only. |
| coreml-contextual (NLContextualEmbedding) | 512 | 512 | fast | Has batch API. Neural Engine. macOS 14+. |

#### Cloud API

| Model | Dims | Context | Speed | Notes |
|-------|------|---------|-------|-------|
| text-embedding-3-small (OpenAI) | 1536 | 8191 | fast | Requires OPENAI_API_KEY |
| voyage-code-3 | 1024 | 16000 | medium | Requires VOYAGE_API_KEY. Best code quality. |
| gemini-embedding-001 | 3072 | 2048 | fast | Requires GOOGLE_API_KEY. Free tier. |

### License Warnings

- **jinaai/jina-embeddings-v3**: `CC-BY-NC-4.0` — **non-commercial use only!**
- All other models: Apache-2.0, MIT, or macOS built-in.

### Czech Language Support

Models with explicit Czech support:
- `ibm-granite/granite-embedding-278m-multilingual` — Czech listed as first-class language
- `Xenova/bge-m3` — 100+ languages including Czech
- `Xenova/nllb-200-distilled-600M` — translation, use `ces_Latn` locale
- `Xenova/m2m100_418M` — 100 languages including Czech
- `Snowflake/snowflake-arctic-embed-l-v2.0` — multilingual, Czech likely supported (not explicitly listed)
- DarwinKit NL / CoreML contextual — Apple's models support many languages but quality uncharacterized

## Transcription Models

| Model | Provider | Speed | RAM | Notes |
|-------|----------|-------|-----|-------|
| distil-whisper/distil-large-v3 | local-hf | fast | 0.75GB | English only. 6x faster than large-v3. #1 for English. |
| onnx-community/whisper-large-v3-turbo | local-hf | medium | 1.5GB | Best multilingual speed/quality. fp16 enc + q4 dec. |
| Xenova/whisper-large-v3 | local-hf | slow | 3.1GB | Highest multilingual accuracy. fp16 enc + q4 separate dec. |
| onnx-community/whisper-small | local-hf | fast | 0.25GB | Good multilingual. |
| onnx-community/whisper-base | local-hf | fast | 0.15GB | Balanced. |
| onnx-community/whisper-tiny | local-hf | fast | 0.08GB | Fastest, lowest quality. |
| whisper-large-v3-turbo (Groq) | cloud | fast | — | Requires GROQ_API_KEY. |
| whisper-large-v3 (Groq) | cloud | fast | — | Requires GROQ_API_KEY. |
| whisper-1 (OpenAI) | cloud | fast | — | Requires OPENAI_API_KEY. |

### Whisper ONNX dtype quirks

Different model vendors use different ONNX file naming:
- **onnx-community**: `decoder_model_merged_q4.onnx` (fp16 enc + q4 merged dec)
- **Xenova**: `decoder_model_q4.onnx` (fp16 enc + q4 separate dec, no merged q4)
- **distil-whisper**: only fp32 + quantized/int8 (no fp16/q4 variants)

Handled by `getWhisperDtype()` in `AILocalProvider`.

## Translation Models

| Model | Provider | Speed | RAM | Notes |
|-------|----------|-------|-----|-------|
| Xenova/opus-mt-cs-en | local-hf | fast | 0.3GB | Czech → English |
| Xenova/opus-mt-en-cs | local-hf | fast | 0.3GB | English → Czech |
| Xenova/nllb-200-distilled-600M | local-hf | medium | 2.4GB | 200 languages (use `ces_Latn` for Czech) |
| Xenova/m2m100_418M | local-hf | medium | 1.8GB | 100 languages |

## TTS Models

| Model | Provider | Speed | RAM | Notes |
|-------|----------|-------|-----|-------|
| onnx-community/Kokoro-82M-v1.0-ONNX | local-hf | fast | 0.09GB | Best English. No Czech. q8 quantized. |
| onnx-community/chatterbox-multilingual-ONNX | local-hf | medium | 0.5GB | 23 languages (DE/PL/RU but no Czech). |

## ONNX Device Detection

`src/utils/ai/device.ts` — `detectDevice()` / `resolveDevice()`:

| Platform | Device | Accel | Notes |
|----------|--------|-------|-------|
| macOS | `coreml` | Neural Engine + GPU | Verified via `onnxruntime-node.listSupportedBackends()` |
| Linux x64 | `cuda` | NVIDIA GPU | Falls back to CPU if CUDA unavailable |
| Windows | `dml` | DirectML GPU | |
| Other | `cpu` | None | |

`resolveDevice()` verifies the backend is actually available at runtime before using it.

## Indexer Pipeline

### Batch Sizes (per provider)

From benchmarks — `PROVIDER_BATCH_SIZES` in `src/indexer/lib/types.ts`:

| Provider | Batch Size | Rationale |
|----------|-----------|-----------|
| ollama | 500 | Sweet spot. batch=1000 doesn't improve. |
| cloud (OpenAI) | 2048 | API supports large batches. |
| google | 100 | Rate-limited (5 RPM free tier). |
| darwinkit | 100 | CoreML contextual batch. |
| coreml | 100 | Neural Engine batch. |
| local-hf | 32 | ONNX Runtime batch limit. |

### Chunk sizing

- **Code/files**: `chunkMaxTokens` defaults to 500 (fine-grained search)
- **Mail/chat** (message strategy): auto-derived from embedding model's `contextLength` so each message ≈ 1 chunk
  - nomic-embed-text → 8192 tokens → most emails are 1 chunk
  - darwinkit → 512 tokens → long emails split into multiple chunks
- `deriveMaxTokens()` in `Indexer` handles this automatically
- Explicit `chunkMaxTokens` in `IndexConfig` only overrides for code/files, ignored for message types

### Mail search: FTS vs JXA

- **FTS** (default): Uses indexer's FTS5 fulltext index. Instant (<100ms for 300K chunks).
- **JXA** (`--jxa` flag): AppleScript per message via Mail.app. Very slow (60s+ for 100 messages, times out frequently).
- Search falls back gracefully when no mail index exists.

### Profiling logs

Debug logs (visible in `logs/YYYY-MM-DD.log`, always written regardless of `--verbose`):
- `[scan]`: per-batch chunk time + dbWrite time + running total
- `[embed]`: per-batch text count, avg chars, embed time, emb/s rate
- `[embed]`: per-page breakdown (embed vs dbRead vs dbWrite %)
- `[embed]`: summary with total embeddings, overall rate, page count

## Architecture

### Unified ModelRegistry

- **Source of truth**: `src/utils/ai/ModelRegistry.ts` — all models for all tasks
- **Indexer layer**: `src/indexer/lib/model-registry.ts` — thin re-export with `getModelsForType()`, `formatModelTable()`
- **ModelManager**: `src/utils/ai/ModelManager.ts` — delegates to ModelRegistry, keeps download/cache mgmt
- **ModelEntry interface**: `src/utils/ai/types.ts` — id, name, task, provider, dims, contextLength, speed, ramGB, license, bestFor, taskPrefix

### Provider selection UX

Interactive provider selection pattern (used in voice-memos and mail index):
1. Check available providers (Ollama running? API keys set? macOS?)
2. Show `@clack/prompts` select with availability hints
3. If Ollama not running: show warning with install instructions
4. Non-interactive: require `--provider` flag, error with `suggestCommand()`
5. Save last-used provider to AI config

Commander `[optional]` gotcha: `--provider --other-flag` parses as `provider="--other-flag"`. Validate against known provider set.

### Notification system

- `dispatchNotification(event)` — unified entry point
- Per-call overrides: `sound?`, `ignoreDnD?`, `appIcon?` on `NotificationEvent`
- Channels: system (macOS native), telegram, webhook, say
- System channel: DarwinKit → terminal-notifier → osascript (3-tier fallback)
- `sendNotification` removed from barrel export — only used internally by system channel

### Token refresh

- `resolveAccountToken()` supports force-refresh and stale-token detection
- Retries on 401 (auth error) with token force-refresh
- Persists refreshed tokens under lock via `AIConfig.withLock()`
- `fetchAllAccountsUsage()` reads accounts from unified AIConfig
