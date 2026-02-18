# DarwinKit — Complete Reference Guide

> **Repository:** https://github.com/0xMassi/darwinkit
> **Version:** 0.1.0 · **License:** MIT · **Language:** Swift 5.9+
> **Requirements:** macOS 13+ (Ventura)

DarwinKit is a Swift CLI that exposes Apple's on-device ML frameworks — **NaturalLanguage** and **Vision** — via **JSON-RPC 2.0** over **NDJSON** stdio. Any language (TypeScript, Python, Rust, …) can use Apple's ML capabilities by spawning `darwinkit serve` as a subprocess and communicating via newline-delimited JSON.

**Key advantage:** Fully on-device, no API keys, no network required, privacy-preserving.

---

## Table of Contents

1. [Installation](#installation)
2. [Operating Modes](#operating-modes)
3. [JSON-RPC 2.0 Protocol](#json-rpc-20-protocol)
4. [Error Codes](#error-codes)
5. [All Methods](#all-methods)
   - [nlp.language](#nlplanguage--language-detection)
   - [nlp.sentiment](#nlpsentiment--sentiment-analysis)
   - [nlp.tag](#nlptag--pos-tagging--ner)
   - [nlp.embed](#nlpembed--text-embeddings)
   - [nlp.distance](#nlpdistance--semantic-distance)
   - [nlp.neighbors](#nlpneighbors--semantic-neighbors)
   - [vision.ocr](#visionocr--ocr)
   - [system.capabilities](#systemcapabilities--capability-query)
6. [Language Support](#language-support)
7. [Performance](#performance)
8. [Integration Examples](#integration-examples)
9. [Known Limitations](#known-limitations)
10. [Architecture](#architecture)
11. [Roadmap](#roadmap)

---

## Installation

```bash
# Homebrew (recommended)
brew tap 0xMassi/darwinkit
brew install darwinkit

# Verify
darwinkit query '{"jsonrpc":"2.0","id":"1","method":"system.capabilities","params":{}}'
```

### From GitHub Releases

```bash
curl -L https://github.com/0xMassi/darwinkit/releases/latest/download/darwinkit-macos-universal.tar.gz | tar xz
sudo mv darwinkit /usr/local/bin/
```

### Build from Source

```bash
git clone https://github.com/0xMassi/darwinkit.git
cd darwinkit
swift build -c release
# Binary at .build/release/darwinkit

# Universal binary (arm64 + x86_64)
swift build -c release --arch arm64 --arch x86_64
```

---

## Operating Modes

### Server Mode (`darwinkit serve`)

Long-running subprocess for high-throughput applications. **This is the primary mode** for GenesisTools integration.

```
Startup sequence:
  1. You spawn:    darwinkit serve
  2. DarwinKit:    sends ready notification → stdout (NDJSON)
  3. You read:     ready notification (contains version + methods)
  4. You send:     JSON-RPC requests → stdin (one per line)
  5. DarwinKit:    writes responses → stdout (one per line)
  6. You send:     close stdin to exit
```

Implementation details:
- Disables stdout buffering (`setbuf(stdout, nil)`) for immediate visibility
- Background thread reads stdin; main thread runs RunLoop for Apple framework callbacks
- Exits cleanly when stdin is closed

### Query Mode (`darwinkit query '<JSON>'`)

Single-request execution for scripts and one-off queries.

```bash
darwinkit query '{"jsonrpc":"2.0","id":"1","method":"nlp.sentiment","params":{"text":"I love this!"}}'
# → {"jsonrpc":"2.0","id":"1","result":{"label":"positive","score":1.0}}
```

---

## JSON-RPC 2.0 Protocol

All communication is **NDJSON** (one JSON object per line, `\n` terminated).

### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "nlp.embed",
  "params": {
    "text": "hello world",
    "language": "en",
    "type": "sentence"
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `jsonrpc` | Yes | Must be `"2.0"` |
| `id` | Yes | String. Echoed in response. |
| `method` | Yes | See method table below. |
| `params` | No | Object. Defaults to `{}`. |

### Response (Success)

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": { ... }
}
```

### Response (Error)

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": {
    "code": -32602,
    "message": "Missing required param: text",
    "data": null
  }
}
```

### Ready Notification (Startup)

Sent immediately on server startup — no `id` field (it's a notification):

```json
{
  "jsonrpc": "2.0",
  "method": "ready",
  "params": {
    "version": "0.1.0",
    "capabilities": {
      "nlp.embed": { "available": true, "note": "Sentence embeddings require macOS 11+" },
      "nlp.sentiment": { "available": true },
      "vision.ocr": { "available": true }
    }
  }
}
```

### Batch Simulation

DarwinKit has no native batch request. Simulate by pipelining multiple requests:

```bash
{
  echo '{"jsonrpc":"2.0","id":"1","method":"nlp.language","params":{"text":"Hola"}}'
  echo '{"jsonrpc":"2.0","id":"2","method":"nlp.sentiment","params":{"text":"Great!"}}'
} | darwinkit serve 2>/dev/null
# → {"id":"1","jsonrpc":"2.0","result":{"language":"es","confidence":0.99}}
# → {"id":"2","jsonrpc":"2.0","result":{"label":"positive","score":1.0}}
```

---

## Error Codes

| Code | Name | Typical Cause |
|------|------|---------------|
| `-32700` | Parse Error | Malformed JSON / invalid UTF-8 |
| `-32600` | Invalid Request | Missing `jsonrpc:"2.0"` |
| `-32601` | Method Not Found | Typo in method name |
| `-32602` | Invalid Params | Missing required param, wrong type |
| `-32603` | Internal Error | Uncaught exception |
| `-32001` | Framework Unavailable | Language not supported, OS too old, missing model |
| `-32002` | Permission Denied | File permissions, entitlements |
| `-32003` | OS Version Too Old | Feature requires newer macOS |
| `-32004` | Operation Cancelled | System cancelled long-running operation |

---

## All Methods

### `nlp.language` — Language Detection

Detects language of text. Supports 60+ languages via `NLLanguageRecognizer`.

**Request params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to detect |

**Response:**

```json
{
  "language": "fr",
  "confidence": 0.9990198612213135
}
```

| Field | Type | Notes |
|-------|------|-------|
| `language` | string | BCP-47 code: `"en"`, `"fr"`, `"es"`, `"de"`, `"zh-Hans"`, … |
| `confidence` | double | 0.0–1.0 |

**Example:**

```bash
darwinkit query '{"jsonrpc":"2.0","id":"1","method":"nlp.language","params":{"text":"Bonjour le monde"}}'
# → {"result":{"language":"fr","confidence":0.999}}
```

---

### `nlp.sentiment` — Sentiment Analysis

Analyzes sentiment using `NLTagger` with `.sentimentScore` scheme.

**Request params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to analyze |

**Response:**

```json
{
  "score": 0.9,
  "label": "positive"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `score` | double | -1.0 to 1.0 |
| `label` | string | `"positive"` (>0.1), `"neutral"` (-0.1–0.1), `"negative"` (<-0.1) |

**macOS requirement:** macOS 11+ (Big Sur)

---

### `nlp.tag` — POS Tagging & NER

Part-of-speech tagging and named entity recognition via `NLTagger`. Multiple schemes in one call.

**Request params:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | Yes | — | Text to tag |
| `language` | string | No | auto | BCP-47 code |
| `schemes` | array | No | `["lexicalClass"]` | Which schemes to apply |

**Available schemes:**

| Scheme | Output examples |
|--------|----------------|
| `lexicalClass` | `Noun`, `Verb`, `Adjective`, `Adverb`, `Pronoun`, `Preposition`, `Conjunction`, `Determiner`, `Particle` |
| `nameType` | `PersonName`, `PlaceName`, `OrganizationName`, `Other` |
| `lemma` | `"founded"` → `"find"` |
| `sentimentScore` | Per-token score string, e.g. `"-0.5"` |
| `language` | Per-token BCP-47 code |

**Response:**

```json
{
  "tokens": [
    {
      "text": "Apple",
      "tags": {
        "lexicalClass": "Noun",
        "nameType": "OrganizationName"
      }
    },
    {
      "text": "Steve",
      "tags": {
        "lexicalClass": "Noun",
        "nameType": "PersonName"
      }
    }
  ]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `tokens` | array | Punctuation/whitespace omitted |
| `tokens[].text` | string | Token text |
| `tokens[].tags` | object | `scheme → value` (null if not applicable) |

---

### `nlp.embed` — Text Embeddings

512-dimensional semantic vector via `NLEmbedding`. The foundation for semantic search and similarity ranking.

**Request params:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | Yes | — | Text to embed |
| `language` | string | Yes | — | One of 7 supported languages |
| `type` | string | No | `"sentence"` | `"word"` or `"sentence"` |

**Supported embedding languages (7 only):**
`en`, `es`, `fr`, `de`, `it`, `pt`, `zh-Hans`

**macOS requirements:**
- Word embeddings: macOS 13+
- Sentence embeddings: macOS 11+

**Response:**

```json
{
  "vector": [0.031, -0.089, 0.044, ...],
  "dimension": 512
}
```

| Field | Type | Notes |
|-------|------|-------|
| `vector` | array\<double\> | 512-dimensional float array |
| `dimension` | integer | Always 512 |

---

### `nlp.distance` — Semantic Distance

Cosine distance between two texts. 0 = identical, 2 = maximally different.

**Request params:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text1` | string | Yes | — | First text |
| `text2` | string | Yes | — | Second text |
| `language` | string | Yes | — | BCP-47 code |
| `type` | string | No | `"word"` | `"word"` or `"sentence"` |

**Response:**

```json
{
  "distance": 0.312,
  "type": "cosine"
}
```

**Practical distance ranges (sentence embeddings):**

| Distance | Meaning |
|----------|---------|
| 0.0–0.3 | Very similar / same topic |
| 0.3–0.6 | Related topics |
| 0.6–1.0 | Loosely related |
| 1.0–2.0 | Unrelated |

---

### `nlp.neighbors` — Semantic Neighbors

Finds semantically similar words or sentences using `NLEmbedding.neighbors(for:maximumCount:)`.

**Request params:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | Yes | — | Query text |
| `language` | string | Yes | — | BCP-47 code |
| `type` | string | No | `"word"` | `"word"` or `"sentence"` |
| `count` | integer | No | `5` | Max neighbors to return |

**Response:**

```json
{
  "neighbors": [
    { "text": "coding", "distance": 0.21 },
    { "text": "development", "distance": 0.28 },
    { "text": "software", "distance": 0.35 }
  ]
}
```

---

### `vision.ocr` — OCR

Extracts text from images using Apple Vision's `VNRecognizeTextRequest`.

**Request params:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | Yes | — | Absolute path to image file |
| `languages` | array | No | `["en-US"]` | BCP-47 recognition languages |
| `level` | string | No | `"accurate"` | `"accurate"` or `"fast"` |

**Supported image formats:** JPEG, PNG, TIFF, HEIC, PDF (single/multi-page)

**Common OCR languages:** `en-US`, `fr-FR`, `de-DE`, `es-ES`, `it-IT`, `pt-BR`, `ja-JP`, `zh-Hans`, `zh-Hant`, `ko-KR`

**Response:**

```json
{
  "text": "Hello World\nThis is a test",
  "blocks": [
    {
      "text": "Hello World",
      "confidence": 0.95,
      "bounds": { "x": 0.1, "y": 0.8, "width": 0.3, "height": 0.05 }
    }
  ]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `text` | string | All blocks joined by newlines |
| `blocks[].text` | string | Block text |
| `blocks[].confidence` | float | 0.0–1.0 |
| `blocks[].bounds` | object | Normalized 0–1 coords, **origin bottom-left** |

> ⚠️ **Coordinate system:** `y=0.9` is near the top of the image, `y=0.1` near the bottom — opposite of most web coordinate systems.

---

### `system.capabilities` — Capability Query

Returns DarwinKit version, OS, CPU architecture, and available methods.

**Request params:** None

**Response:**

```json
{
  "version": "0.1.0",
  "os": "13.0.0",
  "arch": "arm64",
  "methods": {
    "nlp.embed": { "available": true, "note": "Sentence embeddings require macOS 11+" },
    "nlp.distance": { "available": true },
    "nlp.neighbors": { "available": true },
    "nlp.tag": { "available": true },
    "nlp.sentiment": { "available": true },
    "nlp.language": { "available": true },
    "vision.ocr": { "available": true },
    "system.capabilities": { "available": true }
  }
}
```

---

## Complete Method Summary

| Method | Category | Key Input | Key Output | macOS Req |
|--------|----------|-----------|------------|-----------|
| `nlp.language` | NLP | text | language code + confidence | 13+ |
| `nlp.sentiment` | NLP | text | score (-1–1) + label | 11+ |
| `nlp.tag` | NLP | text, schemes | tokens with POS/NER tags | 13+ |
| `nlp.embed` | NLP | text, language, type | 512-dim float vector | 11+ (sentence) |
| `nlp.distance` | NLP | text1, text2, language | cosine distance 0–2 | 11+ |
| `nlp.neighbors` | NLP | text, language, count | similar words/sentences | 13+ |
| `vision.ocr` | Vision | image path, languages | full text + bounding boxes | 13+ |
| `system.capabilities` | System | — | version, OS, arch, methods | 13+ |

---

## Language Support

### Embedding Languages (7)

Only these languages have 512-dim `NLEmbedding` support for `nlp.embed`, `nlp.distance`, `nlp.neighbors`:

| Code | Language |
|------|----------|
| `en` | English |
| `es` | Spanish |
| `fr` | French |
| `de` | German |
| `it` | Italian |
| `pt` | Portuguese |
| `zh-Hans` | Simplified Chinese |

### Language Detection (60+)

`nlp.language` supports 60+ languages via `NLLanguageRecognizer`, including Arabic, Bengali, Czech, Danish, Dutch, Finnish, Greek, Hebrew, Hindi, Hungarian, Indonesian, Japanese, Korean, Malay, Norwegian, Polish, Romanian, Russian, Slovak, Swedish, Thai, Turkish, Ukrainian, Vietnamese, and more.

### Tagging / Sentiment Languages

`nlp.tag` and `nlp.sentiment` support the same broad language set as `nlp.language`; the language can be auto-detected if not specified.

---

## Performance

### Latency (Apple Silicon M-series)

| Method | Typical Latency |
|--------|----------------|
| `nlp.language` | 2–10ms |
| `nlp.sentiment` | 5–20ms |
| `nlp.tag` | 20–100ms |
| `nlp.embed` (word) | 5–15ms |
| `nlp.embed` (sentence) | 10–50ms |
| `nlp.distance` | 10–60ms |
| `vision.ocr` (fast) | 100–500ms |
| `vision.ocr` (accurate) | 500ms–2s |

### Startup Overhead

- Server startup: ~100–200ms (Swift runtime + Apple framework init)
- Per-call IPC overhead: 1–2ms

### Memory

- Process base: ~30–50 MB
- Per-request peak: 5–20 MB (OCR can be higher)
- No memory leaks (43 unit tests validate this)

### Throughput (server mode, concurrent pipelining)

- Language detection: ~100–200 requests/sec
- Sentiment: ~50–100 requests/sec
- Sentence embeddings: ~20–50 requests/sec
- OCR: 1–10 images/sec

---

## Integration Examples

### TypeScript / Bun (GenesisTools pattern)

```typescript
// @app/utils/macos provides this already — see src/utils/macos/
import { getDarwinKit, closeDarwinKit } from "@app/utils/macos";

// Language detection
const lang = await getDarwinKit().call("nlp.language", { text: "Bonjour" });
// → { language: "fr", confidence: 0.999 }

// Sentiment
const sentiment = await getDarwinKit().call("nlp.sentiment", { text: "Amazing!" });
// → { score: 1.0, label: "positive" }

// Semantic embedding + ranking
import { rankBySimilarity } from "@app/utils/macos";
const ranked = await rankBySimilarity("budget planning", items, { maxDistance: 1.0 });

// OCR
const ocr = await getDarwinKit().call("vision.ocr", {
  path: "/tmp/screenshot.png",
  languages: ["en-US"],
  level: "accurate"
});
console.log(ocr.text);

closeDarwinKit(); // Clean up subprocess
```

### Python

```python
import json, subprocess

proc = subprocess.Popen(
    ['darwinkit', 'serve'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL, text=True,
)
# Read ready notification
json.loads(proc.stdout.readline())

def call(method, params={}):
    proc.stdin.write(json.dumps({"jsonrpc":"2.0","id":"1","method":method,"params":params}) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())["result"]

print(call("nlp.sentiment", {"text": "I love this!"}))
# → {'score': 1.0, 'label': 'positive'}

proc.stdin.close()
proc.wait()
```

### Bash (one-liner)

```bash
# Sentiment check
darwinkit query '{"jsonrpc":"2.0","id":"1","method":"nlp.sentiment","params":{"text":"I love this!"}}' | jq '.result.label'
# → "positive"

# Language detect
darwinkit query '{"jsonrpc":"2.0","id":"1","method":"nlp.language","params":{"text":"Hola mundo"}}' | jq '.result'
# → {"language":"es","confidence":0.997}
```

---

## Known Limitations

| Limitation | Details |
|------------|---------|
| **Embedding languages** | Only 7 languages supported (en, es, fr, de, it, pt, zh-Hans) |
| **macOS minimum** | All features: macOS 13+; sentence embeddings: macOS 11+ |
| **No streaming** | Complete responses only, no incremental/chunked output |
| **No native batching** | Submit requests line-by-line in server mode |
| **No async cancellation** | `$/cancel` stub not fully implemented |
| **Single-threaded** | Requests queued; no parallel execution within one process |
| **OCR: file path only** | No base64 inline images; must provide absolute path |
| **OCR: bottom-left origin** | Bounding box `y=0` is bottom of image (opposite of web convention) |

---

## Architecture

```
darwinkit/
  Sources/
    DarwinKit/
      DarwinKit.swift           # @main, `serve` + `query` subcommands
    DarwinKitCore/
      Server/
        Protocol.swift          # JSON-RPC 2.0 types, AnyCodable, NDJSON
        JsonRpcServer.swift     # stdin/stdout loop, ready notification
        MethodRouter.swift      # Method dispatch + capabilities registry
      Handlers/
        SystemHandler.swift     # system.capabilities
        NLPHandler.swift        # nlp.* methods
        VisionHandler.swift     # vision.ocr
      Providers/
        NLPProvider.swift       # Protocol + Apple NaturalLanguage impl
        VisionProvider.swift    # Protocol + Apple Vision impl
  Tests/
    DarwinKitCoreTests/         # 43 unit tests with mock providers
```

All Apple framework calls are behind **provider protocols**. Tests use mock providers — no specific OS version or hardware required.

---

## Roadmap

| Version | Planned Feature |
|---------|----------------|
| v0.2.0 | `speech.transcribe` via `SFSpeechRecognizer` |
| v0.3.0 | `llm.generate` via Apple Foundation Models (macOS 26+) |

---

## Additional Resources

- **GitHub:** https://github.com/0xMassi/darwinkit
- **Reddit Discussion:** https://www.reddit.com/r/swift/comments/1qxvnns/darwinkit_open_source_swift_cli_that_wraps_apples/
- **GenesisTools Wrapper:** `src/utils/macos/` — typed TypeScript client already integrated
- **Smoke test:** `bun run src/utils/macos/_smoke-test.ts`
