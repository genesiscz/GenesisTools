# JSON parsing costs

Contents: 1. the numbers · 2. `SafeJSON` · 3. why an FFI parser cannot simply replace `JSON.parse` · 4. when FFI
JSON does pay · 5. cheaper without native code · 6. research.

Benchmark: `scripts/benchmarks/json/parse-arms.ts` (+ `parse-child.ts`, `arms.ts`, `simdjson-shim.cpp`), baseline
`json-parse-arms`. Input: the last 256 KB of every Claude transcript changed in 24 hours, 15,900 lines, 137 MB.
CPU ms, cold / warm, medians of 5 fresh processes, load 21 to 32, 2026-10-12.

## 1. The numbers

- `JSON.parse` on ready strings: 112 / 110.
- Decode bytes to strings, then `JSON.parse` (what a file reader really does): 148 / 144.
- `SafeJSON.parse` with no options (native first since ac115cfc9): 115 / 111.
- comment-json alone (the old `SafeJSON.parse` default): 1,261 / 1,026. About 10 times `JSON.parse`.
- `Bun.JSONL.parse` on the joined text: 110 / 109. It uses JSC's parser; Bun 1.4 only.
- simdjson through `bun:ffi`, full parse, NO JS objects built: 35 / 33.
- simdjson through `bun:ffi`, field pick (12 fields per line out as numbers, one call for all lines): 26 / 23.
- simdjson builds a binary tape in C, JS builds full objects from it: about 120 (same as decode + `JSON.parse`).
  With a cache for repeated object keys: median 98 against 124 for decode + `JSON.parse` (8 samples each,
  balanced order, load 33; values equal to `JSON.parse` on all 200 lines checked).
- Turning the 15,900 strings back into UTF-8 bytes: 24 to 28 ms (`Buffer.from` or `TextEncoder`).

## 2. `SafeJSON` (`src/utils/json.ts`)

- `SafeJSON.parse(text)` and `parseJSON(text)` try the native `JSON.parse` first; only text it rejects (comments,
  trailing commas) goes to comment-json, which parses it and keeps the comments as before. Invalid text throws
  comment-json's error, as before.
- `{ strict: true }` / `{ jsonl: true }` is the native parser with no fallback; use it for data you wrote yourself
  and for JSONL, where a comment is an error.
- Before the flip, comment-json on plain JSON also returned `CommentArray` instead of `Array`, boxed top-level
  primitives (`SafeJSON.parse("123")` was a `Number` object), and turned a `"__proto__"` key into the object's
  prototype. Native-first removes all three for plain JSON. On 400 real JSON files both parsers gave equal values,
  and the full suite (18,172 tests) passed.
- The repository bans the bare `JSON` global (biome `noRestrictedGlobals`), except in `plugins/**` and the YouTube
  extension. Use `SafeJSON`.

## 3. Why `SafeJSON.parse(text, { ffi: true })` would lose

`JSON.parse` = parsing (about a third) + building JS objects and strings (about two thirds). The 33 ms simdjson
number covers only the first part, in C memory that JS cannot use. To hand objects to a caller, something must
build them in the JS heap, and JSC does that inside `JSON.parse` in C++ with structure caching and string
atomization. Measured: an FFI tape plus a JS object builder is only as fast as `JSON.parse`, and about 20% faster
with a key cache. And `SafeJSON.parse` receives a string: encoding it back to bytes for C costs 24 to 28 ms, which
eats that 20%. So a general FFI flag would make every caller slower. Published results agree: the simdjson Node
binding's own issue #28 measured its object conversion at 4.756 s against 0.985 s for `JSON.parse`, and its
README says conversion to JS objects makes `simdjson.parse` slower; Hermes measurements found simdjson's gain eaten
by UTF-8 to UTF-16 transcoding.

## 4. When FFI JSON does pay

When the input is still BYTES (a file read) and the caller needs a few fields from many lines: the field pick was
26 ms against 148 ms for decode + `JSON.parse`, about 5.7 times less, and it skips the decode too. The Claude tail
usage (`src/claude/lib/usage/session-rows.ts`, `parseTailLines`) is such a reader: 267 of its 390 uncached ms are
`JSON.parse`, 54 ms decoding. It needs a C++ dependency (simdjson, vendored or installed), so it is a decision.

## 5. Cheaper without native code

- **Cache the result, not the parse.** The tail usage is cached per file identity (`caching-and-freshness.md`),
  so an unchanged transcript is never parsed again. That beat every parser.
- **Do not re-parse on a growing window.** The tail reader grows 64 KB → 128 KB → ... → 1 MB until it finds the
  last typed user message and re-parses the whole window each time. Parsing only the newly added older part is an
  exact saving.
- **A substring prefilter** (`line.includes('"type":"assistant"')` before `JSON.parse`) is common in real code
  (claude-mem, claudish). Risk: it depends on the serializer's exact byte form (no spaces). Locally 13,766
  transcripts use the compact form and 1 uses a spaced form, so a prefilter must fall back to a full parse, never
  skip silently. Measure it before trusting it.
- **A reviver does not filter cheaply**: Node issue 60247 reports a 10 to 50% slowdown with a reviver.

## 6. Research

`<notes vault>/Dev/Bun/2026-10-12-FasterJsonParse/` (docs and internals, GitHub benchmarks, lazy and partial parsing).
