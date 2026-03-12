# DarwinKit CLI Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `tools darwinkit` — an interactive CLI that exposes all DarwinKit capabilities (NLP, Vision, TTS, Auth, iCloud, System) through clack prompts and flat commander subcommands, with `--format json|pretty|raw` output control.

**Architecture:** Two phases: (1) Expand `src/utils/macos/` with missing util wrappers (auth, system, icloud), (2) Build `src/darwinkit/` CLI tool with a single command registry map that drives commander subcommands, interactive clack prompts, and help generation. The CLI never imports from `@genesiscz/darwinkit` directly — only from utils.

**Tech Stack:** @genesiscz/darwinkit, @clack/prompts, commander, picocolors, Bun

---

## Phase 1: Expand Utils

### Task 1: Add `src/utils/macos/auth.ts`

**Files:**
- Create: `src/utils/macos/auth.ts`
- Modify: `src/utils/macos/types.ts`
- Modify: `src/utils/macos/index.ts`

**Step 1: Create auth.ts**

```typescript
import { getDarwinKit } from "./darwinkit";
import type { AuthAvailableResult, AuthenticateResult } from "./types";

/**
 * Check if biometric authentication (Touch ID / Optic ID) is available.
 */
export async function checkBiometry(): Promise<AuthAvailableResult> {
    return getDarwinKit().auth.available();
}

/**
 * Authenticate using biometrics (Touch ID / Optic ID).
 * @param reason - Reason string shown in the system prompt
 */
export async function authenticate(reason?: string): Promise<AuthenticateResult> {
    return getDarwinKit().auth.authenticate(reason ? { reason } : undefined);
}
```

**Step 2: Add type re-exports to types.ts**

Add to the re-export block in `src/utils/macos/types.ts`:

```typescript
export type {
    AuthAvailableResult,
    AuthenticateResult,
    BiometryType,
} from "@genesiscz/darwinkit";
```

**Step 3: Add exports to index.ts**

Add to `src/utils/macos/index.ts`:

```typescript
// Auth
export { authenticate, checkBiometry } from "./auth";
```

And to the type exports:

```typescript
    AuthAvailableResult,
    AuthenticateResult,
    BiometryType,
```

**Step 4: Verify**

Run: `tsgo --noEmit 2>&1 | rg "utils/macos"`
Expected: zero errors

**Step 5: Commit**

```bash
git add src/utils/macos/auth.ts src/utils/macos/types.ts src/utils/macos/index.ts
git commit -m "feat(macos): add auth util wrappers"
```

---

### Task 2: Add `src/utils/macos/system.ts`

**Files:**
- Create: `src/utils/macos/system.ts`
- Modify: `src/utils/macos/types.ts`
- Modify: `src/utils/macos/index.ts`

**Step 1: Create system.ts**

```typescript
import { getDarwinKit } from "./darwinkit";
import type { CapabilitiesResult } from "./types";

/**
 * Get DarwinKit system capabilities — version, OS, architecture, available methods.
 */
export async function getCapabilities(): Promise<CapabilitiesResult> {
    return getDarwinKit().system.capabilities();
}
```

**Step 2: Add type re-exports to types.ts**

Add `MethodCapability` to the re-export block:

```typescript
export type { MethodCapability } from "@genesiscz/darwinkit";
```

(`CapabilitiesResult` is already re-exported.)

**Step 3: Add exports to index.ts**

```typescript
// System
export { getCapabilities } from "./system";
```

And to type exports:

```typescript
    MethodCapability,
```

**Step 4: Verify**

Run: `tsgo --noEmit 2>&1 | rg "utils/macos"`
Expected: zero errors

**Step 5: Commit**

```bash
git add src/utils/macos/system.ts src/utils/macos/types.ts src/utils/macos/index.ts
git commit -m "feat(macos): add system util wrapper"
```

---

### Task 3: Add `src/utils/macos/icloud.ts`

**Files:**
- Create: `src/utils/macos/icloud.ts`
- Modify: `src/utils/macos/types.ts`
- Modify: `src/utils/macos/index.ts`

**Step 1: Create icloud.ts**

```typescript
import { getDarwinKit } from "./darwinkit";
import type {
    ICloudDirEntry,
    ICloudListDirResult,
    ICloudOkResult,
    ICloudReadResult,
    ICloudStatusResult,
} from "./types";

/**
 * Check iCloud Drive availability and container URL.
 */
export async function icloudStatus(): Promise<ICloudStatusResult> {
    return getDarwinKit().icloud.status();
}

/**
 * Read a text file from iCloud Drive.
 * @param path - Relative path within the iCloud container
 */
export async function icloudRead(path: string): Promise<ICloudReadResult> {
    return getDarwinKit().icloud.read({ path });
}

/**
 * Write a text file to iCloud Drive.
 */
export async function icloudWrite(path: string, content: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.write({ path, content });
}

/**
 * Write binary data (base64-encoded) to iCloud Drive.
 */
export async function icloudWriteBytes(path: string, data: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.writeBytes({ path, data });
}

/**
 * Delete a file from iCloud Drive.
 */
export async function icloudDelete(path: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.delete({ path });
}

/**
 * Move/rename a file in iCloud Drive.
 */
export async function icloudMove(source: string, destination: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.move({ source, destination });
}

/**
 * Copy a file in iCloud Drive.
 */
export async function icloudCopy(source: string, destination: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.copyFile({ source, destination });
}

/**
 * List directory contents in iCloud Drive.
 */
export async function icloudList(path: string): Promise<ICloudDirEntry[]> {
    const result: ICloudListDirResult = await getDarwinKit().icloud.listDir({ path });
    return result.entries;
}

/**
 * Create a directory in iCloud Drive (recursive).
 */
export async function icloudMkdir(path: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.ensureDir({ path });
}

/**
 * Start monitoring iCloud Drive for file changes.
 * Use `getDarwinKit().icloud.onFilesChanged(handler)` to listen for changes.
 */
export async function icloudStartMonitoring(): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.startMonitoring();
}

/**
 * Stop monitoring iCloud Drive for file changes.
 */
export async function icloudStopMonitoring(): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.stopMonitoring();
}
```

**Step 2: Add type re-exports to types.ts**

```typescript
export type {
    ICloudDirEntry,
    ICloudListDirResult,
    ICloudOkResult,
    ICloudReadResult,
    ICloudStatusResult,
} from "@genesiscz/darwinkit";
```

**Step 3: Add exports to index.ts**

```typescript
// iCloud
export {
    icloudCopy,
    icloudDelete,
    icloudList,
    icloudMkdir,
    icloudMove,
    icloudRead,
    icloudStartMonitoring,
    icloudStatus,
    icloudStopMonitoring,
    icloudWrite,
    icloudWriteBytes,
} from "./icloud";
```

And type exports:

```typescript
    ICloudDirEntry,
    ICloudListDirResult,
    ICloudOkResult,
    ICloudReadResult,
    ICloudStatusResult,
```

**Step 4: Verify**

Run: `tsgo --noEmit 2>&1 | rg "utils/macos"`
Expected: zero errors

Run: `bunx biome check src/utils/macos/ --write`

**Step 5: Commit**

```bash
git add src/utils/macos/icloud.ts src/utils/macos/types.ts src/utils/macos/index.ts
git commit -m "feat(macos): add icloud util wrappers"
```

---

## Phase 2: CLI Tool

### Task 4: Create output formatter (`src/darwinkit/lib/format.ts`)

**Files:**
- Create: `src/darwinkit/lib/format.ts`

**Step 1: Create format.ts**

```typescript
import pc from "picocolors";

export type OutputFormat = "json" | "pretty" | "raw";

/**
 * Detect default format: pretty for TTY, json for piped
 */
export function defaultFormat(): OutputFormat {
    return process.stdout.isTTY ? "pretty" : "json";
}

/**
 * Format any result for output
 */
export function formatOutput(data: unknown, format: OutputFormat): string {
    switch (format) {
        case "json":
            return JSON.stringify(data, null, 2);
        case "raw":
            return formatRaw(data);
        case "pretty":
            return formatPretty(data);
    }
}

function formatRaw(data: unknown): string {
    if (data === null || data === undefined) {
        return "";
    }

    if (typeof data === "string") {
        return data;
    }

    if (typeof data === "number" || typeof data === "boolean") {
        return String(data);
    }

    if (Array.isArray(data)) {
        return data.map((item) => formatRaw(item)).join("\n");
    }

    // For objects with a single obvious "value" field, extract it
    if (typeof data === "object") {
        const obj = data as Record<string, unknown>;

        // Common single-value results
        if ("text" in obj && Object.keys(obj).length <= 2) {
            return String(obj.text);
        }

        if ("content" in obj && Object.keys(obj).length <= 1) {
            return String(obj.content);
        }

        // Fall back to JSON for complex objects
        return JSON.stringify(data, null, 2);
    }

    return String(data);
}

function formatPretty(data: unknown): string {
    if (data === null || data === undefined) {
        return pc.dim("(empty)");
    }

    if (typeof data === "string") {
        return data;
    }

    if (typeof data === "number" || typeof data === "boolean") {
        return pc.cyan(String(data));
    }

    if (Array.isArray(data)) {
        if (data.length === 0) {
            return pc.dim("(empty array)");
        }

        // Array of objects → table-like output
        if (typeof data[0] === "object" && data[0] !== null) {
            return data
                .map((item, i) => {
                    const prefix = pc.dim(`[${i}] `);
                    const fields = Object.entries(item as Record<string, unknown>)
                        .map(([k, v]) => `  ${pc.bold(k)}: ${formatValue(v)}`)
                        .join("\n");
                    return `${prefix}\n${fields}`;
                })
                .join("\n");
        }

        return data.map((item) => `  ${formatValue(item)}`).join("\n");
    }

    if (typeof data === "object") {
        const obj = data as Record<string, unknown>;
        return Object.entries(obj)
            .map(([k, v]) => `${pc.bold(k)}: ${formatValue(v)}`)
            .join("\n");
    }

    return String(data);
}

function formatValue(value: unknown): string {
    if (value === null || value === undefined) {
        return pc.dim("null");
    }

    if (typeof value === "string") {
        return pc.green(`"${value}"`);
    }

    if (typeof value === "number") {
        return pc.cyan(String(value));
    }

    if (typeof value === "boolean") {
        return value ? pc.green("true") : pc.red("false");
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return pc.dim("[]");
        }

        if (value.length <= 5 && value.every((v) => typeof v !== "object")) {
            return `[${value.map((v) => formatValue(v)).join(", ")}]`;
        }

        return `[${value.length} items]`;
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    return String(value);
}
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "darwinkit"`
Expected: zero errors

**Step 3: Commit**

```bash
git add src/darwinkit/lib/format.ts
git commit -m "feat(darwinkit): add output formatter"
```

---

### Task 5: Create command registry (`src/darwinkit/lib/commands.ts`)

**Files:**
- Create: `src/darwinkit/lib/commands.ts`

This is the single source of truth. It imports all utils and maps them to CLI commands.

**Step 1: Create commands.ts**

```typescript
import {
    analyzeSentiment,
    areSimilar,
    authenticate,
    batchSentiment,
    checkBiometry,
    classifyText,
    clusterBySimilarity,
    deduplicateTexts,
    detectLanguage,
    embedText,
    extractEntities,
    extractText,
    findNeighbors,
    getCapabilities,
    getKeywords,
    groupByLanguage,
    icloudCopy,
    icloudDelete,
    icloudList,
    icloudMkdir,
    icloudMove,
    icloudRead,
    icloudStatus,
    icloudWrite,
    lemmatize,
    listVoices,
    rankBySimilarity,
    recognizeText,
    scoreRelevance,
    speak,
    tagText,
    textDistance,
} from "@app/utils/macos";
import type { EmbedType, NlpScheme, OcrLevel } from "@app/utils/macos";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ParamDef {
    name: string;
    type: "string" | "number" | "boolean" | "string[]";
    required: boolean;
    description: string;
    default?: unknown;
    /** If true, this is the first positional argument (not a flag) */
    positional?: boolean;
    /** For select prompts in interactive mode */
    choices?: string[];
}

export interface CommandDef {
    /** CLI subcommand name, e.g. "detect-language" */
    name: string;
    /** Interactive menu group, e.g. "nlp" */
    group: string;
    /** One-line description for help & interactive menu */
    description: string;
    /** Parameter definitions — drive help, validation, and interactive prompts */
    params: ParamDef[];
    /** Execute the command. Receives validated args, returns result to be formatted. */
    run: (args: Record<string, unknown>) => Promise<unknown>;
}

// ─── Group Labels ───────────────────────────────────────────────────────────────

export const GROUP_LABELS: Record<string, string> = {
    nlp: "Natural Language Processing",
    vision: "Computer Vision",
    "text-analysis": "Text Analysis (batch)",
    classification: "Classification",
    tts: "Text-to-Speech",
    auth: "Authentication",
    icloud: "iCloud Drive",
    system: "System",
};

export const GROUP_ORDER = ["nlp", "vision", "text-analysis", "classification", "tts", "auth", "icloud", "system"];

// ─── Command Registry ───────────────────────────────────────────────────────────

export const commands: CommandDef[] = [
    // ── NLP ──────────────────────────────────────────────────────────────────
    {
        name: "detect-language",
        group: "nlp",
        description: "Detect the language of text (BCP-47 code + confidence)",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to analyze" },
        ],
        run: async (args) => detectLanguage(args.text as string),
    },
    {
        name: "sentiment",
        group: "nlp",
        description: "Analyze sentiment — score (-1 to 1) and label",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to analyze" },
        ],
        run: async (args) => analyzeSentiment(args.text as string),
    },
    {
        name: "tag",
        group: "nlp",
        description: "Tag text with POS, NER, lemma, or other schemes",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to tag" },
            {
                name: "schemes",
                type: "string[]",
                required: false,
                description: "Tagging schemes",
                default: ["lexicalClass"],
                choices: ["lexicalClass", "nameType", "lemma", "sentimentScore", "language"],
            },
            { name: "language", type: "string", required: false, description: "BCP-47 language code" },
        ],
        run: async (args) =>
            tagText(
                args.text as string,
                (args.schemes as NlpScheme[] | undefined) ?? ["lexicalClass"],
                args.language as string | undefined
            ),
    },
    {
        name: "entities",
        group: "nlp",
        description: "Extract named entities (people, places, organizations)",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to analyze" },
        ],
        run: async (args) => extractEntities(args.text as string),
    },
    {
        name: "lemmatize",
        group: "nlp",
        description: "Get root/dictionary form of each word",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to lemmatize" },
            { name: "language", type: "string", required: false, description: "BCP-47 language code" },
        ],
        run: async (args) => lemmatize(args.text as string, args.language as string | undefined),
    },
    {
        name: "keywords",
        group: "nlp",
        description: "Extract important content words (nouns, verbs, adjectives)",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to analyze" },
            { name: "max", type: "number", required: false, description: "Max keywords to return", default: 10 },
        ],
        run: async (args) => getKeywords(args.text as string, (args.max as number) ?? 10),
    },
    {
        name: "embed",
        group: "nlp",
        description: "Compute 512-dim semantic embedding vector",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to embed" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
            {
                name: "type",
                type: "string",
                required: false,
                description: "Embedding type",
                default: "sentence",
                choices: ["word", "sentence"],
            },
        ],
        run: async (args) =>
            embedText(args.text as string, (args.language as string) ?? "en", (args.type as EmbedType) ?? "sentence"),
    },
    {
        name: "distance",
        group: "nlp",
        description: "Compute cosine distance between two texts (0 = identical, 2 = opposite)",
        params: [
            { name: "text1", type: "string", required: true, positional: true, description: "First text" },
            { name: "text2", type: "string", required: true, positional: true, description: "Second text" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) =>
            textDistance(args.text1 as string, args.text2 as string, (args.language as string) ?? "en"),
    },
    {
        name: "similar",
        group: "nlp",
        description: "Check if two texts are semantically similar (boolean)",
        params: [
            { name: "text1", type: "string", required: true, positional: true, description: "First text" },
            { name: "text2", type: "string", required: true, positional: true, description: "Second text" },
            { name: "threshold", type: "number", required: false, description: "Distance threshold", default: 0.5 },
        ],
        run: async (args) =>
            areSimilar(args.text1 as string, args.text2 as string, (args.threshold as number) ?? 0.5),
    },
    {
        name: "relevance",
        group: "nlp",
        description: "Score semantic relevance of text against a query (0-1)",
        params: [
            { name: "query", type: "string", required: true, positional: true, description: "Query text" },
            { name: "text", type: "string", required: true, positional: true, description: "Text to score" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) =>
            scoreRelevance(args.query as string, args.text as string, (args.language as string) ?? "en"),
    },
    {
        name: "neighbors",
        group: "nlp",
        description: "Find semantically similar words or sentences",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Input text" },
            { name: "count", type: "number", required: false, description: "Number of neighbors", default: 5 },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
            {
                name: "type",
                type: "string",
                required: false,
                description: "Embed type",
                default: "word",
                choices: ["word", "sentence"],
            },
        ],
        run: async (args) =>
            findNeighbors(
                args.text as string,
                (args.count as number) ?? 5,
                (args.language as string) ?? "en",
                (args.type as EmbedType) ?? "word"
            ),
    },

    // ── Vision ───────────────────────────────────────────────────────────────
    {
        name: "ocr",
        group: "vision",
        description: "Extract text from an image file using Apple Vision",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "Path to image file" },
            {
                name: "languages",
                type: "string[]",
                required: false,
                description: "Recognition languages",
                default: ["en-US"],
            },
            {
                name: "level",
                type: "string",
                required: false,
                description: "Recognition level",
                default: "accurate",
                choices: ["accurate", "fast"],
            },
            {
                name: "text-only",
                type: "boolean",
                required: false,
                description: "Return plain text only (no bounding boxes)",
                default: false,
            },
        ],
        run: async (args) => {
            const path = args.path as string;
            const options = {
                languages: args.languages as string[] | undefined,
                level: (args.level as OcrLevel) ?? "accurate",
            };

            if (args["text-only"]) {
                return extractText(path, options);
            }

            return recognizeText(path, options);
        },
    },

    // ── Text Analysis (batch) ────────────────────────────────────────────────
    {
        name: "rank",
        group: "text-analysis",
        description: "Rank texts by semantic similarity to a query",
        params: [
            { name: "query", type: "string", required: true, positional: true, description: "Query to rank against" },
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to rank (comma-separated or multiple --items flags)",
            },
            { name: "max-results", type: "number", required: false, description: "Max results to return" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text, i) => ({ text, id: String(i) }));
            return rankBySimilarity(args.query as string, items, {
                language: (args.language as string) ?? "en",
                maxResults: args["max-results"] as number | undefined,
            });
        },
    },
    {
        name: "batch-sentiment",
        group: "text-analysis",
        description: "Analyze sentiment for multiple texts",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to analyze (comma-separated)",
            },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text, i) => ({ text, id: String(i) }));
            return batchSentiment(items);
        },
    },
    {
        name: "group-by-language",
        group: "text-analysis",
        description: "Detect language for each text and group by language code",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to group (comma-separated)",
            },
            {
                name: "min-confidence",
                type: "number",
                required: false,
                description: "Min confidence threshold",
                default: 0.7,
            },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text, i) => ({ text, id: String(i) }));
            return groupByLanguage(items, {
                minConfidence: (args["min-confidence"] as number) ?? 0.7,
            });
        },
    },
    {
        name: "deduplicate",
        group: "text-analysis",
        description: "Remove semantically duplicate texts",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to deduplicate (comma-separated)",
            },
            {
                name: "threshold",
                type: "number",
                required: false,
                description: "Cosine distance threshold",
                default: 0.3,
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text) => ({ text }));
            const result = await deduplicateTexts(items, {
                threshold: (args.threshold as number) ?? 0.3,
                language: (args.language as string) ?? "en",
            });
            return result.map((r) => r.text);
        },
    },
    {
        name: "cluster",
        group: "text-analysis",
        description: "Group semantically similar texts into clusters",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to cluster (comma-separated)",
            },
            {
                name: "threshold",
                type: "number",
                required: false,
                description: "Distance threshold for same cluster",
                default: 0.5,
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text) => ({ text }));
            return clusterBySimilarity(items, {
                threshold: (args.threshold as number) ?? 0.5,
                language: (args.language as string) ?? "en",
            });
        },
    },

    // ── Classification ───────────────────────────────────────────────────────
    {
        name: "classify",
        group: "classification",
        description: "Classify text into one of N candidate categories",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to classify" },
            {
                name: "categories",
                type: "string[]",
                required: true,
                description: "Candidate categories (comma-separated)",
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) =>
            classifyText(args.text as string, args.categories as string[], {
                language: (args.language as string) ?? "en",
            }),
    },

    // ── TTS ──────────────────────────────────────────────────────────────────
    {
        name: "speak",
        group: "tts",
        description: "Speak text aloud using macOS say with auto language detection",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to speak" },
            { name: "voice", type: "string", required: false, description: "Override voice name" },
            { name: "rate", type: "number", required: false, description: "Words per minute" },
        ],
        run: async (args) => {
            await speak(args.text as string, {
                voice: args.voice as string | undefined,
                rate: args.rate as number | undefined,
            });
            return { spoken: true };
        },
    },
    {
        name: "list-voices",
        group: "tts",
        description: "List available macOS speech synthesis voices",
        params: [],
        run: async () => listVoices(),
    },

    // ── Auth ─────────────────────────────────────────────────────────────────
    {
        name: "check-biometry",
        group: "auth",
        description: "Check if Touch ID / Optic ID is available",
        params: [],
        run: async () => checkBiometry(),
    },
    {
        name: "authenticate",
        group: "auth",
        description: "Authenticate using Touch ID / Optic ID",
        params: [
            { name: "reason", type: "string", required: false, positional: true, description: "Reason for auth prompt" },
        ],
        run: async (args) => authenticate(args.reason as string | undefined),
    },

    // ── iCloud ───────────────────────────────────────────────────────────────
    {
        name: "icloud-status",
        group: "icloud",
        description: "Check iCloud Drive availability and container URL",
        params: [],
        run: async () => icloudStatus(),
    },
    {
        name: "icloud-read",
        group: "icloud",
        description: "Read a text file from iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "File path in iCloud" },
        ],
        run: async (args) => icloudRead(args.path as string),
    },
    {
        name: "icloud-write",
        group: "icloud",
        description: "Write text to a file in iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "File path in iCloud" },
            { name: "content", type: "string", required: true, description: "Content to write" },
        ],
        run: async (args) => icloudWrite(args.path as string, args.content as string),
    },
    {
        name: "icloud-delete",
        group: "icloud",
        description: "Delete a file from iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "File path to delete" },
        ],
        run: async (args) => icloudDelete(args.path as string),
    },
    {
        name: "icloud-move",
        group: "icloud",
        description: "Move/rename a file in iCloud Drive",
        params: [
            { name: "source", type: "string", required: true, positional: true, description: "Source path" },
            { name: "destination", type: "string", required: true, positional: true, description: "Destination path" },
        ],
        run: async (args) => icloudMove(args.source as string, args.destination as string),
    },
    {
        name: "icloud-copy",
        group: "icloud",
        description: "Copy a file in iCloud Drive",
        params: [
            { name: "source", type: "string", required: true, positional: true, description: "Source path" },
            { name: "destination", type: "string", required: true, positional: true, description: "Destination path" },
        ],
        run: async (args) => icloudCopy(args.source as string, args.destination as string),
    },
    {
        name: "icloud-list",
        group: "icloud",
        description: "List directory contents in iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "Directory path" },
        ],
        run: async (args) => icloudList(args.path as string),
    },
    {
        name: "icloud-mkdir",
        group: "icloud",
        description: "Create a directory in iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "Directory path" },
        ],
        run: async (args) => icloudMkdir(args.path as string),
    },

    // ── System ───────────────────────────────────────────────────────────────
    {
        name: "capabilities",
        group: "system",
        description: "Show DarwinKit version, OS, architecture, and available methods",
        params: [],
        run: async () => getCapabilities(),
    },
];

/** Get a command by name */
export function getCommand(name: string): CommandDef | undefined {
    return commands.find((c) => c.name === name);
}

/** Get commands grouped by group name */
export function getCommandsByGroup(): Map<string, CommandDef[]> {
    const groups = new Map<string, CommandDef[]>();

    for (const group of GROUP_ORDER) {
        groups.set(group, []);
    }

    for (const cmd of commands) {
        const list = groups.get(cmd.group);

        if (list) {
            list.push(cmd);
        }
    }

    return groups;
}
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "darwinkit"`
Expected: zero errors

**Step 3: Commit**

```bash
git add src/darwinkit/lib/commands.ts
git commit -m "feat(darwinkit): add command registry"
```

---

### Task 6: Create interactive mode (`src/darwinkit/lib/interactive.ts`)

**Files:**
- Create: `src/darwinkit/lib/interactive.ts`

**Step 1: Create interactive.ts**

```typescript
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isCancelled, handleCancel, withCancel } from "@app/utils/prompts/clack/helpers";
import { closeDarwinKit } from "@app/utils/macos";
import { type CommandDef, type ParamDef, GROUP_LABELS, GROUP_ORDER, getCommandsByGroup, commands } from "./commands";
import { type OutputFormat, defaultFormat, formatOutput } from "./format";

/**
 * Run the full interactive menu: group → command → params → execute
 */
export async function runInteractiveMenu(): Promise<void> {
    const grouped = getCommandsByGroup();

    const group = await withCancel(
        p.select({
            message: "Choose a category",
            options: GROUP_ORDER.filter((g) => {
                const cmds = grouped.get(g);
                return cmds && cmds.length > 0;
            }).map((g) => ({
                value: g,
                label: GROUP_LABELS[g] ?? g,
                hint: `${grouped.get(g)!.length} commands`,
            })),
        })
    );

    const groupCommands = grouped.get(group as string)!;

    const cmdName = await withCancel(
        p.select({
            message: "Choose a command",
            options: groupCommands.map((c) => ({
                value: c.name,
                label: c.name,
                hint: c.description,
            })),
        })
    );

    const cmd = commands.find((c) => c.name === cmdName)!;
    await runCommandInteractive(cmd);
}

/**
 * Prompt for missing params and execute a command interactively.
 * Shows usage hint first, then prompts for each missing param.
 */
export async function runCommandInteractive(
    cmd: CommandDef,
    providedArgs: Record<string, unknown> = {}
): Promise<void> {
    // Show usage hint
    const usage = buildUsageLine(cmd);
    p.log.info(pc.dim(usage));

    // Prompt for missing required params
    const args = { ...providedArgs };

    for (const param of cmd.params) {
        if (args[param.name] !== undefined) {
            continue;
        }

        if (!param.required && !process.stdout.isTTY) {
            continue;
        }

        const value = await promptForParam(param);
        if (value !== undefined) {
            args[param.name] = value;
        }
    }

    // Execute
    const spin = p.spinner();
    spin.start(`Running ${cmd.name}...`);

    try {
        const result = await cmd.run(args);
        spin.stop(`${cmd.name} complete`);

        const format = defaultFormat();
        const output = formatOutput(result, format);
        console.log(output);
    } catch (error) {
        spin.stop(pc.red(`${cmd.name} failed`));
        p.log.error(error instanceof Error ? error.message : String(error));
    } finally {
        closeDarwinKit();
    }
}

async function promptForParam(param: ParamDef): Promise<unknown> {
    if (param.choices && param.choices.length > 0) {
        if (param.type === "string[]") {
            // Multi-select for arrays with choices
            const result = await p.multiselect({
                message: `${param.name} ${pc.dim(`(${param.description})`)}`,
                options: param.choices.map((c) => ({ value: c, label: c })),
                initialValues: param.default as string[] | undefined,
            });

            if (isCancelled(result)) {
                handleCancel();
            }

            return result;
        }

        const result = await p.select({
            message: `${param.name} ${pc.dim(`(${param.description})`)}`,
            options: param.choices.map((c) => ({ value: c, label: c })),
            initialValue: param.default as string | undefined,
        });

        if (isCancelled(result)) {
            handleCancel();
        }

        return result;
    }

    if (param.type === "boolean") {
        return withCancel(
            p.confirm({
                message: `${param.name}? ${pc.dim(`(${param.description})`)}`,
                initialValue: (param.default as boolean) ?? false,
            })
        );
    }

    if (param.type === "string[]") {
        const result = await withCancel(
            p.text({
                message: `${param.name} ${pc.dim(`(${param.description}, comma-separated)`)}`,
                placeholder: param.default ? String(param.default) : undefined,
            })
        );
        return (result as string).split(",").map((s) => s.trim());
    }

    if (param.type === "number") {
        const result = await withCancel(
            p.text({
                message: `${param.name} ${pc.dim(`(${param.description})`)}`,
                placeholder: param.default !== undefined ? String(param.default) : undefined,
                validate: (v) => {
                    if (!param.required && v === "") {
                        return;
                    }
                    if (Number.isNaN(Number(v))) {
                        return "Must be a number";
                    }
                },
            })
        );

        const str = result as string;
        if (str === "" && param.default !== undefined) {
            return param.default;
        }

        return str === "" ? undefined : Number(str);
    }

    // string
    const result = await withCancel(
        p.text({
            message: `${param.name} ${pc.dim(`(${param.description})`)}`,
            placeholder: param.default !== undefined ? String(param.default) : undefined,
            validate: (v) => {
                if (param.required && v.trim() === "") {
                    return `${param.name} is required`;
                }
            },
        })
    );

    const str = result as string;
    if (str === "" && !param.required) {
        return param.default;
    }

    return str;
}

function buildUsageLine(cmd: CommandDef): string {
    const positionals = cmd.params.filter((p) => p.positional);
    const flags = cmd.params.filter((p) => !p.positional);
    let line = `Usage: tools darwinkit ${cmd.name}`;

    for (const param of positionals) {
        line += param.required ? ` <${param.name}>` : ` [${param.name}]`;
    }

    for (const param of flags) {
        if (param.type === "boolean") {
            line += ` [--${param.name}]`;
        } else {
            line += ` [--${param.name} <${param.type}>]`;
        }
    }

    return line;
}
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "darwinkit"`
Expected: zero errors

**Step 3: Commit**

```bash
git add src/darwinkit/lib/interactive.ts
git commit -m "feat(darwinkit): add interactive mode"
```

---

### Task 7: Create entry point (`src/darwinkit/index.ts`)

**Files:**
- Create: `src/darwinkit/index.ts`

**Step 1: Create index.ts**

This is the main entry point. It:
1. No args + TTY → logo + interactive menu
2. No args + non-TTY → full help
3. Subcommand + all params → execute directly
4. Subcommand + missing params + TTY → show usage + clack prompts
5. Subcommand + missing params + non-TTY → show subcommand help

```typescript
#!/usr/bin/env bun

import { handleReadmeFlag } from "@app/utils/readme";
import { closeDarwinKit } from "@app/utils/macos";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import {
    type CommandDef,
    GROUP_LABELS,
    GROUP_ORDER,
    commands,
    getCommandsByGroup,
} from "./lib/commands";
import { type OutputFormat, defaultFormat, formatOutput } from "./lib/format";
import { runCommandInteractive, runInteractiveMenu } from "./lib/interactive";

handleReadmeFlag(import.meta.url);

// ─── Logo ───────────────────────────────────────────────────────────────────────

const LOGO = `${pc.bold(pc.cyan("  DarwinKit"))} ${pc.dim("— Apple on-device ML from the terminal")}`;

// ─── Help Generator ─────────────────────────────────────────────────────────────

function printFullHelp(): void {
    console.log();
    console.log(LOGO);
    console.log();

    const grouped = getCommandsByGroup();

    for (const group of GROUP_ORDER) {
        const cmds = grouped.get(group);

        if (!cmds || cmds.length === 0) {
            continue;
        }

        console.log(pc.bold(pc.yellow(`  ${GROUP_LABELS[group] ?? group}`)));

        for (const cmd of cmds) {
            const positionals = cmd.params.filter((p) => p.positional);
            const posStr = positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ");
            const nameCol = `    ${pc.green(cmd.name)}${posStr ? ` ${pc.dim(posStr)}` : ""}`;
            console.log(`${nameCol.padEnd(50)}${pc.dim(cmd.description)}`);
        }

        console.log();
    }

    console.log(pc.dim("  Options: --format json|pretty|raw"));
    console.log(pc.dim("  Run without args for interactive mode (TTY only)"));
    console.log();
}

// ─── Commander Setup ────────────────────────────────────────────────────────────

function buildProgram(): Command {
    const program = new Command();

    program
        .name("darwinkit")
        .description("Apple on-device ML from the terminal")
        .version("1.0.0")
        .option("--format <format>", "Output format: json, pretty, raw");

    // Register each command from the registry
    for (const cmd of commands) {
        const sub = program.command(cmd.name).description(cmd.description);

        // Add positional arguments
        const positionals = cmd.params.filter((p) => p.positional);

        for (const param of positionals) {
            if (param.required) {
                sub.argument(`<${param.name}>`, param.description);
            } else {
                sub.argument(`[${param.name}]`, param.description);
            }
        }

        // Add flag options
        const flags = cmd.params.filter((p) => !p.positional);

        for (const param of flags) {
            const flag =
                param.type === "boolean"
                    ? `--${param.name}`
                    : param.type === "string[]"
                      ? `--${param.name} <values...>`
                      : `--${param.name} <${param.type}>`;
            const desc =
                param.default !== undefined
                    ? `${param.description} (default: ${JSON.stringify(param.default)})`
                    : param.description;
            sub.option(flag, desc);
        }

        sub.option("--format <format>", "Output format: json, pretty, raw");

        sub.action(async (...actionArgs: unknown[]) => {
            await handleCommandAction(cmd, sub, actionArgs);
        });
    }

    return program;
}

async function handleCommandAction(
    cmd: CommandDef,
    sub: Command,
    actionArgs: unknown[]
): Promise<void> {
    // Commander passes: positional1, positional2, ..., optionsObj, commandObj
    const positionals = cmd.params.filter((p) => p.positional);
    const opts = (actionArgs[positionals.length] ?? {}) as Record<string, unknown>;

    // Build args from positionals + flags
    const args: Record<string, unknown> = {};

    for (let i = 0; i < positionals.length; i++) {
        if (actionArgs[i] !== undefined) {
            args[positionals[i].name] = actionArgs[i];
        }
    }

    // Merge flag options
    for (const param of cmd.params.filter((p) => !p.positional)) {
        // Commander converts kebab-case to camelCase, so check both
        const camelName = param.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

        if (opts[camelName] !== undefined) {
            args[param.name] = param.type === "number" ? Number(opts[camelName]) : opts[camelName];
        } else if (opts[param.name] !== undefined) {
            args[param.name] = param.type === "number" ? Number(opts[param.name]) : opts[param.name];
        }
    }

    // Check for missing required params
    const missing = cmd.params.filter((p) => p.required && args[p.name] === undefined);

    if (missing.length > 0) {
        if (process.stdout.isTTY) {
            // Interactive prompting for missing params
            p.intro(LOGO);
            await runCommandInteractive(cmd, args);
            return;
        }

        // Non-TTY: show help
        sub.help();
        return;
    }

    // All params present — execute directly
    const format: OutputFormat = (opts.format as OutputFormat) ?? defaultFormat();

    try {
        const result = await cmd.run(args);
        console.log(formatOutput(result, format));
    } catch (error) {
        if (process.stdout.isTTY) {
            p.log.error(error instanceof Error ? error.message : String(error));
        } else {
            console.error(error instanceof Error ? error.message : String(error));
        }

        process.exit(1);
    } finally {
        closeDarwinKit();
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (process.argv.length <= 2) {
        if (process.stdout.isTTY) {
            p.intro(LOGO);
            await runInteractiveMenu();
        } else {
            printFullHelp();
        }

        return;
    }

    const program = buildProgram();

    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        if (process.stdout.isTTY) {
            p.log.error(error instanceof Error ? error.message : String(error));
        } else {
            console.error(error instanceof Error ? error.message : String(error));
        }

        process.exit(1);
    }
}

main().catch((err) => {
    if (process.stdout.isTTY) {
        p.log.error(err instanceof Error ? err.message : String(err));
    } else {
        console.error(err instanceof Error ? err.message : String(err));
    }

    closeDarwinKit();
    process.exit(1);
});
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "darwinkit"`
Expected: zero errors

Run: `bunx biome check src/darwinkit/ --write`

**Step 3: Test manually**

```bash
# Should show help (non-TTY piped)
tools darwinkit 2>&1 | cat

# Should show interactive menu (TTY)
tools darwinkit

# Should execute directly
tools darwinkit detect-language "Bonjour le monde"
tools darwinkit sentiment "I love this!" --format json
tools darwinkit capabilities
```

**Step 4: Commit**

```bash
git add src/darwinkit/index.ts
git commit -m "feat(darwinkit): add CLI entry point with interactive + commander modes"
```

---

### Task 8: Final verification

**Step 1: TypeScript check**

Run: `tsgo --noEmit`
Expected: zero errors from darwinkit/

**Step 2: Biome check**

Run: `bunx biome check src/darwinkit/ src/utils/macos/`
Expected: zero errors

**Step 3: Full test run**

Run: `bun test`
Expected: existing tests still pass

**Step 4: Manual smoke tests**

```bash
# Non-interactive commands
tools darwinkit detect-language "Dobrý den, jak se máte?"
tools darwinkit sentiment "This is terrible" --format raw
tools darwinkit entities "Steve Jobs founded Apple in Cupertino"
tools darwinkit lemmatize "The cats are running quickly"
tools darwinkit keywords "Apple released a revolutionary new iPhone today"
tools darwinkit distance "budget planning" "financial review"
tools darwinkit ocr ~/Desktop/screenshot.png --text-only
tools darwinkit capabilities --format json
tools darwinkit list-voices
tools darwinkit classify "fix null pointer" --categories "bug fix,feature,refactor"

# Interactive mode
tools darwinkit
```

**Step 5: Commit if any fixes needed, then squash or leave as-is**

---

## Verification Checklist

1. `tsgo --noEmit` — zero errors
2. `bunx biome check src/darwinkit/ src/utils/macos/` — zero errors
3. `bun test` — all existing tests pass
4. `tools darwinkit` (TTY) — shows logo + interactive menu
5. `tools darwinkit 2>&1 | cat` (non-TTY) — shows full help with all commands grouped
6. `tools darwinkit detect-language "hello"` — returns `{ language: "en", confidence: ... }`
7. `tools darwinkit sentiment "I love this" --format json` — returns JSON
8. `tools darwinkit sentiment "I love this" --format raw` — returns just the score
9. `tools darwinkit capabilities` — shows version, OS, methods
10. `tools darwinkit sentiment` (TTY, no text) — shows usage + prompts for text
11. `tools darwinkit sentiment | cat` (non-TTY, no text) — shows subcommand help
12. No imports from `@genesiscz/darwinkit` in `src/darwinkit/` — only from `@app/utils/macos`
