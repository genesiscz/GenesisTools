# OpenAI API Endpoint Selection

The ask tool routes OpenAI models to the correct API endpoint automatically.

## The 3 Endpoints

| Endpoint | SDK Method | URL | Use Case |
|----------|-----------|-----|----------|
| Chat Completions | `.chat()` | `/v1/chat/completions` | Standard chat models (GPT-4o, GPT-5, o1, o3) |
| Responses | `.responses()` | `/v1/responses` | Superset — includes codex and pro models |
| Completions | `.completion()` | `/v1/completions` | Legacy — only `gpt-3.5-turbo-instruct` |

## Model → Endpoint Mapping

| Model Pattern | Endpoint | Reason |
|--------------|----------|--------|
| `gpt-4o`, `gpt-4-turbo`, `gpt-4.1` | Chat | Standard chat models |
| `gpt-3.5-turbo` (not -instruct) | Chat | Standard chat model |
| `gpt-5`, `gpt-5-mini`, `gpt-5-nano` | Chat | Standard chat models |
| `o1-*`, `o3-*` | Chat | Reasoning models (chat-compatible) |
| `chatgpt-4o-latest` | Chat | ChatGPT snapshot |
| `gpt-5-codex`, `gpt-5.2-codex` | Responses | Code execution model, NOT chat-compatible |
| `gpt-5-pro` | Responses | Specialized model, NOT chat-compatible |
| `gpt-3.5-turbo-instruct` | Completions | Legacy completion-only model |

## How the Ask Tool Decides

```
getLanguageModel(provider, modelId):
  1. Does the provider have .chat() method?
     → No: use .languageModel() (non-OpenAI providers)
     → Yes: continue
  2. Does the model ID contain "codex" or "-pro"?
     → Yes: use .responses() (Responses API)
     → No: use .chat() (Chat Completions API)
```

## Why `.chat()` is the Default

- Most battle-tested endpoint, used by 99% of applications
- Well-documented with predictable behavior
- `.languageModel()` in AI SDK v5+ defaults to the Responses API, which is newer
  and has different response shapes — using `.chat()` explicitly avoids surprises

## Model Filtering

Non-chat models are filtered from the model selector using pattern matching:

**Excluded patterns:** `codex`, `-pro`, `instruct`, `image`, `transcribe`, `tts`, `embedding`, `whisper`, `dall-e`, `moderation`

These models still work if explicitly specified via `-m` flag — they route to `.responses()`.

## Adding New Models

When OpenAI releases new models:
1. Check if it supports `/v1/chat/completions` (most do)
2. If NOT chat-compatible, add its pattern to `nonChatPatterns` in `ProviderManager.ts`
3. If it needs `.responses()`, add its pattern to `RESPONSES_ONLY_PATTERNS` in `provider.ts`
4. Update `chatModelPrefixes` if the model uses a new prefix family

## The `(string & {})` Type

The AI SDK types like `OpenAIChatModelId` end with `| (string & {})`. This is a TypeScript trick
that allows any string while still providing autocomplete for known values. It does NOT mean
every string works on every endpoint — runtime validation happens server-side.
