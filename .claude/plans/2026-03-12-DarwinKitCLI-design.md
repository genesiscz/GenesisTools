# DarwinKit CLI Tool — Design Document

## Goal

Create an interactive CLI tool (`tools darwinkit`) that exposes the full DarwinKit API surface (NLP, Vision, TTS, Auth, iCloud, System) through both an interactive clack menu and flat CLI subcommands.

## Architecture

```
@genesiscz/darwinkit (package)
    ↓
src/utils/macos/*.ts (util wrappers — thin layer over package)
    ↓
src/darwinkit/lib/commands.ts (registry map — single source of truth)
    ↓
src/darwinkit/index.ts (entry — interactive or CLI mode)
```

The CLI tool never imports from `@genesiscz/darwinkit` directly — it only calls `src/utils/macos/` utils. Phase 1 expands utils to cover iCloud/auth/system (currently missing), Phase 2 builds the CLI.

## Phase 1: Expand Utils

### New files in `src/utils/macos/`:

**`auth.ts`** — Biometric authentication
- `checkBiometry()` → returns `{ available, biometry_type }`
- `authenticate(reason?)` → returns `{ success }`

**`system.ts`** — System capabilities
- `getCapabilities()` → returns `{ version, os, arch, methods }`

**`icloud.ts`** — iCloud Drive operations
- `icloudStatus()` → returns `{ available, container_url }`
- `icloudRead(path)` → returns `{ content }`
- `icloudWrite(path, content)` → returns `{ ok }`
- `icloudWriteBytes(path, data)` → returns `{ ok }`
- `icloudDelete(path)` → returns `{ ok }`
- `icloudMove(source, destination)` → returns `{ ok }`
- `icloudCopy(source, destination)` → returns `{ ok }`
- `icloudList(path)` → returns `{ entries: [...] }`
- `icloudMkdir(path)` → returns `{ ok }`
- `icloudStartMonitoring()` / `icloudStopMonitoring()`

Update `index.ts` exports and `types.ts` re-exports for new package types.

## Phase 2: CLI Tool

### Command Registry (`src/darwinkit/lib/commands.ts`)

Single source of truth — drives interactive menu, CLI dispatch, help generation, and param validation.

```typescript
interface ParamDef {
    name: string;
    type: "string" | "number" | "boolean" | "string[]";
    required: boolean;
    description: string;
    default?: unknown;
}

interface CommandDef {
    name: string;           // "detect-language" (CLI subcommand)
    group: string;          // "nlp" (interactive menu grouping)
    description: string;    // shown in help + interactive
    params: ParamDef[];     // drives --help, validation, interactive prompts
    run: (args: Record<string, unknown>) => Promise<unknown>;
}
```

### Groups & Commands (~35 total)

**nlp** (11): detect-language, sentiment, tag, entities, lemmatize, keywords, embed, distance, similar, relevance, neighbors
**vision** (1): ocr
**text-analysis** (6): rank, batch-sentiment, group-by-language, batch-entities, deduplicate, cluster
**classification** (3): classify, classify-batch, group-by-category
**tts** (2): speak, list-voices
**auth** (2): check-biometry, authenticate
**icloud** (10): status, read, write, write-bytes, delete, move, copy, list, mkdir, monitor
**system** (1): capabilities

### Output Formatting (`src/darwinkit/lib/format.ts`)

`--format json|pretty|raw`

- **json**: `JSON.stringify(result, null, 2)` — for piping
- **pretty**: Colored human-readable (tables for arrays, key-value for objects)
- **raw**: Just the value (string result → string, arrays → newline-separated)
- **Default**: pretty if TTY, json if piped

### Interactive Flow (`src/darwinkit/lib/interactive.ts`)

Progressive prompting with clack:

1. `tools darwinkit` (TTY) → DarwinKit logo → group select → command select → param prompts → execute
2. `tools darwinkit` (non-TTY) → full help listing
3. `tools darwinkit <cmd>` (TTY, missing params) → shows usage line first → clack prompts for missing params
4. `tools darwinkit <cmd> --all-params` → just execute, no prompting

### File Structure

```
src/darwinkit/
├── index.ts              # entry: interactive vs CLI dispatch
├── lib/
│   ├── commands.ts       # registry map (single source of truth)
│   ├── format.ts         # json/pretty/raw formatter
│   └── interactive.ts    # clack prompts for interactive mode
```

### Example Usage

```bash
# Interactive
tools darwinkit

# CLI - flat subcommands
tools darwinkit detect-language "Bonjour le monde"
tools darwinkit sentiment "I love this product"
tools darwinkit ocr ~/screenshot.png --languages en-US,cs
tools darwinkit speak "Hello world" --voice Samantha --rate 200
tools darwinkit icloud-list /Documents
tools darwinkit classify "fix null pointer" --categories "bug fix,feature,refactor"

# Output control
tools darwinkit sentiment "Great!" --format json
tools darwinkit sentiment "Great!" --format raw    # just: 0.95

# Piped
echo "Hello world" | tools darwinkit detect-language --format json | jq .language

# Help
tools darwinkit --help
tools darwinkit ocr --help
```
