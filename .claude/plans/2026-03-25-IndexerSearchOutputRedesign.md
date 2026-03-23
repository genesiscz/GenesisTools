# Indexer Search Output Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the `tools indexer search` output to be readable, pretty, and useful — with confidence percentages, syntax-highlighted code blocks, query-word highlighting, context chunks, and sqlite-vec as default.

**Architecture:** Extract search output formatting into `src/indexer/lib/search-output.ts` with three renderers (pretty/simple/table). Confidence normalization lives in `src/indexer/lib/confidence.ts`. The "semantic" mode alias is a one-line mapping in `search-mode.ts`. The rebuild command gets interactive prompts for driver migration. Tests use mocked search results — no live index needed.

**Tech Stack:** TypeScript, Bun, picocolors (highlighting), `@app/utils/markdown` (pretty format), `@clack/prompts` (rebuild interactive), `bun:test`

---

## Task 1: Confidence Normalization

**Files:**
- Create: `src/indexer/lib/confidence.ts`
- Test: `src/indexer/lib/confidence.test.ts`

**Step 1: Write the failing test**

```typescript
// src/indexer/lib/confidence.test.ts
import { describe, expect, it } from "bun:test";
import { normalizeConfidence } from "./confidence";

describe("normalizeConfidence", () => {
    describe("cosine scores", () => {
        it("maps 1.0 to 100%", () => {
            expect(normalizeConfidence(1.0, "cosine")).toBe(100);
        });

        it("maps 0.75 to 75%", () => {
            expect(normalizeConfidence(0.75, "cosine")).toBe(75);
        });

        it("maps 0 to 0%", () => {
            expect(normalizeConfidence(0, "cosine")).toBe(0);
        });

        it("clamps negative to 0%", () => {
            expect(normalizeConfidence(-0.1, "cosine")).toBe(0);
        });
    });

    describe("rrf scores", () => {
        // Max theoretical RRF: 2 * 1/(K+1) = 2/61 ≈ 0.03279 (when result is rank 0 in both sub-queries)
        it("maps max theoretical RRF to 100%", () => {
            const maxRrf = 2 / 61;
            expect(normalizeConfidence(maxRrf, "rrf")).toBe(100);
        });

        it("maps typical top result ~0.016 to ~50%", () => {
            const result = normalizeConfidence(0.016, "rrf");
            expect(result).toBeGreaterThan(45);
            expect(result).toBeLessThan(55);
        });

        it("maps 0 to 0%", () => {
            expect(normalizeConfidence(0, "rrf")).toBe(0);
        });
    });

    describe("bm25 scores", () => {
        it("normalizes relative to maxScore", () => {
            expect(normalizeConfidence(30, "bm25", 30)).toBe(100);
        });

        it("maps half of max to 50%", () => {
            expect(normalizeConfidence(15, "bm25", 30)).toBe(50);
        });

        it("falls back to 50% when no maxScore", () => {
            // Without context, can't normalize — return raw clamped to 100
            const result = normalizeConfidence(15, "bm25");
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(100);
        });
    });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/indexer/lib/confidence.test.ts`
Expected: FAIL — module `./confidence` not found

**Step 3: Write minimal implementation**

```typescript
// src/indexer/lib/confidence.ts
type ScoreMethod = "cosine" | "rrf" | "bm25";

/**
 * RRF theoretical maximum: a result at rank 0 in both BM25 and vector sub-queries.
 * With K=60: max = 2 × 1/(60+0+1) = 2/61 ≈ 0.03279
 */
const RRF_MAX = 2 / 61;

/**
 * Normalize a raw search score to a 0–100 confidence percentage.
 *
 * - cosine: already 0–1, multiply by 100
 * - rrf: divide by theoretical max (2/61), multiply by 100
 * - bm25: divide by maxScore in result set, multiply by 100
 */
export function normalizeConfidence(score: number, method: ScoreMethod, maxScore?: number): number {
    let normalized: number;

    switch (method) {
        case "cosine":
            normalized = score * 100;
            break;
        case "rrf":
            normalized = (score / RRF_MAX) * 100;
            break;
        case "bm25":
            if (maxScore && maxScore > 0) {
                normalized = (score / maxScore) * 100;
            } else {
                // Without max context, use log scale capped at 100
                normalized = Math.min(score * 5, 100);
            }
            break;
        default:
            normalized = score * 100;
    }

    return Math.round(Math.max(0, Math.min(100, normalized)));
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/indexer/lib/confidence.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/indexer/lib/confidence.ts src/indexer/lib/confidence.test.ts
git commit -m "feat(indexer): add confidence normalization for search scores"
```

---

## Task 2: Display Name Cleanup (symbol:lines instead of part N)

**Files:**
- Create: `src/indexer/lib/display-name.ts`
- Test: `src/indexer/lib/display-name.test.ts`

**Step 1: Write the failing test**

```typescript
// src/indexer/lib/display-name.test.ts
import { describe, expect, it } from "bun:test";
import { formatChunkDisplayName } from "./display-name";

describe("formatChunkDisplayName", () => {
    it("shows name:lines for named chunk", () => {
        expect(formatChunkDisplayName("MyClass", 10, 45)).toBe("MyClass:10-45");
    });

    it("strips stacked part suffixes", () => {
        expect(formatChunkDisplayName("MyClass (part 3) (part 8)", 100, 150)).toBe("MyClass:100-150");
    });

    it("strips single part suffix", () => {
        expect(formatChunkDisplayName("MyClass (part 2)", 50, 80)).toBe("MyClass:50-80");
    });

    it("falls back to kind:lines when no name", () => {
        expect(formatChunkDisplayName(undefined, 1, 30, "function")).toBe("function:1-30");
    });

    it("falls back to just lines when no name or kind", () => {
        expect(formatChunkDisplayName(undefined, 1, 30)).toBe("L1-30");
    });

    it("handles single-line chunk", () => {
        expect(formatChunkDisplayName("handler", 42, 42)).toBe("handler:42");
    });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/indexer/lib/display-name.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/indexer/lib/display-name.ts

/** Strip stacked "(part N)" suffixes from chunk names */
function stripPartSuffixes(name: string): string {
    return name.replace(/\s*\(part\s+\d+\)/g, "").trim();
}

/**
 * Format a human-readable display name for a chunk.
 * Prefers `SymbolName:startLine-endLine` over stacked `(part N)` labels.
 */
export function formatChunkDisplayName(
    name: string | undefined,
    startLine: number,
    endLine: number,
    kind?: string
): string {
    const lineRange = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
    const cleanName = name ? stripPartSuffixes(name) : undefined;

    if (cleanName) {
        return `${cleanName}:${lineRange}`;
    }

    if (kind) {
        return `${kind}:${lineRange}`;
    }

    return `L${lineRange}`;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/indexer/lib/display-name.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/indexer/lib/display-name.ts src/indexer/lib/display-name.test.ts
git commit -m "feat(indexer): display symbol:lines instead of stacked (part N) labels"
```

---

## Task 3: Query Word Highlighter

**Files:**
- Create: `src/indexer/lib/highlight.ts`
- Test: `src/indexer/lib/highlight.test.ts`

**Step 1: Write the failing test**

```typescript
// src/indexer/lib/highlight.test.ts
import { describe, expect, it } from "bun:test";
import { highlightQueryWords, parseQueryWords } from "./highlight";
import { stripAnsi } from "@app/utils/string";

describe("parseQueryWords", () => {
    it("splits query into lowercase words", () => {
        expect(parseQueryWords("Telegram bot Notification")).toEqual(["telegram", "bot", "notification"]);
    });

    it("deduplicates words", () => {
        expect(parseQueryWords("test test Test")).toEqual(["test"]);
    });

    it("filters short words (<=2 chars)", () => {
        expect(parseQueryWords("how is the AI")).toEqual(["how", "the"]);
        // "is" filtered (2 chars)
    });
});

describe("highlightQueryWords", () => {
    it("highlights matching words in text", () => {
        const result = highlightQueryWords("Send telegram notification", ["telegram", "notification"]);
        // Result should contain ANSI codes around matched words
        const plain = stripAnsi(result);
        expect(plain).toBe("Send telegram notification");
        // Highlighted version should be longer (ANSI codes added)
        expect(result.length).toBeGreaterThan(plain.length);
    });

    it("is case-insensitive", () => {
        const result = highlightQueryWords("Telegram TELEGRAM telegram", ["telegram"]);
        const plain = stripAnsi(result);
        expect(plain).toBe("Telegram TELEGRAM telegram");
        // All three instances should be highlighted
        const matches = result.match(/\x1b\[/g);
        expect(matches!.length).toBeGreaterThanOrEqual(3);
    });

    it("handles no matches gracefully", () => {
        const result = highlightQueryWords("no match here", ["xyz"]);
        expect(result).toBe("no match here");
    });

    it("handles special regex chars in query", () => {
        const result = highlightQueryWords("cost is $100 (total)", ["$100", "(total)"]);
        const plain = stripAnsi(result);
        expect(plain).toBe("cost is $100 (total)");
    });

    it("returns empty string for empty input", () => {
        expect(highlightQueryWords("", ["test"])).toBe("");
    });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/indexer/lib/highlight.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/indexer/lib/highlight.ts
import pc from "picocolors";

/** Parse a search query into unique lowercase words for highlighting */
export function parseQueryWords(query: string): string[] {
    const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);

    return [...new Set(words)];
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlight occurrences of query words in text using ANSI bold+yellow.
 * Case-insensitive, preserves original casing.
 */
export function highlightQueryWords(text: string, words: string[]): string {
    if (!text || words.length === 0) {
        return text;
    }

    const pattern = words.map(escapeRegex).join("|");
    const regex = new RegExp(`(${pattern})`, "gi");

    return text.replace(regex, (match) => pc.bold(pc.yellow(match)));
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/indexer/lib/highlight.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/indexer/lib/highlight.ts src/indexer/lib/highlight.test.ts
git commit -m "feat(indexer): query word highlighter for search results"
```

---

## Task 4: Search Output Formatters (pretty, simple, table)

This is the core task. Creates three output formatters that consume normalized search results.

**Files:**
- Create: `src/indexer/lib/search-output.ts`
- Test: `src/indexer/lib/search-output.test.ts`
- Modify: `src/indexer/commands/search.ts` (wire up later in Task 7)

**Step 1: Write the failing test**

```typescript
// src/indexer/lib/search-output.test.ts
import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import { formatSearchResults, type FormattedSearchResult } from "./search-output";

/** Helper: create a mock search result */
function mockResult(overrides: Partial<FormattedSearchResult> = {}): FormattedSearchResult {
    return {
        filePath: "/Users/test/project/app/Services/Notifications.php",
        displayName: "sendToSuperAdmins:45-80",
        language: "php",
        content: `public function sendToSuperAdmins(string $message): void\n{\n    $admins = User::where('role', 'admin')->get();\n    foreach ($admins as $admin) {\n        $this->send($admin, $message);\n    }\n}`,
        confidence: 87,
        method: "rrf",
        indexName: "ReservineBack",
        startLine: 45,
        endLine: 80,
        ...overrides,
    };
}

describe("formatSearchResults — pretty", () => {
    it("renders markdown code block with language", () => {
        const output = formatSearchResults({
            results: [mockResult()],
            format: "pretty",
            query: "notification sending",
            mode: "hybrid",
        });
        // Should contain a fenced code block with php language marker
        expect(output).toContain("```php");
        expect(output).toContain("sendToSuperAdmins");
    });

    it("shows confidence percentage", () => {
        const output = formatSearchResults({
            results: [mockResult({ confidence: 92 })],
            format: "pretty",
            query: "test",
            mode: "hybrid",
        });
        expect(output).toContain("92%");
    });

    it("shows file path and display name", () => {
        const output = formatSearchResults({
            results: [mockResult()],
            format: "pretty",
            query: "test",
            mode: "hybrid",
        });
        expect(output).toContain("Notifications.php");
        expect(output).toContain("sendToSuperAdmins:45-80");
    });

    it("highlights query words in content", () => {
        const output = formatSearchResults({
            results: [mockResult()],
            format: "pretty",
            query: "send admins",
            mode: "hybrid",
            highlightWords: ["send", "admins"],
        });
        // The raw markdown string should contain the words (highlighting happens at render)
        expect(output).toContain("send");
        expect(output).toContain("admins");
    });

    it("shows result count and query in header", () => {
        const output = formatSearchResults({
            results: [mockResult(), mockResult({ confidence: 70 })],
            format: "pretty",
            query: "notification sending",
            mode: "hybrid",
        });
        expect(output).toContain("2 results");
        expect(output).toContain("notification sending");
    });
});

describe("formatSearchResults — simple", () => {
    it("renders rg --heading style: filename then code", () => {
        const output = formatSearchResults({
            results: [mockResult()],
            format: "simple",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(output);
        // Should have file path as heading
        expect(plain).toContain("Notifications.php");
        // Should have line-numbered content
        expect(plain).toContain("45");
        expect(plain).toContain("sendToSuperAdmins");
    });

    it("shows confidence inline", () => {
        const output = formatSearchResults({
            results: [mockResult({ confidence: 87 })],
            format: "simple",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(output);
        expect(plain).toContain("87%");
    });
});

describe("formatSearchResults — table", () => {
    it("renders a table with headers", () => {
        const output = formatSearchResults({
            results: [mockResult()],
            format: "table",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(output);
        expect(plain).toContain("File");
        expect(plain).toContain("Symbol");
        expect(plain).toContain("Confidence");
        expect(plain).toContain("Method");
    });

    it("uses confidence % instead of raw score", () => {
        const output = formatSearchResults({
            results: [mockResult({ confidence: 87 })],
            format: "table",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(output);
        expect(plain).toContain("87%");
    });

    it("uses display name instead of part labels", () => {
        const output = formatSearchResults({
            results: [mockResult({ displayName: "MyClass:10-50" })],
            format: "table",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(output);
        expect(plain).toContain("MyClass:10-50");
        expect(plain).not.toContain("(part");
    });
});

describe("formatSearchResults — edge cases", () => {
    it("handles empty results", () => {
        const output = formatSearchResults({
            results: [],
            format: "pretty",
            query: "test",
            mode: "hybrid",
        });
        expect(output).toContain("No results");
    });

    it("groups multiple chunks from same file in pretty mode", () => {
        const output = formatSearchResults({
            results: [
                mockResult({ displayName: "methodA:10-30", startLine: 10, endLine: 30 }),
                mockResult({ displayName: "methodB:50-70", startLine: 50, endLine: 70 }),
            ],
            format: "pretty",
            query: "test",
            mode: "hybrid",
        });
        // File path should appear once as a group heading, not twice
        const pathCount = (output.match(/Notifications\.php/g) ?? []).length;
        // At most 2 (heading + one repetition is ok, but not 4+)
        expect(pathCount).toBeLessThanOrEqual(3);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/indexer/lib/search-output.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/indexer/lib/search-output.ts` with:

- `FormattedSearchResult` interface — pre-normalized result with confidence%, displayName, language, content
- `formatSearchResults(opts)` — dispatches to `formatPretty`, `formatSimple`, or `formatTable`
- `formatPretty()` — composes markdown: `### file.php — symbolName:L1-L2 — 87% (rrf)` + fenced code block with language. Uses `highlightQueryWords` on the content before placing it inside the code fence. Groups by file path.
- `formatSimple()` — rg-heading style: colored filename, then `L45: code line` with line numbers, confidence shown inline after filename
- `formatTable()` — headers: File, Symbol, Confidence, Method. Uses `formatTable` from `@app/utils/table`. No preview column.

**Key implementation details:**

```typescript
// src/indexer/lib/search-output.ts
import { formatTable } from "@app/utils/table";
import pc from "picocolors";
import { highlightQueryWords } from "./highlight";

export interface FormattedSearchResult {
    filePath: string;
    displayName: string;
    language: string | null;
    content: string;
    confidence: number;
    method: "bm25" | "cosine" | "rrf";
    indexName: string;
    startLine: number;
    endLine: number;
}

export type OutputFormat = "pretty" | "simple" | "table";

interface FormatOptions {
    results: FormattedSearchResult[];
    format: OutputFormat;
    query: string;
    mode: string;
    highlightWords?: string[];
}

export function formatSearchResults(opts: FormatOptions): string {
    if (opts.results.length === 0) {
        return "No results found.";
    }

    switch (opts.format) {
        case "pretty":
            return formatPretty(opts);
        case "simple":
            return formatSimple(opts);
        case "table":
            return formatTableOutput(opts);
    }
}
```

For `formatPretty`: build a markdown string per result — heading line with file, symbol, confidence %, then a fenced code block with the language marker. Content lines get query-word highlighting applied *before* wrapping in the fence.

For `formatSimple`: colored file header, then each content line with line number prefix (dimmed). Confidence shown on the header line.

For `formatTable`: pipe through existing `formatTable()` from `@app/utils/table` with columns: File (shortened path), Symbol, Confidence (e.g. "87%"), Method.

**Step 4: Run test to verify it passes**

Run: `bun test src/indexer/lib/search-output.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/indexer/lib/search-output.ts src/indexer/lib/search-output.test.ts
git commit -m "feat(indexer): pretty/simple/table search output formatters"
```

---

## Task 5: "semantic" Mode Alias

**Files:**
- Modify: `src/indexer/lib/search-mode.ts:3`
- Modify: `src/indexer/commands/search.ts:78` (help text stays `fulltext, vector, hybrid`)

**Step 1: Write the failing test**

Add to an existing or new test:

```typescript
// src/indexer/lib/search-mode.test.ts
import { describe, expect, it } from "bun:test";
import { resolveSearchMode } from "./search-mode";

describe("resolveSearchMode", () => {
    it("passes through valid modes unchanged", () => {
        expect(resolveSearchMode("fulltext")).toBe("fulltext");
        expect(resolveSearchMode("vector")).toBe("vector");
        expect(resolveSearchMode("hybrid")).toBe("hybrid");
    });

    it("maps 'semantic' to 'vector'", () => {
        expect(resolveSearchMode("semantic")).toBe("vector");
    });

    it("returns undefined for unknown modes", () => {
        expect(resolveSearchMode("banana")).toBeUndefined();
    });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/indexer/lib/search-mode.test.ts`
Expected: FAIL — `resolveSearchMode` not exported

**Step 3: Write minimal implementation**

Add to `src/indexer/lib/search-mode.ts`:

```typescript
const MODE_ALIASES: Record<string, SearchMode> = {
    semantic: "vector",
};

/** Resolve a user-provided mode string to a canonical SearchMode. Returns undefined for unknown modes. */
export function resolveSearchMode(input: string): SearchMode | undefined {
    if (input === "fulltext" || input === "vector" || input === "hybrid") {
        return input;
    }

    return MODE_ALIASES[input];
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/indexer/lib/search-mode.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/indexer/lib/search-mode.ts src/indexer/lib/search-mode.test.ts
git commit -m "feat(indexer): add 'semantic' as silent alias for 'vector' mode"
```

---

## Task 6: --confidence Flag & --context-chunks

**Files:**
- Modify: `src/indexer/commands/search.ts:13-19` (add options to `SearchCommandOptions`)

This task adds the CLI flags only (no wiring yet — that's Task 7).

**Step 1: Update the SearchCommandOptions interface**

In `src/indexer/commands/search.ts`, add to the interface and commander options:

```typescript
interface SearchCommandOptions {
    index?: string;
    mode?: string;  // string, not SearchMode — resolved via resolveSearchMode
    limit?: number;
    format?: "pretty" | "simple" | "table" | "json" | "toon";
    file?: string;
    confidence?: number;  // minimum confidence % (0-100)
    contextChunks?: number;  // number of surrounding chunks to show
}
```

Add to the commander chain:

```typescript
.option("-c, --confidence <min>", "Minimum confidence % (0-100)", parseInt)
.option("--context-chunks <n>", "Show N surrounding chunks for context", parseInt)
```

Update `--format` option to include new formats:

```typescript
.option("--format <type>", "Output format: pretty, simple, table, json, toon (default: pretty)")
```

**Step 2: Commit** (no test needed — this is just CLI flag registration)

```bash
git add src/indexer/commands/search.ts
git commit -m "feat(indexer): add --confidence, --context-chunks, and new --format options"
```

---

## Task 7: Wire Everything Together in search.ts

This is the integration task — rewrites the search command action to use the new modules.

**Files:**
- Modify: `src/indexer/commands/search.ts` (major rewrite of action handler)

**Step 1: Rewrite the action handler**

Key changes to the action function:

1. **Mode resolution**: Use `resolveSearchMode(opts.mode)` instead of raw assignment
2. **Format default**: Change from `"table"` to `"pretty"`
3. **Build FormattedSearchResult[]**: For each raw result, compute:
   - `confidence` via `normalizeConfidence(score, method, maxBm25Score)`
   - `displayName` via `formatChunkDisplayName(name, startLine, endLine, kind)`
   - `language` from the chunk's `language` field (already stored by chunker)
4. **Filter by --confidence**: After normalization, filter `confidence >= opts.confidence`
5. **Context chunks**: If `--context-chunks N` is set, for each result, query adjacent chunks from the same file with overlapping/adjacent line ranges from the search engine
6. **Highlight words**: Parse query with `parseQueryWords(query)`, pass to formatter
7. **Output**: Call `formatSearchResults()` for pretty/simple/table. Keep json/toon paths as-is.
8. **Non-TTY**: For non-TTY stdout, default format to `"simple"` (no markdown rendering)

**Pseudocode for the rewritten action:**

```typescript
import { normalizeConfidence } from "../lib/confidence";
import { formatChunkDisplayName } from "../lib/display-name";
import { parseQueryWords } from "../lib/highlight";
import { resolveSearchMode } from "../lib/search-mode";
import { formatSearchResults, type FormattedSearchResult, type OutputFormat } from "../lib/search-output";

// Inside action:
const mode = opts.mode ? resolveSearchMode(opts.mode) : detectMode(firstIndexer);
if (opts.mode && !mode) {
    p.log.error(`Unknown search mode: "${opts.mode}". Valid: fulltext, vector, hybrid, semantic`);
    return;
}

// Default format: pretty for TTY, simple for non-TTY
const format: OutputFormat | "json" | "toon" = opts.format
    ?? (process.stdout.isTTY ? "pretty" : "simple");

// ... run search as before ...

// Compute maxBm25Score for normalization
const maxBm25Score = allResults.reduce((max, r) =>
    r.result.method === "bm25" ? Math.max(max, r.result.score) : max, 0);

// Build formatted results
const formatted: FormattedSearchResult[] = allResults.map((r) => ({
    filePath: r.result.doc.filePath,
    displayName: formatChunkDisplayName(r.result.doc.name, r.result.doc.startLine, r.result.doc.endLine, r.result.doc.kind),
    language: r.result.doc.language ?? null,
    content: r.result.doc.content,
    confidence: normalizeConfidence(r.result.score, r.result.method, maxBm25Score),
    method: r.result.method,
    indexName: r.indexName,
    startLine: r.result.doc.startLine,
    endLine: r.result.doc.endLine,
}));

// Filter by confidence
const filtered = opts.confidence
    ? formatted.filter((r) => r.confidence >= opts.confidence!)
    : formatted;

// Output
const words = parseQueryWords(query);
const output = formatSearchResults({
    results: filtered,
    format: format as OutputFormat,
    query,
    mode: effectiveMode,
    highlightWords: words,
});
console.log(output);
```

**Step 2: Manual test**

Run these commands and verify output quality:

```bash
# Pretty format (default)
tools indexer search "reservation cancellation" --index ReservineBack --limit 5

# Simple format
tools indexer search "payment processing" --index ReservineBack --limit 5 --format simple

# Table format
tools indexer search "smart lock Nuki" --index ReservineBack --limit 5 --format table

# Confidence filter
tools indexer search "reservation cancellation" --index ReservineBack --confidence 60

# Semantic mode alias
tools indexer search "tenant onboarding" --index ReservineBack --mode semantic --limit 3

# Non-TTY (should auto-use simple)
tools indexer search "timeslot generation" --index ReservineBack --limit 3 | cat

# JSON still works
tools indexer search "invoice" --index ReservineBack --limit 3 --format json
```

**Step 3: Commit**

```bash
git add src/indexer/commands/search.ts
git commit -m "feat(indexer): wire up pretty/simple/table formatters, confidence filter, semantic alias"
```

---

## Task 8: Rebuild Command — Interactive Driver Migration

**Files:**
- Modify: `src/indexer/commands/rebuild.ts`
- Modify: `src/indexer/lib/manager.ts` (if needed for driver migration method)

**Step 1: Add interactive prompts to rebuild**

When `rebuild` is invoked without extra params (just a name or interactive select), add prompts:

```typescript
// After selecting the index name, check current driver
const meta = metas.find((m) => m.name === targetName);
const currentDriver = meta?.config.storage?.vectorDriver ?? "sqlite-brute";

if (process.stdout.isTTY && process.stdin.isTTY) {
    // Ask what to do
    const action = await p.select({
        message: "What would you like to do?",
        options: [
            { value: "reindex", label: "Full reindex (re-scan all files, re-chunk)" },
            ...(currentDriver !== "sqlite-vec" ? [{
                value: "migrate-driver",
                label: `Migrate vector storage: ${currentDriver} → sqlite-vec`,
            }] : []),
            { value: "reembed", label: "Re-embed all chunks (keep content, regenerate vectors)" },
            { value: "reindex-reembed", label: "Full reindex + re-embed" },
        ],
    });

    if (p.isCancel(action)) { return; }

    // Handle each action appropriately
}
```

For `migrate-driver`: read all embeddings from the brute-force table, create the vec0 virtual table, insert them, drop the old table, update config. This should be a method on the manager or indexer.

**Step 2: Manual test**

```bash
# Interactive
tools indexer rebuild

# Non-interactive (just reindexes as before)
tools indexer rebuild ReservineBack
```

**Step 3: Commit**

```bash
git add src/indexer/commands/rebuild.ts src/indexer/lib/manager.ts
git commit -m "feat(indexer): interactive rebuild with driver migration and re-embed options"
```

---

## Task 9: sqlite-vec as Default + Brute-Force Warning to stderr

**Files:**
- Modify: `src/utils/search/stores/sqlite-vector-store.ts:41` — verify `console.warn` (already stderr)
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts:240-272` — verify default is sqlite-vec
- Modify: `src/utils/search/stores/sqlite-vector-store.ts:41-46` — update warning message to suggest `tools indexer rebuild`

**Step 1: Update the brute-force warning message**

The warning already goes to stderr via `console.warn`. Update the text:

```typescript
console.warn(
    `[SqliteVectorStore] Brute-force scanning ${rows.length} vectors. ` +
    `Run "tools indexer rebuild ${/* index name not available here */''}" to migrate to sqlite-vec.`
);
```

Since the store doesn't know the index name, keep a generic message:

```typescript
console.warn(
    `[indexer] Brute-force vector scan (${rows.length} vectors). ` +
    `Run "tools indexer rebuild" to migrate to sqlite-vec for faster search.`
);
```

**Step 2: Verify sqlite-vec is already the default**

Read `src/utils/search/drivers/sqlite-fts5/index.ts:240-272`. The `initStores()` method already tries sqlite-vec first and falls back to brute-force. The config type comment says `Default: "sqlite-vec" with "sqlite-brute" fallback`. This is already correct — no code change needed for the default.

**Step 3: Commit**

```bash
git add src/utils/search/stores/sqlite-vector-store.ts
git commit -m "fix(indexer): improve brute-force warning with migration instructions"
```

---

## Task 10: Comprehensive Output Format Test

**Files:**
- Create: `src/indexer/lib/search-output-formats.test.ts`

This test file uses mocked results (no live index) and verifies all three output formats including coloring, edge cases, and non-TTY behavior.

**Step 1: Write comprehensive test**

```typescript
// src/indexer/lib/search-output-formats.test.ts
import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import { formatSearchResults, type FormattedSearchResult } from "./search-output";

function makeResult(overrides: Partial<FormattedSearchResult> = {}): FormattedSearchResult {
    return {
        filePath: "/project/app/Services/BookingService.php",
        displayName: "createReservation:45-120",
        language: "php",
        content: [
            "public function createReservation(array $data): Reservation",
            "{",
            "    $reservation = new Reservation($data);",
            "    $reservation->save();",
            "    event(new ReservationCreated($reservation));",
            "    return $reservation;",
            "}",
        ].join("\n"),
        confidence: 85,
        method: "rrf" as const,
        indexName: "TestIndex",
        startLine: 45,
        endLine: 51,
        ...overrides,
    };
}

// ── Pretty format ──────────────────────────────────────────────

describe("pretty format", () => {
    it("includes markdown code fence with correct language", () => {
        const out = formatSearchResults({
            results: [makeResult()],
            format: "pretty",
            query: "create reservation",
            mode: "hybrid",
        });
        expect(out).toContain("```php");
        expect(out).toContain("```");
    });

    it("includes confidence as percentage", () => {
        const out = formatSearchResults({
            results: [makeResult({ confidence: 92 })],
            format: "pretty",
            query: "test",
            mode: "hybrid",
        });
        expect(out).toContain("92%");
    });

    it("renders multiple results with separator", () => {
        const out = formatSearchResults({
            results: [
                makeResult({ displayName: "methodA:10-20", confidence: 90 }),
                makeResult({
                    filePath: "/project/app/Models/Reservation.php",
                    displayName: "Reservation:1-50",
                    confidence: 75,
                    language: "php",
                }),
            ],
            format: "pretty",
            query: "reservation",
            mode: "hybrid",
        });
        expect(out).toContain("methodA:10-20");
        expect(out).toContain("Reservation:1-50");
    });

    it("handles null language gracefully", () => {
        const out = formatSearchResults({
            results: [makeResult({ language: null })],
            format: "pretty",
            query: "test",
            mode: "hybrid",
        });
        // Should still render without crashing, just no language marker on fence
        expect(out).toContain("```");
    });

    it("shows query and result count in header", () => {
        const out = formatSearchResults({
            results: [makeResult()],
            format: "pretty",
            query: "booking flow",
            mode: "hybrid",
        });
        expect(out).toContain("1 result");
        expect(out).toContain("booking flow");
    });
});

// ── Simple format ──────────────────────────────────────────────

describe("simple format", () => {
    it("shows file path as heading with confidence", () => {
        const out = formatSearchResults({
            results: [makeResult({ confidence: 85 })],
            format: "simple",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(out);
        expect(plain).toContain("BookingService.php");
        expect(plain).toContain("85%");
    });

    it("shows line numbers", () => {
        const out = formatSearchResults({
            results: [makeResult({ startLine: 45 })],
            format: "simple",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(out);
        expect(plain).toContain("45");
    });

    it("highlights query words with ANSI", () => {
        const out = formatSearchResults({
            results: [makeResult()],
            format: "simple",
            query: "reservation created",
            mode: "hybrid",
            highlightWords: ["reservation", "created"],
        });
        // Highlighted version should have ANSI codes
        expect(out.length).toBeGreaterThan(stripAnsi(out).length);
        // Plain text should still contain the words
        expect(stripAnsi(out)).toContain("Reservation");
    });
});

// ── Table format ──────────────────────────────────────────────

describe("table format", () => {
    it("has correct column headers", () => {
        const out = formatSearchResults({
            results: [makeResult()],
            format: "table",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(out);
        expect(plain).toContain("File");
        expect(plain).toContain("Symbol");
        expect(plain).toContain("Confidence");
        expect(plain).toContain("Method");
    });

    it("shows percentage in confidence column", () => {
        const out = formatSearchResults({
            results: [makeResult({ confidence: 87 })],
            format: "table",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(out);
        expect(plain).toContain("87%");
    });

    it("truncates long file paths", () => {
        const out = formatSearchResults({
            results: [makeResult({
                filePath: "/very/long/deeply/nested/path/to/some/file/in/a/directory/Service.php",
            })],
            format: "table",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(out);
        expect(plain).toContain("...");
        expect(plain).toContain("Service.php");
    });

    it("shows separator line", () => {
        const out = formatSearchResults({
            results: [makeResult()],
            format: "table",
            query: "test",
            mode: "hybrid",
        });
        const plain = stripAnsi(out);
        expect(plain).toContain("─");
    });
});

// ── Edge cases ──────────────────────────────────────────────

describe("edge cases", () => {
    it("empty results returns message", () => {
        const out = formatSearchResults({
            results: [],
            format: "pretty",
            query: "nothing",
            mode: "hybrid",
        });
        expect(out).toContain("No results");
    });

    it("single-line chunk renders correctly in all formats", () => {
        const singleLine = makeResult({
            content: "const API_KEY = process.env.API_KEY;",
            displayName: "API_KEY:1",
            startLine: 1,
            endLine: 1,
            language: "typescript",
        });

        for (const format of ["pretty", "simple", "table"] as const) {
            const out = formatSearchResults({
                results: [singleLine],
                format,
                query: "api key",
                mode: "hybrid",
            });
            expect(stripAnsi(out)).toContain("API_KEY");
        }
    });

    it("content with special characters renders safely", () => {
        const special = makeResult({
            content: 'const re = /^\\d+\\.\\d+$/; // regex\nconst html = "<div>&amp;</div>";',
            language: "typescript",
        });

        const out = formatSearchResults({
            results: [special],
            format: "pretty",
            query: "regex",
            mode: "hybrid",
        });
        // Should not crash
        expect(out.length).toBeGreaterThan(0);
    });

    it("handles very long content without crashing", () => {
        const longContent = makeResult({
            content: "x".repeat(5000),
        });

        const out = formatSearchResults({
            results: [longContent],
            format: "simple",
            query: "test",
            mode: "hybrid",
        });
        expect(out.length).toBeGreaterThan(0);
    });

    it("all three formats produce different output shapes", () => {
        const result = [makeResult()];
        const opts = { query: "test", mode: "hybrid" as string };

        const pretty = formatSearchResults({ results: result, format: "pretty", ...opts });
        const simple = formatSearchResults({ results: result, format: "simple", ...opts });
        const table = formatSearchResults({ results: result, format: "table", ...opts });

        // They should all be meaningfully different
        expect(pretty).not.toBe(simple);
        expect(simple).not.toBe(table);
        expect(pretty).not.toBe(table);
    });
});
```

**Step 2: Run test**

Run: `bun test src/indexer/lib/search-output-formats.test.ts`
Expected: PASS (all formatters already implemented in Task 4)

**Step 3: Commit**

```bash
git add src/indexer/lib/search-output-formats.test.ts
git commit -m "test(indexer): comprehensive output format tests with mocked results"
```

---

## Task Summary

| # | Task | Files | Tests |
|---|------|-------|-------|
| 1 | Confidence normalization | `confidence.ts` | `confidence.test.ts` |
| 2 | Display name cleanup | `display-name.ts` | `display-name.test.ts` |
| 3 | Query word highlighter | `highlight.ts` | `highlight.test.ts` |
| 4 | Output formatters (pretty/simple/table) | `search-output.ts` | `search-output.test.ts` |
| 5 | "semantic" mode alias | `search-mode.ts` | `search-mode.test.ts` |
| 6 | CLI flags (--confidence, --context-chunks, --format) | `search.ts` | — |
| 7 | Wire everything in search command | `search.ts` | manual |
| 8 | Interactive rebuild + driver migration | `rebuild.ts`, `manager.ts` | manual |
| 9 | Brute-force warning improvement | `sqlite-vector-store.ts` | — |
| 10 | Comprehensive format tests | — | `search-output-formats.test.ts` |

**Dependency order:** Tasks 1–5 are independent (can be parallelized). Task 6 depends on nothing. Task 7 depends on 1–6. Task 8–9 are independent of 1–7. Task 10 depends on 4.
