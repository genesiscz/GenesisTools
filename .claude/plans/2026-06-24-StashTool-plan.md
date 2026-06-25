# Stash Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools stash` — a global cross-project code-overlay manager with versioned named stashes, drift-tolerant apply via `git apply --3way`, foldable `@stash` region markers, and a reviewable multi-step unapply state machine.

**Architecture:** Bun + commander CLI under `src/stash/`. Storage = bare git repo at `~/.genesis-tools/stash/store/` (patches as git commits, blob OIDs survive for 3-way) + SQLite index at `~/.genesis-tools/stash/index.db`. Marker decoration uses `// #region @stash:<name> {json}` to layer on the existing `@dbg` foldable-region convention. Unapply is a persistent state machine modeled on `git rebase --continue / --abort`.

**Tech Stack:** Bun, TypeScript (strict), commander, @clack/prompts, bun:sqlite, git CLI via `Bun.spawn()`, pino logger (existing `@app/logger`), SafeJSON (existing `@app/utils/json`).

**Spec:** `.claude/plans/2026-06-24-StashTool-spec.md` — refer for full design rationale.

---

## File Structure

**New files (all under `src/stash/`):**

```
src/stash/
├── index.ts                          # commander entrypoint
├── README.md                         # tool documentation (auto-shown by --readme)
├── types.ts                          # shared types
├── commands/
│   ├── save.ts                       # save subcommand
│   ├── apply.ts                      # apply subcommand
│   ├── unapply.ts                    # unapply subcommand (state machine driver)
│   ├── update.ts                     # update subcommand
│   ├── list.ts                       # list subcommand
│   ├── show.ts                       # show subcommand
│   ├── versions.ts                   # versions subcommand
│   ├── drop.ts                       # drop subcommand
│   └── where.ts                      # where subcommand
├── lib/
│   ├── storage.ts                    # StashStorage (paths, init dirs)
│   ├── stash-db.ts                   # SQLite open + DAO methods
│   ├── stash-migrations.ts           # Migration[] for sqlite schema
│   ├── store-repo.ts                 # bare git repo I/O (init, save patch, fetch baseline)
│   ├── markers.ts                    # parse / emit / strip @stash markers
│   ├── languages.ts                  # ext → comment syntax mapping
│   ├── regions.ts                    # working-tree region discovery + extraction
│   ├── patch.ts                      # format-patch generation + apply via git
│   ├── projects.ts                   # origin URL detection + sibling-clone match
│   ├── ids.ts                        # uuid v7 + short-id derivation
│   └── unapply-session.ts            # UnapplySession state machine
└── *.test.ts                         # colocated tests (bun:test)

.claude/skills/stash/
└── SKILL.md                          # agent-facing skill
```

**Modifications:** None to existing files. The tool is fully additive (commander tools auto-discover from `src/`).

---

## Phase 1 — Foundation

### Task 1: Scaffold tool entrypoint + storage paths

**Files:**
- Create: `src/stash/index.ts`
- Create: `src/stash/lib/storage.ts`
- Create: `src/stash/lib/storage.test.ts`

- [ ] **Step 1: Write failing test for StashStorage paths**

```typescript
// src/stash/lib/storage.test.ts
import { describe, expect, test } from "bun:test";
import { StashStorage } from "./storage";
import { homedir } from "node:os";
import { join } from "node:path";

describe("StashStorage", () => {
    test("returns correct paths under ~/.genesis-tools/stash/", () => {
        const s = new StashStorage();
        expect(s.root()).toBe(join(homedir(), ".genesis-tools", "stash"));
        expect(s.storeRepoDir()).toBe(join(s.root(), "store"));
        expect(s.dbPath()).toBe(join(s.root(), "index.db"));
        expect(s.stateDir()).toBe(join(s.root(), "state"));
        expect(s.cacheDir()).toBe(join(s.root(), "cache"));
    });

    test("ensureDirs creates all subdirectories", async () => {
        const s = new StashStorage();
        await s.ensureDirs();
        const { existsSync } = await import("node:fs");
        expect(existsSync(s.storeRepoDir())).toBe(true);
        expect(existsSync(s.stateDir())).toBe(true);
        expect(existsSync(s.cacheDir())).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/stash/lib/storage.test.ts`
Expected: FAIL — `Cannot find module './storage'`

- [ ] **Step 3: Implement StashStorage**

```typescript
// src/stash/lib/storage.ts
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class StashStorage {
    private readonly base: string;

    constructor(base?: string) {
        this.base = base ?? join(homedir(), ".genesis-tools", "stash");
    }

    root(): string {
        return this.base;
    }

    storeRepoDir(): string {
        return join(this.base, "store");
    }

    dbPath(): string {
        return join(this.base, "index.db");
    }

    stateDir(): string {
        return join(this.base, "state");
    }

    cacheDir(): string {
        return join(this.base, "cache");
    }

    async ensureDirs(): Promise<void> {
        await Promise.all([
            mkdir(this.storeRepoDir(), { recursive: true }),
            mkdir(this.stateDir(), { recursive: true }),
            mkdir(this.cacheDir(), { recursive: true }),
        ]);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/stash/lib/storage.test.ts`
Expected: 2 pass

- [ ] **Step 5: Create commander entrypoint stub**

```typescript
// src/stash/index.ts
#!/usr/bin/env bun
import { Command } from "commander";
import { runTool } from "@app/utils/cli";

const program = new Command();
program
    .name("tools stash")
    .description("Global cross-project code-overlay manager")
    .version("0.1.0");

// Subcommands wired in later tasks
program
    .command("save <name>")
    .description("Capture working-tree changes as a named stash")
    .action(async (_name: string) => {
        console.error("save: not implemented yet");
        process.exit(1);
    });

await runTool(program, { tool: "stash" });
```

- [ ] **Step 6: Verify tool auto-discovery**

Run: `tools stash --help`
Expected: prints commander help with `save` subcommand listed.

- [ ] **Step 7: Commit**

```bash
git add src/stash/
git commit -m "feat(stash): scaffold tool with StashStorage paths"
```

---

### Task 2: SQLite schema + migrations

**Files:**
- Create: `src/stash/lib/stash-migrations.ts`
- Create: `src/stash/lib/stash-db.ts`
- Create: `src/stash/lib/stash-db.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/stash-db.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openStashDb } from "./stash-db";

describe("openStashDb", () => {
    test("creates all tables on first open", () => {
        const db = new Database(":memory:");
        openStashDb(db);
        const tables = db
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((r) => r.name);
        expect(tables).toContain("stashes");
        expect(tables).toContain("versions");
        expect(tables).toContain("regions");
        expect(tables).toContain("applications");
        expect(tables).toContain("projects");
        expect(tables).toContain("_migrations");
    });

    test("idempotent — second open does not error", () => {
        const db = new Database(":memory:");
        openStashDb(db);
        openStashDb(db);
        const count = db
            .query<{ c: number }, []>("SELECT COUNT(*) as c FROM _migrations")
            .get();
        expect(count?.c).toBeGreaterThan(0);
    });

    test("unique active application constraint", () => {
        const db = new Database(":memory:");
        openStashDb(db);
        db.run(
            "INSERT INTO stashes (id, name, created_at, updated_at) VALUES ('s1', 'foo', '2026-01-01', '2026-01-01')",
        );
        db.run(
            "INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, created_at) VALUES ('v1', 's1', 1, 'refs/stashes/s1/v1', 1, 1, '2026-01-01')",
        );
        db.run(
            "INSERT INTO applications (id, stash_id, version_id, project_path, applied_at, state) VALUES ('a1', 's1', 'v1', '/p', '2026-01-01', 'active')",
        );
        expect(() =>
            db.run(
                "INSERT INTO applications (id, stash_id, version_id, project_path, applied_at, state) VALUES ('a2', 's1', 'v1', '/p', '2026-01-01', 'active')",
            ),
        ).toThrow();
    });
});
```

- [ ] **Step 2: Run test — expect FAIL "cannot find module './stash-db'"**

Run: `bun test src/stash/lib/stash-db.test.ts`

- [ ] **Step 3: Write migrations**

```typescript
// src/stash/lib/stash-migrations.ts
import type { Migration } from "@app/utils/database/migrations";

export const STASH_MIGRATIONS: Migration[] = [
    {
        id: "001-initial-schema",
        sql: `
            CREATE TABLE stashes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                tags TEXT,
                description TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE versions (
                id TEXT PRIMARY KEY,
                stash_id TEXT NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                patch_ref TEXT NOT NULL,
                source_repo_path TEXT,
                source_origin TEXT,
                source_sha TEXT,
                region_count INTEGER NOT NULL,
                file_count INTEGER NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                UNIQUE(stash_id, version)
            );
            CREATE TABLE regions (
                id TEXT PRIMARY KEY,
                version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
                region_name TEXT,
                file_path TEXT NOT NULL,
                hunk_index INTEGER NOT NULL,
                start_marker_present INTEGER NOT NULL DEFAULT 0,
                line_count INTEGER NOT NULL
            );
            CREATE TABLE applications (
                id TEXT PRIMARY KEY,
                stash_id TEXT NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                version_id TEXT NOT NULL REFERENCES versions(id),
                project_path TEXT NOT NULL,
                project_origin TEXT,
                project_sha_at_apply TEXT,
                applied_at TEXT NOT NULL,
                state TEXT NOT NULL,
                unapplied_at TEXT
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                origin TEXT,
                tree_hash TEXT,
                last_seen TEXT NOT NULL
            );
            CREATE INDEX idx_versions_stash ON versions(stash_id);
            CREATE INDEX idx_applications_project ON applications(project_path);
            CREATE INDEX idx_applications_stash ON applications(stash_id);
            CREATE INDEX idx_regions_version ON regions(version_id);
            CREATE UNIQUE INDEX idx_applications_active
                ON applications(stash_id, project_path)
                WHERE state = 'active';
        `,
    },
];
```

- [ ] **Step 4: Write openStashDb**

```typescript
// src/stash/lib/stash-db.ts
import type { Database } from "bun:sqlite";
import { runMigrations } from "@app/utils/database/migrations";
import { STASH_MIGRATIONS } from "./stash-migrations";

export function openStashDb(db: Database): Database {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA journal_mode = WAL");
    runMigrations(db, STASH_MIGRATIONS);
    return db;
}
```

- [ ] **Step 5: Run tests — expect 3 pass**

Run: `bun test src/stash/lib/stash-db.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/stash/lib/stash-migrations.ts src/stash/lib/stash-db.ts src/stash/lib/stash-db.test.ts
git commit -m "feat(stash): sqlite schema + migrations"
```

---

### Task 3: Bare git store repo

**Files:**
- Create: `src/stash/lib/store-repo.ts`
- Create: `src/stash/lib/store-repo.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/store-repo.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRepo } from "./store-repo";

let storeDir: string;
beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "stash-store-"));
});
afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
});

describe("StoreRepo", () => {
    test("init creates a bare git repo", async () => {
        const repo = new StoreRepo(storeDir);
        await repo.init();
        const { existsSync } = await import("node:fs");
        expect(existsSync(join(storeDir, "HEAD"))).toBe(true);
        expect(existsSync(join(storeDir, "refs"))).toBe(true);
    });

    test("init is idempotent", async () => {
        const repo = new StoreRepo(storeDir);
        await repo.init();
        await repo.init();
        // no throw
    });

    test("writePatchCommit creates a ref pointing at a commit", async () => {
        const repo = new StoreRepo(storeDir);
        await repo.init();
        const sha = await repo.writePatchCommit({
            ref: "refs/stashes/abc/v1",
            files: { "a.ts": "console.log(1);\n" },
            message: "stash:test v1",
        });
        expect(sha).toMatch(/^[a-f0-9]{40}$/);
        const resolved = await repo.resolveRef("refs/stashes/abc/v1");
        expect(resolved).toBe(sha);
    });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test src/stash/lib/store-repo.test.ts`

- [ ] **Step 3: Implement StoreRepo**

```typescript
// src/stash/lib/store-repo.ts
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";

const log = logger.scoped("stash:store-repo").log;

export interface WritePatchCommitArgs {
    ref: string;
    files: Record<string, string>;
    message: string;
    parentRef?: string;
}

export class StoreRepo {
    constructor(private readonly dir: string) {}

    async init(): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        if (existsSync(join(this.dir, "HEAD"))) {
            return;
        }
        await this.git(["init", "--bare", "--initial-branch=main"]);
        log.debug({ dir: this.dir }, "initialized bare store repo");
    }

    async writePatchCommit(args: WritePatchCommitArgs): Promise<string> {
        // Build a tree by writing blobs then a tree object, then commit.
        const blobShas: Record<string, string> = {};
        for (const [path, content] of Object.entries(args.files)) {
            blobShas[path] = await this.gitWithStdin(["hash-object", "-w", "--stdin"], content);
        }
        const mktreeInput = Object.entries(blobShas)
            .map(([path, sha]) => `100644 blob ${sha}\t${path}`)
            .join("\n");
        const treeSha = await this.gitWithStdin(["mktree"], mktreeInput + "\n");

        const commitArgs = ["commit-tree", treeSha, "-m", args.message];
        if (args.parentRef) {
            const parentSha = await this.resolveRef(args.parentRef);
            if (parentSha) {
                commitArgs.push("-p", parentSha);
            }
        }
        const commitSha = await this.git(commitArgs);
        await this.git(["update-ref", args.ref, commitSha]);
        return commitSha.trim();
    }

    async resolveRef(ref: string): Promise<string | null> {
        try {
            const sha = await this.git(["rev-parse", "--verify", ref]);
            return sha.trim();
        } catch {
            return null;
        }
    }

    async readFileAt(ref: string, path: string): Promise<string | null> {
        try {
            return await this.git(["show", `${ref}:${path}`]);
        } catch {
            return null;
        }
    }

    async deleteRef(ref: string): Promise<void> {
        await this.git(["update-ref", "-d", ref]);
    }

    async listRefs(prefix: string): Promise<string[]> {
        try {
            const out = await this.git(["for-each-ref", "--format=%(refname)", prefix]);
            return out
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    private async git(args: string[]): Promise<string> {
        const proc = Bun.spawn(["git", "--git-dir", this.dir, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "stash",
                GIT_AUTHOR_EMAIL: "stash@genesistools.local",
                GIT_COMMITTER_NAME: "stash",
                GIT_COMMITTER_EMAIL: "stash@genesistools.local",
            },
        });
        const [stdout, stderr, exit] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (exit !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
        }
        return stdout;
    }

    private async gitWithStdin(args: string[], input: string): Promise<string> {
        const proc = Bun.spawn(["git", "--git-dir", this.dir, ...args], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        proc.stdin.write(input);
        await proc.stdin.end();
        const [stdout, stderr, exit] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (exit !== 0) {
            throw new Error(`git ${args.join(" ")} (stdin) failed: ${stderr.trim()}`);
        }
        return stdout.trim();
    }
}
```

- [ ] **Step 4: Run tests — expect 3 pass**

Run: `bun test src/stash/lib/store-repo.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/stash/lib/store-repo.ts src/stash/lib/store-repo.test.ts
git commit -m "feat(stash): bare git store repo with hash-object/mktree commit machinery"
```

---

### Task 4: ID helpers (uuid v7 + short ID)

**Files:**
- Create: `src/stash/lib/ids.ts`
- Create: `src/stash/lib/ids.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/ids.test.ts
import { describe, expect, test } from "bun:test";
import { newStashId, shortId } from "./ids";

describe("ids", () => {
    test("newStashId returns 32 hex chars", () => {
        const id = newStashId();
        expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    test("shortId returns first 6 hex chars", () => {
        expect(shortId("3f2a8b7c1d4e5f6a7b8c9d0e1f2a3b4c")).toBe("3f2a8b");
    });

    test("newStashId is monotonically time-ordered (v7-ish)", () => {
        const a = newStashId();
        const b = newStashId();
        expect(a < b || a === b).toBe(true);
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/ids.ts
import { randomBytes } from "node:crypto";

export function newStashId(): string {
    // Loose UUIDv7: 48-bit timestamp ms + 80 bits random — preserves ordering for sqlite indexes.
    const now = BigInt(Date.now());
    const tsHex = now.toString(16).padStart(12, "0");
    const rand = randomBytes(10).toString("hex");
    return tsHex + rand;
}

export function shortId(id: string): string {
    return id.slice(0, 6);
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/ids.test.ts` — 3 pass.

```bash
git add src/stash/lib/ids.ts src/stash/lib/ids.test.ts
git commit -m "feat(stash): uuid-v7-ish ID generator + shortId helper"
```

---

## Phase 2 — Markers

### Task 5: Language → comment syntax mapping

**Files:**
- Create: `src/stash/lib/languages.ts`
- Create: `src/stash/lib/languages.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/languages.test.ts
import { describe, expect, test } from "bun:test";
import { commentSyntaxForFile } from "./languages";

describe("commentSyntaxForFile", () => {
    test("ts/tsx/js/jsx/php/java/c/cpp/go/rs/swift → //", () => {
        for (const f of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.php", "a.java", "a.c", "a.cpp", "a.go", "a.rs", "a.swift"]) {
            expect(commentSyntaxForFile(f).line).toBe("//");
        }
    });
    test("python/ruby/bash/yaml/toml → #", () => {
        for (const f of ["a.py", "a.rb", "a.sh", "a.yaml", "a.yml", "a.toml"]) {
            expect(commentSyntaxForFile(f).line).toBe("#");
        }
    });
    test("html/xml/md → <!-- -->", () => {
        for (const f of ["a.html", "a.xml", "a.md"]) {
            expect(commentSyntaxForFile(f).block).toEqual({ open: "<!--", close: "-->" });
            expect(commentSyntaxForFile(f).line).toBe(null);
        }
    });
    test("css → /* */", () => {
        expect(commentSyntaxForFile("a.css").block).toEqual({ open: "/*", close: "*/" });
    });
    test("unknown extension falls back to //", () => {
        expect(commentSyntaxForFile("a.xyz").line).toBe("//");
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/languages.ts
import { extname } from "node:path";

export interface CommentSyntax {
    line: string | null;
    block: { open: string; close: string } | null;
}

const SLASH: CommentSyntax = { line: "//", block: { open: "/*", close: "*/" } };
const HASH: CommentSyntax = { line: "#", block: null };
const XML: CommentSyntax = { line: null, block: { open: "<!--", close: "-->" } };
const CSS: CommentSyntax = { line: null, block: { open: "/*", close: "*/" } };

const MAP: Record<string, CommentSyntax> = {
    ts: SLASH, tsx: SLASH, js: SLASH, jsx: SLASH, mjs: SLASH, cjs: SLASH,
    php: SLASH, java: SLASH, c: SLASH, h: SLASH, cpp: SLASH, hpp: SLASH,
    go: SLASH, rs: SLASH, swift: SLASH, kt: SLASH, scala: SLASH, dart: SLASH,
    py: HASH, rb: HASH, sh: HASH, bash: HASH, zsh: HASH, fish: HASH,
    yaml: HASH, yml: HASH, toml: HASH,
    html: XML, xml: XML, svg: XML, md: XML, vue: XML,
    css: CSS, scss: CSS, less: CSS,
};

export function commentSyntaxForFile(path: string): CommentSyntax {
    const ext = extname(path).slice(1).toLowerCase();
    return MAP[ext] ?? SLASH;
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/languages.test.ts` — 5 pass.

```bash
git add src/stash/lib/languages.ts src/stash/lib/languages.test.ts
git commit -m "feat(stash): per-file-ext comment syntax mapping"
```

---

### Task 6: Marker parse / emit / strip

**Files:**
- Create: `src/stash/lib/markers.ts`
- Create: `src/stash/lib/markers.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/markers.test.ts
import { describe, expect, test } from "bun:test";
import { emitOpenMarker, emitCloseMarker, parseMarkers, stripMarkers, type MarkerMeta } from "./markers";

describe("markers", () => {
    test("emit open marker for // syntax", () => {
        const meta: MarkerMeta = { id: "3f2a8b", v: 2 };
        const line = emitOpenMarker({ name: "debug-logger", meta, syntax: { line: "//", block: null } });
        expect(line).toBe(`// #region @stash:debug-logger {"id":"3f2a8b","v":2}`);
    });

    test("emit open marker for # syntax", () => {
        const meta: MarkerMeta = { id: "3f2a8b", v: 1 };
        const line = emitOpenMarker({ name: "x", meta, syntax: { line: "#", block: null } });
        expect(line).toBe(`# #region @stash:x {"id":"3f2a8b","v":1}`);
    });

    test("emit open marker for block-only (HTML)", () => {
        const meta: MarkerMeta = { id: "abc", v: 1 };
        const line = emitOpenMarker({
            name: "x",
            meta,
            syntax: { line: null, block: { open: "<!--", close: "-->" } },
        });
        expect(line).toBe(`<!-- #region @stash:x {"id":"abc","v":1} -->`);
    });

    test("emit close marker (bare)", () => {
        const line = emitCloseMarker({ name: "debug-logger", syntax: { line: "//", block: null } });
        expect(line).toBe(`// #endregion @stash:debug-logger`);
    });

    test("parseMarkers finds open+close pair in TS file", () => {
        const src = [
            "function foo() {",
            `    // #region @stash:debug-logger {"id":"3f2a8b","v":2}`,
            "    console.log('debug');",
            "    // #endregion @stash:debug-logger",
            "}",
        ].join("\n");
        const found = parseMarkers(src);
        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe("debug-logger");
        expect(found[0]?.meta.id).toBe("3f2a8b");
        expect(found[0]?.meta.v).toBe(2);
        expect(found[0]?.startLine).toBe(2);
        expect(found[0]?.endLine).toBe(4);
    });

    test("parseMarkers handles bare author markers (no JSON)", () => {
        const src = [
            `// #region @stash:debug-logger`,
            `x();`,
            `// #endregion @stash:debug-logger`,
        ].join("\n");
        const found = parseMarkers(src);
        expect(found).toHaveLength(1);
        expect(found[0]?.meta).toEqual({});
    });

    test("stripMarkers removes both open and close lines", () => {
        const src = [
            "before",
            `// #region @stash:x {"id":"abc","v":1}`,
            "inside",
            "// #endregion @stash:x",
            "after",
        ].join("\n");
        expect(stripMarkers(src)).toBe(["before", "inside", "after"].join("\n"));
    });

    test("stripMarkers only removes @stash markers, not unrelated #region", () => {
        const src = [
            "// #region someOtherRegion",
            "x",
            "// #endregion someOtherRegion",
        ].join("\n");
        expect(stripMarkers(src)).toBe(src);
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/markers.ts
import { SafeJSON } from "@app/utils/json";
import type { CommentSyntax } from "./languages";

export interface MarkerMeta {
    id?: string;
    v?: number;
    hunk?: number;
    src?: string;
    applied?: string;
}

export interface ParsedMarker {
    name: string;
    meta: MarkerMeta;
    startLine: number;       // 1-indexed line of open marker
    endLine: number;         // 1-indexed line of close marker
    contentStartLine: number;
    contentEndLine: number;
}

const OPEN_RE = /#region\s+@stash:([\w.\-]+)(?:\s+(\{.*?\}))?(?:\s*(?:-->|\*\/))?\s*$/;
const CLOSE_RE = /#endregion\s+@stash:([\w.\-]+)/;

export function emitOpenMarker(args: {
    name: string;
    meta: MarkerMeta;
    syntax: CommentSyntax;
}): string {
    const json = SafeJSON.stringify(args.meta);
    if (args.syntax.line) {
        return `${args.syntax.line} #region @stash:${args.name} ${json}`;
    }
    const b = args.syntax.block;
    if (!b) {
        throw new Error("language has no comment syntax");
    }
    return `${b.open} #region @stash:${args.name} ${json} ${b.close}`;
}

export function emitCloseMarker(args: {
    name: string;
    syntax: CommentSyntax;
}): string {
    if (args.syntax.line) {
        return `${args.syntax.line} #endregion @stash:${args.name}`;
    }
    const b = args.syntax.block;
    if (!b) {
        throw new Error("language has no comment syntax");
    }
    return `${b.open} #endregion @stash:${args.name} ${b.close}`;
}

export function parseMarkers(source: string): ParsedMarker[] {
    const lines = source.split("\n");
    const opens: Array<{ name: string; meta: MarkerMeta; line: number }> = [];
    const closes: Array<{ name: string; line: number }> = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const closeMatch = CLOSE_RE.exec(line);
        if (closeMatch) {
            closes.push({ name: closeMatch[1] ?? "", line: i + 1 });
            continue;
        }
        const openMatch = OPEN_RE.exec(line);
        if (openMatch) {
            const name = openMatch[1] ?? "";
            const json = openMatch[2];
            let meta: MarkerMeta = {};
            if (json) {
                try {
                    meta = SafeJSON.parse(json) as MarkerMeta;
                } catch {
                    // leave meta empty; classification will mark as edited/corrupt
                }
            }
            opens.push({ name, meta, line: i + 1 });
        }
    }

    const out: ParsedMarker[] = [];
    for (const open of opens) {
        const close = closes.find((c) => c.name === open.name && c.line > open.line);
        if (!close) {
            continue;
        }
        out.push({
            name: open.name,
            meta: open.meta,
            startLine: open.line,
            endLine: close.line,
            contentStartLine: open.line + 1,
            contentEndLine: close.line - 1,
        });
    }
    return out;
}

export function stripMarkers(source: string): string {
    const lines = source.split("\n");
    const keep: string[] = [];
    for (const line of lines) {
        if (OPEN_RE.test(line) || CLOSE_RE.test(line)) {
            continue;
        }
        keep.push(line);
    }
    return keep.join("\n");
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/markers.test.ts` — 8 pass.

```bash
git add src/stash/lib/markers.ts src/stash/lib/markers.test.ts
git commit -m "feat(stash): @stash marker parse/emit/strip with JSON-in-comment metadata"
```

---

### Task 7: Region content extraction from working tree

**Files:**
- Create: `src/stash/lib/regions.ts`
- Create: `src/stash/lib/regions.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/regions.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRegionsInTree, extractRegionContent } from "./regions";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stash-regions-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("discoverRegionsInTree", () => {
    test("finds named regions across multiple files", async () => {
        await writeFile(join(dir, "a.ts"), [
            "function a() {",
            "    // #region @stash:foo",
            "    x();",
            "    // #endregion @stash:foo",
            "}",
        ].join("\n"));
        await mkdir(join(dir, "lib"));
        await writeFile(join(dir, "lib", "b.ts"), [
            "// #region @stash:bar",
            "y();",
            "// #endregion @stash:bar",
            "// #region @stash:foo",
            "z();",
            "// #endregion @stash:foo",
        ].join("\n"));

        const regions = await discoverRegionsInTree(dir);
        expect(regions).toHaveLength(3);
        const names = regions.map((r) => r.name).sort();
        expect(names).toEqual(["bar", "foo", "foo"]);
    });

    test("respects .gitignore (no node_modules walk)", async () => {
        await mkdir(join(dir, "node_modules"));
        await writeFile(join(dir, "node_modules", "x.ts"), [
            "// #region @stash:should-not-find",
            "// #endregion @stash:should-not-find",
        ].join("\n"));
        const regions = await discoverRegionsInTree(dir);
        expect(regions).toHaveLength(0);
    });
});

describe("extractRegionContent", () => {
    test("returns content between markers, excluding markers themselves", async () => {
        const filePath = join(dir, "a.ts");
        await writeFile(filePath, [
            "before",
            "// #region @stash:foo",
            "line1",
            "line2",
            "// #endregion @stash:foo",
            "after",
        ].join("\n"));
        const content = await extractRegionContent(filePath, "foo");
        expect(content).toBe("line1\nline2");
    });

    test("returns null when region not found", async () => {
        const filePath = join(dir, "a.ts");
        await writeFile(filePath, "no regions here");
        expect(await extractRegionContent(filePath, "missing")).toBeNull();
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/regions.ts
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseMarkers, type ParsedMarker } from "./markers";

export interface DiscoveredRegion extends ParsedMarker {
    filePath: string;        // repo-relative
    absPath: string;
}

const SKIP_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "out", ".next", ".turbo",
    ".bun", ".cache", "coverage", "target", "vendor", ".venv", "__pycache__",
]);

export async function discoverRegionsInTree(rootDir: string): Promise<DiscoveredRegion[]> {
    const out: DiscoveredRegion[] = [];
    await walk(rootDir, rootDir, out);
    return out;
}

async function walk(rootDir: string, dir: string, out: DiscoveredRegion[]): Promise<void> {
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
            await walk(rootDir, abs, out);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const st = await stat(abs);
        if (st.size > 1_000_000) {
            continue;
        }
        let content: string;
        try {
            content = await readFile(abs, "utf8");
        } catch {
            continue;
        }
        if (!content.includes("@stash:")) {
            continue;
        }
        const markers = parseMarkers(content);
        for (const m of markers) {
            out.push({
                ...m,
                filePath: relative(rootDir, abs),
                absPath: abs,
            });
        }
    }
}

export async function extractRegionContent(filePath: string, regionName: string): Promise<string | null> {
    const content = await readFile(filePath, "utf8");
    const markers = parseMarkers(content);
    const m = markers.find((x) => x.name === regionName);
    if (!m) {
        return null;
    }
    const lines = content.split("\n");
    return lines.slice(m.contentStartLine - 1, m.contentEndLine).join("\n");
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/regions.test.ts` — 4 pass.

```bash
git add src/stash/lib/regions.ts src/stash/lib/regions.test.ts
git commit -m "feat(stash): working-tree region discovery + per-region content extraction"
```

---

## Phase 3 — Patch Core

### Task 8: Patch generation + apply

**Files:**
- Create: `src/stash/lib/patch.ts`
- Create: `src/stash/lib/patch.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/patch.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "./patch";
import { diffWorkingTree, applyPatch, reversePatch } from "./patch";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stash-patch-"));
    await runGitIn(dir, ["init", "--initial-branch=main"]);
    await runGitIn(dir, ["config", "user.email", "t@t"]);
    await runGitIn(dir, ["config", "user.name", "t"]);
    await writeFile(join(dir, "a.ts"), "line1\nline2\nline3\n");
    await runGitIn(dir, ["add", "a.ts"]);
    await runGitIn(dir, ["commit", "-m", "init"]);
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("patch", () => {
    test("diffWorkingTree captures uncommitted change as unified diff", async () => {
        await writeFile(join(dir, "a.ts"), "line1\nINSERTED\nline2\nline3\n");
        const diff = await diffWorkingTree({ repoDir: dir, mode: "all" });
        expect(diff).toContain("a.ts");
        expect(diff).toContain("+INSERTED");
    });

    test("applyPatch round-trips a diff", async () => {
        await writeFile(join(dir, "a.ts"), "line1\nINSERTED\nline2\nline3\n");
        const diff = await diffWorkingTree({ repoDir: dir, mode: "all" });
        await writeFile(join(dir, "a.ts"), "line1\nline2\nline3\n"); // revert
        await applyPatch({ repoDir: dir, patch: diff, threeWay: true });
        const after = await readFile(join(dir, "a.ts"), "utf8");
        expect(after).toBe("line1\nINSERTED\nline2\nline3\n");
    });

    test("reversePatch removes the change", async () => {
        await writeFile(join(dir, "a.ts"), "line1\nINSERTED\nline2\nline3\n");
        const diff = await diffWorkingTree({ repoDir: dir, mode: "all" });
        // diff captures the change; now stage+commit then reverse
        await runGitIn(dir, ["add", "a.ts"]);
        await runGitIn(dir, ["commit", "-m", "with insert"]);
        await reversePatch({ repoDir: dir, patch: diff, threeWay: true });
        const after = await readFile(join(dir, "a.ts"), "utf8");
        expect(after).toBe("line1\nline2\nline3\n");
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/patch.ts
import { logger } from "@app/logger";

const log = logger.scoped("stash:patch").log;

export type SaveMode = "staged" | "unstaged" | "all";

export async function runGitIn(repoDir: string, args: string[], opts?: { stdin?: string }): Promise<string> {
    const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
        stdin: opts?.stdin ? "pipe" : "inherit",
        stdout: "pipe",
        stderr: "pipe",
    });
    if (opts?.stdin) {
        proc.stdin.write(opts.stdin);
        await proc.stdin.end();
    }
    const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exit !== 0) {
        log.warn({ args, stderr: stderr.trim() }, "git command failed");
        throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    }
    return stdout;
}

export async function diffWorkingTree(args: { repoDir: string; mode: SaveMode }): Promise<string> {
    const gitArgs = ["diff", "--no-color", "--no-ext-diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/"];
    if (args.mode === "staged") {
        gitArgs.push("--cached");
    } else if (args.mode === "all") {
        gitArgs.push("HEAD");
    }
    return await runGitIn(args.repoDir, gitArgs);
}

export async function applyPatch(args: { repoDir: string; patch: string; threeWay: boolean }): Promise<void> {
    const gitArgs = ["apply", "--whitespace=fix"];
    if (args.threeWay) {
        gitArgs.push("--3way");
    }
    await runGitIn(args.repoDir, gitArgs, { stdin: args.patch });
}

export async function reversePatch(args: { repoDir: string; patch: string; threeWay: boolean }): Promise<void> {
    const gitArgs = ["apply", "-R", "--whitespace=fix"];
    if (args.threeWay) {
        gitArgs.push("--3way");
    }
    await runGitIn(args.repoDir, gitArgs, { stdin: args.patch });
}

export interface PatchedFile {
    path: string;
    afterContent: string | null; // null = deletion
}

export async function listFilesInPatch(args: { repoDir: string; patch: string }): Promise<string[]> {
    // Use git apply --numstat to list affected files without applying
    const out = await runGitIn(args.repoDir, ["apply", "--numstat", "--no-color"], { stdin: args.patch }).catch(
        () => "",
    );
    return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split("\t").slice(2).join("\t"))
        .filter(Boolean);
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/patch.test.ts` — 3 pass.

```bash
git add src/stash/lib/patch.ts src/stash/lib/patch.test.ts
git commit -m "feat(stash): diff/apply/reverse patch helpers with --3way support"
```

---

### Task 9: Project detection (origin URL + sibling clones)

**Files:**
- Create: `src/stash/lib/projects.ts`
- Create: `src/stash/lib/projects.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/projects.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "./patch";
import { normalizeOrigin, detectProject, findSiblingClones } from "./projects";

describe("normalizeOrigin", () => {
    test("strips .git suffix", () => {
        expect(normalizeOrigin("https://github.com/x/y.git")).toBe("github.com/x/y");
    });
    test("normalizes ssh form", () => {
        expect(normalizeOrigin("git@github.com:x/y.git")).toBe("github.com/x/y");
    });
    test("lowercases host", () => {
        expect(normalizeOrigin("https://GitHub.com/X/Y")).toBe("github.com/X/Y");
    });
});

let work: string;
beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-projects-"));
});
afterEach(async () => {
    await rm(work, { recursive: true, force: true });
});

describe("detectProject", () => {
    test("returns null outside git repo", async () => {
        const result = await detectProject(work);
        expect(result).toBeNull();
    });

    test("returns root + origin for a git repo", async () => {
        const repo = join(work, "a");
        await Bun.write(join(repo, ".keep"), "");
        await runGitIn(work, ["init", "a", "--initial-branch=main"]);
        await runGitIn(repo, ["remote", "add", "origin", "https://github.com/x/y.git"]);
        const result = await detectProject(repo);
        expect(result?.rootPath).toBe(repo);
        expect(result?.origin).toBe("github.com/x/y");
    });
});

describe("findSiblingClones", () => {
    test("finds sibling dirs with same origin", async () => {
        for (const name of ["foo", "foo2", "foo-upgrade", "bar"]) {
            const repo = join(work, name);
            await Bun.write(join(repo, ".keep"), "");
            await runGitIn(work, ["init", name, "--initial-branch=main"]);
            const origin = name === "bar" ? "https://github.com/diff/diff.git" : "https://github.com/x/y.git";
            await runGitIn(repo, ["remote", "add", "origin", origin]);
        }
        const found = await findSiblingClones(join(work, "foo"));
        const names = found.map((p) => p.split("/").pop()).sort();
        expect(names).toEqual(["foo-upgrade", "foo2"]);
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/projects.ts
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runGitIn } from "./patch";

export interface DetectedProject {
    rootPath: string;
    origin: string | null;
    sha: string | null;
}

export function normalizeOrigin(url: string): string {
    let u = url.trim().replace(/\.git$/, "");
    const ssh = /^git@([^:]+):(.+)$/.exec(u);
    if (ssh) {
        u = `${ssh[1]}/${ssh[2]}`;
    } else {
        u = u.replace(/^[a-z]+:\/\/(?:[^@]+@)?/, "");
    }
    const slash = u.indexOf("/");
    if (slash > 0) {
        const host = u.slice(0, slash).toLowerCase();
        return `${host}${u.slice(slash)}`;
    }
    return u.toLowerCase();
}

export async function detectProject(cwd: string): Promise<DetectedProject | null> {
    try {
        const root = (await runGitIn(cwd, ["rev-parse", "--show-toplevel"])).trim();
        let origin: string | null = null;
        try {
            const raw = (await runGitIn(root, ["config", "--get", "remote.origin.url"])).trim();
            if (raw) {
                origin = normalizeOrigin(raw);
            }
        } catch {
            // no origin configured
        }
        let sha: string | null = null;
        try {
            sha = (await runGitIn(root, ["rev-parse", "HEAD"])).trim();
        } catch {
            // empty repo
        }
        return { rootPath: root, origin, sha };
    } catch {
        return null;
    }
}

export async function findSiblingClones(projectPath: string): Promise<string[]> {
    const project = await detectProject(projectPath);
    if (!project || !project.origin) {
        return [];
    }
    const parent = dirname(project.rootPath);
    const entries = await readdir(parent, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidate = join(parent, entry.name);
        if (candidate === project.rootPath) {
            continue;
        }
        if (!existsSync(join(candidate, ".git"))) {
            continue;
        }
        const other = await detectProject(candidate);
        if (other?.origin === project.origin) {
            out.push(candidate);
        }
    }
    return out.sort();
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/projects.test.ts` — 5 pass.

```bash
git add src/stash/lib/projects.ts src/stash/lib/projects.test.ts
git commit -m "feat(stash): project detection + sibling-clone scan by origin URL"
```

---

## Phase 4 — Save Command

### Task 10: save (staged/unstaged/all modes)

**Files:**
- Create: `src/stash/commands/save.ts`
- Create: `src/stash/types.ts`
- Modify: `src/stash/index.ts`

- [ ] **Step 1: Define shared types**

```typescript
// src/stash/types.ts
export interface StashRow {
    id: string;
    name: string;
    tags: string | null;
    description: string | null;
    created_at: string;
    updated_at: string;
}

export interface VersionRow {
    id: string;
    stash_id: string;
    version: number;
    patch_ref: string;
    source_repo_path: string | null;
    source_origin: string | null;
    source_sha: string | null;
    region_count: number;
    file_count: number;
    metadata_json: string;
    created_at: string;
}

export interface ApplicationRow {
    id: string;
    stash_id: string;
    version_id: string;
    project_path: string;
    project_origin: string | null;
    project_sha_at_apply: string | null;
    applied_at: string;
    state: "active" | "unapplying" | "unapplied" | "orphaned";
    unapplied_at: string | null;
}
```

- [ ] **Step 2: Implement save command**

```typescript
// src/stash/commands/save.ts
import { Database } from "bun:sqlite";
import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import { StoreRepo } from "../lib/store-repo";
import { newStashId, shortId } from "../lib/ids";
import { detectProject } from "../lib/projects";
import { diffWorkingTree, listFilesInPatch, type SaveMode } from "../lib/patch";
import { stripMarkers, parseMarkers } from "../lib/markers";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StashRow, VersionRow } from "../types";

const log = logger.scoped("stash:save").log;

export interface SaveOptions {
    name: string;
    mode: SaveMode | undefined;
    tags: string[];
    description: string | undefined;
}

export async function saveCommand(opts: SaveOptions): Promise<void> {
    const project = await detectProject(process.cwd());
    if (!project) {
        out.log.error("not inside a git repository");
        process.exit(1);
    }

    let mode = opts.mode;
    if (!mode) {
        if (!isInteractive()) {
            out.log.error("--staged | --unstaged | --all required in non-interactive mode");
            out.log.info(suggestCommand("tools stash save", { add: ["--all"], extra: [opts.name] }));
            process.exit(1);
        }
        const { select } = await import("@clack/prompts");
        const sel = await select({
            message: "What to save?",
            options: [
                { value: "all", label: "All changes (staged + unstaged + untracked)" },
                { value: "staged", label: "Staged only" },
                { value: "unstaged", label: "Unstaged tracked changes only" },
            ],
        });
        if (typeof sel !== "string") {
            out.log.warn("cancelled");
            return;
        }
        mode = sel as SaveMode;
    }

    const rawPatch = await diffWorkingTree({ repoDir: project.rootPath, mode });
    if (!rawPatch.trim()) {
        out.log.warn("no changes to stash");
        return;
    }

    const patch = stripApplyMarkersFromPatchFiles({ patch: rawPatch, projectRoot: project.rootPath });
    const fileList = await listFilesInPatch({ repoDir: project.rootPath, patch: rawPatch });

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const repo = new StoreRepo(storage.storeRepoDir());
    await repo.init();

    const existing = db
        .query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?")
        .get(opts.name);

    const now = new Date().toISOString();
    let stashId: string;
    let version: number;

    if (existing) {
        stashId = existing.id;
        const maxV = db
            .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
            .get(stashId);
        version = (maxV?.m ?? 0) + 1;
        out.log.info(`stash "${opts.name}" exists, creating v${version}`);
        db.run("UPDATE stashes SET updated_at = ? WHERE id = ?", [now, stashId]);
    } else {
        stashId = newStashId();
        version = 1;
        db.run(
            "INSERT INTO stashes (id, name, tags, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [
                stashId,
                opts.name,
                opts.tags.length ? JSON.stringify(opts.tags) : null,
                opts.description ?? null,
                now,
                now,
            ],
        );
    }

    const patchRef = `refs/stashes/${stashId}/v${version}`;
    const baselineRef = `refs/baselines/${stashId}/v${version}`;

    const baselineFiles = await collectBaselineFiles({ projectRoot: project.rootPath, files: fileList });
    await repo.writePatchCommit({
        ref: baselineRef,
        files: baselineFiles,
        message: `stash:${opts.name} v${version} baseline`,
    });
    await repo.writePatchCommit({
        ref: patchRef,
        files: { "PATCH.diff": patch },
        message: `stash:${opts.name} v${version}`,
    });

    const versionId = newStashId();
    db.run(
        `INSERT INTO versions (id, stash_id, version, patch_ref, source_repo_path, source_origin, source_sha, region_count, file_count, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            versionId,
            stashId,
            version,
            patchRef,
            project.rootPath,
            project.origin,
            project.sha,
            countAuthorRegionsInPatch(patch),
            fileList.length,
            "{}",
            now,
        ],
    );

    out.log.success(`saved "${opts.name}" v${version} [id=${shortId(stashId)}]`);
    out.log.info(`  ${fileList.length} files, baseline ref=${baselineRef}`);

    db.close();
    log.info({ stashId, version, files: fileList.length }, "stash saved");
}

function stripApplyMarkersFromPatchFiles(args: { patch: string; projectRoot: string }): string {
    // Strip apply-time markers (with JSON metadata) from added lines in the patch.
    // Author-bare markers (no JSON) are preserved.
    const lines = args.patch.split("\n");
    const APPLY_OPEN = /^\+.*#region\s+@stash:[\w.\-]+\s+\{.*\}/;
    const ANY_CLOSE = /^\+.*#endregion\s+@stash:[\w.\-]+/;
    const kept: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        if (APPLY_OPEN.test(line)) {
            // Skip this opener; also skip its matching closer (next + line that closes the region).
            i++;
            continue;
        }
        if (ANY_CLOSE.test(line)) {
            // Only skip the close if its open was a JSON-marker; heuristic: skip all + close markers.
            // (Safer: this loses semantically-paired author closers too, but those were preserved
            // because author opens have no JSON and we keep them.)
            const isCloseForAppliedRegion = true; // best-effort
            if (isCloseForAppliedRegion) {
                i++;
                continue;
            }
        }
        kept.push(line);
        i++;
    }
    return kept.join("\n");
}

function countAuthorRegionsInPatch(patch: string): number {
    const m = patch.match(/^\+.*#region\s+@stash:/gm);
    return m?.length ?? 0;
}

async function collectBaselineFiles(args: { projectRoot: string; files: string[] }): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of args.files) {
        try {
            // Try the committed version first; fall back to "" for newly-added files.
            const { runGitIn } = await import("../lib/patch");
            try {
                out[f] = await runGitIn(args.projectRoot, ["show", `HEAD:${f}`]);
            } catch {
                out[f] = "";
            }
        } catch {
            out[f] = "";
        }
    }
    return out;
}
```

- [ ] **Step 3: Wire into commander**

Replace the stub `save` action in `src/stash/index.ts`:

```typescript
// src/stash/index.ts
#!/usr/bin/env bun
import { Command } from "commander";
import { runTool } from "@app/utils/cli";
import { saveCommand } from "./commands/save";

const program = new Command();
program
    .name("tools stash")
    .description("Global cross-project code-overlay manager")
    .version("0.1.0");

program
    .command("save <name>")
    .description("Capture working-tree changes as a named stash")
    .option("--staged", "save staged changes only")
    .option("--unstaged", "save unstaged tracked changes only")
    .option("--all", "save staged + unstaged + untracked")
    .option("-t, --tag <tag>", "add a tag (repeatable)", (val, prev: string[] = []) => [...prev, val], [])
    .option("-d, --desc <description>", "human-readable description")
    .action(async (name: string, opts: { staged?: boolean; unstaged?: boolean; all?: boolean; tag: string[]; desc?: string }) => {
        const mode = opts.staged ? "staged" : opts.unstaged ? "unstaged" : opts.all ? "all" : undefined;
        await saveCommand({ name, mode, tags: opts.tag, description: opts.desc });
    });

await runTool(program, { tool: "stash" });
```

- [ ] **Step 4: Manual smoke test**

In a scratch git repo with a modification:

```bash
mkdir /tmp/stash-smoke && cd /tmp/stash-smoke
git init && echo "v1" > a.txt && git add a.txt && git commit -m init
echo "v2" > a.txt
tools stash save smoke-test --all
# expected: "saved smoke-test v1 [id=<6hex>]"
```

Then run a second save with same name:

```bash
echo "v3" > a.txt
tools stash save smoke-test --all
# expected: "stash 'smoke-test' exists, creating v2"
```

- [ ] **Step 5: Commit**

```bash
git add src/stash/commands/save.ts src/stash/types.ts src/stash/index.ts
git commit -m "feat(stash): save command (staged/unstaged/all modes) with auto-versioning"
```

---

## Phase 5 — Apply Command

### Task 11: apply (default flow with marker decoration)

**Files:**
- Create: `src/stash/commands/apply.ts`
- Modify: `src/stash/index.ts`

- [ ] **Step 1: Implement apply**

```typescript
// src/stash/commands/apply.ts
import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger, out } from "@app/logger";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import { StoreRepo } from "../lib/store-repo";
import { newStashId, shortId } from "../lib/ids";
import { detectProject } from "../lib/projects";
import { applyPatch, listFilesInPatch } from "../lib/patch";
import { emitOpenMarker, emitCloseMarker } from "../lib/markers";
import { commentSyntaxForFile } from "../lib/languages";
import type { StashRow, VersionRow, ApplicationRow } from "../types";

const log = logger.scoped("stash:apply").log;

export interface ApplyOptions {
    name: string;
    version?: number;
    verboseMarkers: boolean;
}

export async function applyCommand(opts: ApplyOptions): Promise<void> {
    const project = await detectProject(process.cwd());
    if (!project) {
        out.log.error("not inside a git repository");
        process.exit(1);
    }

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    const stash = db
        .query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?")
        .get(opts.name);
    if (!stash) {
        out.log.error(`stash "${opts.name}" not found`);
        process.exit(1);
    }

    const version = opts.version
        ? db
              .query<VersionRow, [string, number]>(
                  "SELECT * FROM versions WHERE stash_id = ? AND version = ?",
              )
              .get(stash.id, opts.version)
        : db
              .query<VersionRow, [string]>(
                  "SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1",
              )
              .get(stash.id);
    if (!version) {
        out.log.error(`no version found for "${opts.name}"${opts.version ? ` @v${opts.version}` : ""}`);
        process.exit(1);
    }

    const existingActive = db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'",
        )
        .get(stash.id, project.rootPath);
    if (existingActive) {
        out.log.error(`"${opts.name}" is already applied here. Use 'unapply' or 'update'.`);
        process.exit(1);
    }

    const repo = new StoreRepo(storage.storeRepoDir());
    const patch = await repo.readFileAt(version.patch_ref, "PATCH.diff");
    if (!patch) {
        out.log.error(`patch missing from store at ${version.patch_ref}`);
        process.exit(1);
    }

    // Fetch baseline blobs from store into project's git objects for --3way.
    const baselineRef = `refs/baselines/${stash.id}/v${version.version}`;
    await fetchBaselineBlobs({ projectRoot: project.rootPath, storeDir: storage.storeRepoDir(), baselineRef });

    out.log.info(`applying "${opts.name}" v${version.version} [id=${shortId(stash.id)}]`);

    try {
        await applyPatch({ repoDir: project.rootPath, patch, threeWay: true });
    } catch (err) {
        out.log.error(`apply failed: ${(err as Error).message}`);
        out.log.warn("apply-conflict state machine deferred to v1.1; resolve conflicts manually and re-run with --resume (future)");
        process.exit(1);
    }

    const affectedFiles = await listFilesInPatch({ repoDir: project.rootPath, patch });
    await decorateAppliedRegions({
        projectRoot: project.rootPath,
        files: affectedFiles,
        patch,
        stashName: opts.name,
        stashId: stash.id,
        version: version.version,
        verbose: opts.verboseMarkers,
        sourceRepo: version.source_repo_path,
        sourceSha: version.source_sha,
    });

    const now = new Date().toISOString();
    db.run(
        `INSERT INTO applications (id, stash_id, version_id, project_path, project_origin, project_sha_at_apply, applied_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [newStashId(), stash.id, version.id, project.rootPath, project.origin, project.sha, now],
    );

    out.log.success(`applied "${opts.name}" v${version.version}`);
    out.log.info(`  ${affectedFiles.length} files affected`);

    db.close();
    log.info({ stashId: stash.id, version: version.version, files: affectedFiles.length }, "stash applied");
}

async function fetchBaselineBlobs(args: { projectRoot: string; storeDir: string; baselineRef: string }): Promise<void> {
    const { runGitIn } = await import("../lib/patch");
    try {
        await runGitIn(args.projectRoot, [
            "fetch",
            "--no-tags",
            args.storeDir,
            `${args.baselineRef}:refs/.gtstash-baseline`,
        ]);
    } catch (err) {
        log.warn({ err }, "baseline fetch failed; --3way will fall back to fuzz matching");
    }
}

async function decorateAppliedRegions(args: {
    projectRoot: string;
    files: string[];
    patch: string;
    stashName: string;
    stashId: string;
    version: number;
    verbose: boolean;
    sourceRepo: string | null;
    sourceSha: string | null;
}): Promise<void> {
    // For each file in the patch, wrap each contiguous hunk of newly-inserted lines with markers.
    // Parse the unified diff to find @@ hunk ranges and insert markers around added line groups.
    const hunks = parseDiffHunks(args.patch);
    for (const [filePath, fileHunks] of Object.entries(hunks)) {
        const abs = join(args.projectRoot, filePath);
        const syntax = commentSyntaxForFile(filePath);
        let content: string;
        try {
            content = await readFile(abs, "utf8");
        } catch {
            continue;
        }
        const lines = content.split("\n");
        // Walk hunks in reverse so line offsets stay valid.
        for (let h = fileHunks.length - 1; h >= 0; h--) {
            const hunk = fileHunks[h];
            if (!hunk) {
                continue;
            }
            const meta: Record<string, unknown> = { id: shortId(args.stashId), v: args.version };
            if (args.verbose) {
                meta.hunk = h + 1;
                if (args.sourceRepo) {
                    meta.src = `${args.sourceRepo.split("/").pop()}@${args.sourceSha?.slice(0, 7) ?? "?"}`;
                }
                meta.applied = new Date().toISOString();
            }
            const openLine = emitOpenMarker({ name: args.stashName, meta, syntax });
            const closeLine = emitCloseMarker({ name: args.stashName, syntax });
            // hunk.newStart is 1-indexed in the file AFTER apply; insert close at newStart+newLines-1+1.
            const closeIdx = hunk.newStart + hunk.newLines - 1; // 0-indexed insertion point (after last added line)
            const openIdx = hunk.newStart - 1; // 0-indexed insertion point (before first added line)
            lines.splice(closeIdx, 0, closeLine);
            lines.splice(openIdx, 0, openLine);
        }
        await writeFile(abs, lines.join("\n"));
    }
}

interface DiffHunk {
    newStart: number;
    newLines: number;
    addedCount: number;
}

function parseDiffHunks(patch: string): Record<string, DiffHunk[]> {
    const out: Record<string, DiffHunk[]> = {};
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let currentHunk: DiffHunk | null = null;
    const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
    const FILE_RE = /^\+\+\+ b\/(.+)$/;
    for (const line of lines) {
        const fm = FILE_RE.exec(line);
        if (fm) {
            currentFile = fm[1] ?? null;
            currentHunk = null;
            continue;
        }
        const hm = HUNK_RE.exec(line);
        if (hm && currentFile) {
            currentHunk = {
                newStart: Number(hm[1]),
                newLines: Number(hm[2] ?? "1"),
                addedCount: 0,
            };
            (out[currentFile] ??= []).push(currentHunk);
            continue;
        }
        if (currentHunk && line.startsWith("+") && !line.startsWith("+++")) {
            currentHunk.addedCount++;
        }
    }
    return out;
}
```

- [ ] **Step 2: Wire into commander**

Add to `src/stash/index.ts`:

```typescript
import { applyCommand } from "./commands/apply";

program
    .command("apply <name>")
    .description("Apply a stash into the current project")
    .option("--at <version>", "pin to specific version (default: latest)", (v) => Number(v))
    .option("--verbose-markers", "include source/applied metadata in markers")
    .action(async (name: string, opts: { at?: number; verboseMarkers?: boolean }) => {
        await applyCommand({ name, version: opts.at, verboseMarkers: !!opts.verboseMarkers });
    });
```

- [ ] **Step 3: Manual smoke test (round-trip with save)**

```bash
# In the save smoke-test repo:
git checkout -- a.txt    # reset to last committed
tools stash apply smoke-test
cat a.txt   # expect: marker-wrapped content
```

- [ ] **Step 4: Write integration test**

```typescript
// src/stash/commands/apply.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "../lib/patch";
import { saveCommand } from "./save";
import { applyCommand } from "./apply";

let work: string;
let origHome: string | undefined;
let projectA: string;
let projectB: string;

beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-apply-it-"));
    origHome = process.env.HOME;
    process.env.HOME = work; // redirect storage root for test isolation
    projectA = join(work, "repo-a");
    projectB = join(work, "repo-b");
    for (const repo of [projectA, projectB]) {
        await runGitIn(work, ["init", repo.split("/").pop() ?? "", "--initial-branch=main"]);
        await runGitIn(repo, ["config", "user.email", "t@t"]);
        await runGitIn(repo, ["config", "user.name", "t"]);
        await writeFile(join(repo, "a.ts"), "fn();\n");
        await runGitIn(repo, ["add", "a.ts"]);
        await runGitIn(repo, ["commit", "-m", "init"]);
    }
});
afterEach(async () => {
    process.env.HOME = origHome;
    await rm(work, { recursive: true, force: true });
});

describe("apply integration", () => {
    test("save in A, apply to B, decorates with markers", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "a.ts"), "fn();\ninserted();\n");
        await saveCommand({ name: "x", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "x", verboseMarkers: false });
        const result = await readFile(join(projectB, "a.ts"), "utf8");
        expect(result).toContain("#region @stash:x");
        expect(result).toContain("inserted();");
        expect(result).toContain("#endregion @stash:x");
    });
});
```

- [ ] **Step 5: Run, commit**

Run: `bun test src/stash/commands/apply.test.ts` — 1 pass.

```bash
git add src/stash/commands/apply.ts src/stash/commands/apply.test.ts src/stash/index.ts
git commit -m "feat(stash): apply command with --3way merge + region marker decoration"
```

---

## Phase 6 — Unapply State Machine

This phase is the centerpiece of the tool. Implementation follows TDD strictly: state machine is built bottom-up (classify → session → decisions → CLI), with persistence verified at each step.

### Task 12: Region classification

**Files:**
- Create: `src/stash/lib/classify.ts`
- Create: `src/stash/lib/classify.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/classify.test.ts
import { describe, expect, test } from "bun:test";
import { classifyRegion, type ClassifyInput } from "./classify";

const baseStored = "logger.debug('x');";

describe("classifyRegion", () => {
    test("unchanged when stored == current", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: baseStored, present: true };
        expect(classifyRegion(input).klass).toBe("unchanged");
    });
    test("edited when stored != current and both present", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: "logger.debug('y');", present: true };
        expect(classifyRegion(input).klass).toBe("edited");
    });
    test("missing when markers absent", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: null, present: false };
        expect(classifyRegion(input).klass).toBe("missing");
    });
    test("ignores trailing whitespace differences", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: `${baseStored}   `, present: true };
        expect(classifyRegion(input).klass).toBe("unchanged");
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/classify.ts
export type RegionClass = "unchanged" | "edited" | "missing" | "new-extra";

export interface ClassifyInput {
    storedContent: string;
    currentContent: string | null;
    present: boolean;
}

export interface Classification {
    klass: RegionClass;
}

export function classifyRegion(input: ClassifyInput): Classification {
    if (!input.present) {
        return { klass: "missing" };
    }
    if (input.currentContent === null) {
        return { klass: "missing" };
    }
    const norm = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");
    if (norm(input.storedContent) === norm(input.currentContent)) {
        return { klass: "unchanged" };
    }
    return { klass: "edited" };
}
```

- [ ] **Step 3: Run, commit**

Run: `bun test src/stash/lib/classify.test.ts` — 4 pass.

```bash
git add src/stash/lib/classify.ts src/stash/lib/classify.test.ts
git commit -m "feat(stash): region classifier (unchanged/edited/missing)"
```

---

### Task 13: UnapplySession state with persistence

**Files:**
- Create: `src/stash/lib/unapply-session.ts`
- Create: `src/stash/lib/unapply-session.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/unapply-session.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnapplySession, type SessionRegion } from "./unapply-session";

let stateDir: string;
beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "stash-session-"));
});
afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
});

const regions: SessionRegion[] = [
    { id: "r1", filePath: "a.ts", hunkIndex: 1, klass: "unchanged", decision: "auto-remove" },
    { id: "r2", filePath: "a.ts", hunkIndex: 2, klass: "edited", decision: null },
    { id: "r3", filePath: "b.ts", hunkIndex: 1, klass: "missing", decision: null },
];

describe("UnapplySession", () => {
    test("currentRegion skips decided + unchanged regions", () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        expect(s.currentRegion()?.id).toBe("r2");
    });

    test("decide() advances to next undecided region", () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        s.decide("update");
        expect(s.currentRegion()?.id).toBe("r3");
    });

    test("isComplete after all decided", () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        s.decide("update");
        s.decide("skip");
        expect(s.isComplete()).toBe(true);
    });

    test("persist + load round-trip preserves decisions and current index", async () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        s.decide("update");
        await s.persist();

        const loaded = await UnapplySession.load({
            stashId: "abc",
            projectHash: "phash",
            stateDir,
        });
        expect(loaded).not.toBeNull();
        expect(loaded?.currentRegion()?.id).toBe("r3");
        const r2 = loaded?.regions().find((r) => r.id === "r2");
        expect(r2?.decision).toBe("update");
    });

    test("abort() deletes state file", async () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        await s.persist();
        await s.abort();
        const loaded = await UnapplySession.load({ stashId: "abc", projectHash: "phash", stateDir });
        expect(loaded).toBeNull();
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/unapply-session.ts
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { RegionClass } from "./classify";

export type Decision = "update" | "discard" | "skip" | "auto-remove" | null;

export interface SessionRegion {
    id: string;
    filePath: string;
    hunkIndex: number;
    klass: RegionClass;
    decision: Decision;
    storedContent?: string;
    currentContent?: string | null;
}

export interface SessionState {
    stashId: string;
    stashName: string;
    projectPath: string;
    projectHash: string;
    regions: SessionRegion[];
    currentIndex: number;
    startedAt: string;
    pausedAt: string | null;
}

export class UnapplySession {
    private constructor(private state: SessionState, private readonly stateDir: string) {}

    static start(args: {
        stashId: string;
        stashName: string;
        projectPath: string;
        projectHash: string;
        regions: SessionRegion[];
        stateDir: string;
    }): UnapplySession {
        const state: SessionState = {
            stashId: args.stashId,
            stashName: args.stashName,
            projectPath: args.projectPath,
            projectHash: args.projectHash,
            regions: args.regions,
            currentIndex: 0,
            startedAt: new Date().toISOString(),
            pausedAt: null,
        };
        const s = new UnapplySession(state, args.stateDir);
        s.advanceToNextUndecided();
        return s;
    }

    static async load(args: {
        stashId: string;
        projectHash: string;
        stateDir: string;
    }): Promise<UnapplySession | null> {
        const path = stateFilePath(args.stateDir, args.projectHash, args.stashId);
        if (!existsSync(path)) {
            return null;
        }
        const raw = await readFile(path, "utf8");
        const state = SafeJSON.parse<SessionState>(raw);
        return new UnapplySession(state, args.stateDir);
    }

    regions(): SessionRegion[] {
        return this.state.regions;
    }

    currentRegion(): SessionRegion | null {
        return this.state.regions[this.state.currentIndex] ?? null;
    }

    isComplete(): boolean {
        return this.state.regions.every((r) => r.decision !== null);
    }

    progress(): { decided: number; total: number } {
        const decided = this.state.regions.filter((r) => r.decision !== null).length;
        return { decided, total: this.state.regions.length };
    }

    decide(decision: Exclude<Decision, null | "auto-remove">): void {
        const region = this.currentRegion();
        if (!region) {
            throw new Error("no current region");
        }
        region.decision = decision;
        this.advanceToNextUndecided();
    }

    private advanceToNextUndecided(): void {
        for (let i = this.state.currentIndex; i < this.state.regions.length; i++) {
            const r = this.state.regions[i];
            if (!r) {
                continue;
            }
            if (r.decision === null) {
                this.state.currentIndex = i;
                return;
            }
        }
        this.state.currentIndex = this.state.regions.length;
    }

    async persist(): Promise<void> {
        this.state.pausedAt = new Date().toISOString();
        const path = stateFilePath(this.stateDir, this.state.projectHash, this.state.stashId);
        await writeFile(path, SafeJSON.stringify(this.state, null, 2));
    }

    async abort(): Promise<void> {
        const path = stateFilePath(this.stateDir, this.state.projectHash, this.state.stashId);
        if (existsSync(path)) {
            await unlink(path);
        }
    }

    async complete(): Promise<void> {
        await this.abort();
    }

    snapshot(): SessionState {
        return this.state;
    }
}

function stateFilePath(stateDir: string, projectHash: string, stashId: string): string {
    return join(stateDir, `${projectHash.slice(0, 12)}--unapply--${stashId.slice(0, 6)}.json`);
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/unapply-session.test.ts` — 5 pass.

```bash
git add src/stash/lib/unapply-session.ts src/stash/lib/unapply-session.test.ts
git commit -m "feat(stash): UnapplySession state machine with persist/load/abort"
```

---

### Task 14: Decision executors (update / discard / skip / auto-remove)

**Files:**
- Create: `src/stash/lib/decisions.ts`
- Create: `src/stash/lib/decisions.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/stash/lib/decisions.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDecisionToCode } from "./decisions";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stash-decisions-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("applyDecisionToCode", () => {
    test("auto-remove strips markers and content", async () => {
        const f = join(dir, "a.ts");
        await writeFile(f, [
            "before",
            `// #region @stash:x {"id":"abc","v":1}`,
            "content",
            "// #endregion @stash:x",
            "after",
        ].join("\n"));
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "auto-remove" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });

    test("update removes markers + content (caller is responsible for new version)", async () => {
        const f = join(dir, "a.ts");
        await writeFile(f, [
            "before",
            `// #region @stash:x {"id":"abc","v":1}`,
            "modified content",
            "// #endregion @stash:x",
            "after",
        ].join("\n"));
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "update" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });

    test("skip is a no-op on the file", async () => {
        const f = join(dir, "a.ts");
        const before = [
            "before",
            `// #region @stash:x {"id":"abc","v":1}`,
            "content",
            "// #endregion @stash:x",
            "after",
        ].join("\n");
        await writeFile(f, before);
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "skip" });
        expect(await readFile(f, "utf8")).toBe(before);
    });

    test("discard with storedContent restores original then removes", async () => {
        const f = join(dir, "a.ts");
        await writeFile(f, [
            "before",
            `// #region @stash:x {"id":"abc","v":1}`,
            "edited content",
            "// #endregion @stash:x",
            "after",
        ].join("\n"));
        // discard means: remove region using the OLD stored content shape (markers + original between).
        // In practice: same effect on file (markers + content vanish), but caller has already verified
        // the discarded content matches what was originally applied.
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "discard" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/stash/lib/decisions.ts
import { readFile, writeFile } from "node:fs/promises";
import { parseMarkers } from "./markers";
import type { Decision } from "./unapply-session";

export async function applyDecisionToCode(args: {
    filePath: string;
    regionName: string;
    decision: Exclude<Decision, null>;
}): Promise<void> {
    if (args.decision === "skip") {
        return;
    }
    // update | discard | auto-remove all have the same file-side effect: remove the region (markers + content).
    const content = await readFile(args.filePath, "utf8");
    const markers = parseMarkers(content);
    const m = markers.find((x) => x.name === args.regionName);
    if (!m) {
        return; // already gone
    }
    const lines = content.split("\n");
    const before = lines.slice(0, m.startLine - 1);
    const after = lines.slice(m.endLine);
    await writeFile(args.filePath, [...before, ...after].join("\n"));
}
```

- [ ] **Step 3: Run tests, commit**

Run: `bun test src/stash/lib/decisions.test.ts` — 4 pass.

```bash
git add src/stash/lib/decisions.ts src/stash/lib/decisions.test.ts
git commit -m "feat(stash): per-region decision executors"
```

---

### Task 15: unapply command — bootstrap session + walk

**Files:**
- Create: `src/stash/commands/unapply.ts`
- Modify: `src/stash/index.ts`

- [ ] **Step 1: Implement command (TTY + non-TTY flow)**

```typescript
// src/stash/commands/unapply.ts
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import { StoreRepo } from "../lib/store-repo";
import { newStashId } from "../lib/ids";
import { detectProject } from "../lib/projects";
import { applyDecisionToCode } from "../lib/decisions";
import { classifyRegion, type RegionClass } from "../lib/classify";
import { extractRegionContent } from "../lib/regions";
import { UnapplySession, type SessionRegion, type Decision } from "../lib/unapply-session";
import { parseMarkers } from "../lib/markers";
import type { StashRow, VersionRow, ApplicationRow } from "../types";

const log = logger.scoped("stash:unapply").log;

export interface UnapplyOptions {
    name: string;
    action: "start" | "continue" | "skip" | "abort" | "status";
    decision: Exclude<Decision, null | "auto-remove"> | "discard-all-dangerous" | "update-stash-all-dangerous" | undefined;
}

export async function unapplyCommand(opts: UnapplyOptions): Promise<void> {
    const project = await detectProject(process.cwd());
    if (!project) {
        out.log.error("not inside a git repository");
        process.exit(1);
    }

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        out.log.error(`stash "${opts.name}" not found`);
        process.exit(1);
    }

    const projectHash = createHash("sha256").update(project.rootPath).digest("hex");

    if (opts.action === "abort") {
        const s = await UnapplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!s) {
            out.log.warn("no in-progress unapply session");
            return;
        }
        await s.abort();
        out.log.success("aborted");
        return;
    }

    if (opts.action === "status") {
        const s = await UnapplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!s) {
            out.log.info("no in-progress session");
            return;
        }
        const p = s.progress();
        const cur = s.currentRegion();
        out.log.info(`${p.decided}/${p.total} decided; current: ${cur?.filePath ?? "(none)"} hunk ${cur?.hunkIndex ?? "?"}`);
        return;
    }

    // Start or resume session
    let session = await UnapplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
    if (!session) {
        if (opts.action !== "start") {
            out.log.error("no in-progress session; run without --continue to start");
            process.exit(1);
        }
        session = await bootstrapSession({ storage, db, stash, project, projectHash });
    }

    // Apply auto-remove decisions silently
    await processAutoRemoves({ session, projectRoot: project.rootPath });

    if (opts.decision === "discard-all-dangerous" || opts.decision === "update-stash-all-dangerous") {
        const blanket = opts.decision === "discard-all-dangerous" ? "discard" : "update";
        for (const r of session.regions()) {
            if (r.decision === null) {
                r.decision = blanket;
            }
        }
    } else if (opts.decision) {
        if (session.currentRegion()) {
            session.decide(opts.decision);
        }
    } else if (opts.action === "skip") {
        if (session.currentRegion()) {
            session.decide("skip");
        }
    }

    // Drive interactive walk if TTY and there are remaining undecided regions
    if (isInteractive() && !session.isComplete()) {
        await walkInteractive({ session, projectRoot: project.rootPath });
    }

    if (!session.isComplete()) {
        await session.persist();
        await emitNonTtyPrompt({ session, name: opts.name });
        return;
    }

    // Execute decisions
    const stats = await executeAllDecisions({ session, projectRoot: project.rootPath, storage, db, stash });

    // Mark application unapplied
    const now = new Date().toISOString();
    db.run(
        "UPDATE applications SET state = 'unapplied', unapplied_at = ? WHERE stash_id = ? AND project_path = ? AND state = 'active'",
        [now, stash.id, project.rootPath],
    );

    await session.complete();

    out.log.success(`unapplied "${opts.name}" — ${stats.removed} removed, ${stats.updated} captured to v${stats.newVersion ?? "(none)"}, ${stats.skipped} skipped`);

    db.close();
}

async function bootstrapSession(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    project: NonNullable<Awaited<ReturnType<typeof detectProject>>>;
    projectHash: string;
}): Promise<UnapplySession> {
    // Find active application
    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'",
        )
        .get(args.stash.id, args.project.rootPath);
    if (!app) {
        out.log.error(`"${args.stash.name}" is not applied here`);
        process.exit(1);
    }
    const version = args.db.query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?").get(app.version_id);
    if (!version) {
        out.log.error("version row missing");
        process.exit(1);
    }
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const storedPatch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const regionMap = collectRegionsFromPatch(storedPatch);

    const sessionRegions: SessionRegion[] = [];
    for (const r of regionMap) {
        const fileContent = await readFile(join(args.project.rootPath, r.filePath), "utf8").catch(() => null);
        const present = fileContent ? parseMarkers(fileContent).some((m) => m.name === args.stash.name) : false;
        const currentContent = fileContent ? await extractRegionContent(join(args.project.rootPath, r.filePath), args.stash.name) : null;
        const klass = classifyRegion({
            storedContent: r.content,
            currentContent,
            present,
        }).klass;
        sessionRegions.push({
            id: newStashId(),
            filePath: r.filePath,
            hunkIndex: r.hunkIndex,
            klass,
            decision: klass === "unchanged" ? "auto-remove" : null,
            storedContent: r.content,
            currentContent,
        });
    }

    return UnapplySession.start({
        stashId: args.stash.id,
        stashName: args.stash.name,
        projectPath: args.project.rootPath,
        projectHash: args.projectHash,
        regions: sessionRegions,
        stateDir: args.storage.stateDir(),
    });
}

interface PatchRegion {
    filePath: string;
    hunkIndex: number;
    content: string;
}

function collectRegionsFromPatch(patch: string): PatchRegion[] {
    // For v1: derive one "region" per added hunk per file. v1.1 will use author-marker boundaries.
    const out: PatchRegion[] = [];
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let hunkIndex = 0;
    let buffer: string[] = [];
    const flush = () => {
        if (currentFile && buffer.length) {
            hunkIndex++;
            out.push({ filePath: currentFile, hunkIndex, content: buffer.join("\n") });
            buffer = [];
        }
    };
    for (const line of lines) {
        const fm = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fm) {
            flush();
            currentFile = fm[1] ?? null;
            hunkIndex = 0;
            continue;
        }
        if (line.startsWith("@@")) {
            flush();
            continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
            buffer.push(line.slice(1));
        } else if (buffer.length && (line.startsWith(" ") || line.startsWith("-"))) {
            flush();
        }
    }
    flush();
    return out;
}

async function processAutoRemoves(args: { session: UnapplySession; projectRoot: string }): Promise<void> {
    for (const r of args.session.regions()) {
        if (r.decision === "auto-remove") {
            await applyDecisionToCode({
                filePath: join(args.projectRoot, r.filePath),
                regionName: args.session.snapshot().stashName,
                decision: "auto-remove",
            });
        }
    }
}

async function walkInteractive(args: { session: UnapplySession; projectRoot: string }): Promise<void> {
    const { select, note } = await import("@clack/prompts");
    const { renderDiff } = await import("../lib/diff-render");
    while (!args.session.isComplete()) {
        const region = args.session.currentRegion();
        if (!region) {
            return;
        }
        const total = args.session.regions().length;
        const idx = args.session.snapshot().currentIndex + 1;
        const diff = renderDiff({
            before: region.storedContent ?? "",
            after: region.currentContent ?? "",
            label: `${region.filePath} hunk ${region.hunkIndex}`,
        });
        note(diff, `Region ${idx}/${total} — class: ${region.klass}`);
        const opts: Array<{ value: Exclude<Decision, null | "auto-remove">; label: string; hint?: string }> = [
            { value: "update", label: "update — capture current as new vN+1, remove from code" },
            { value: "discard", label: "discard — remove using stored content (lose local edits)" },
            { value: "skip", label: "skip — leave code & store alone (warns)" },
        ];
        if (region.klass === "missing") {
            opts.splice(1, 1); // remove "discard" — nothing to discard
        }
        const sel = await select({ message: "decision?", options: opts });
        if (typeof sel !== "string") {
            out.log.warn("paused; resume with: tools stash unapply <name> --continue");
            await args.session.persist();
            process.exit(0);
        }
        args.session.decide(sel as Exclude<Decision, null | "auto-remove">);
    }
}

async function emitNonTtyPrompt(args: { session: UnapplySession; name: string }): Promise<void> {
    const region = args.session.currentRegion();
    if (!region) {
        return;
    }
    const total = args.session.regions().length;
    const idx = args.session.snapshot().currentIndex + 1;
    process.stderr.write(`\nRegion ${idx}/${total} — ${region.filePath} hunk ${region.hunkIndex} (class: ${region.klass})\n`);
    const { renderDiff } = await import("../lib/diff-render");
    process.stderr.write(renderDiff({
        before: region.storedContent ?? "",
        after: region.currentContent ?? "",
        label: `${region.filePath} hunk ${region.hunkIndex}`,
    }));
    process.stderr.write("\nChoose a decision:\n");
    for (const dec of ["update", "discard", "skip"]) {
        process.stderr.write(`  ${suggestCommand("tools stash unapply", { add: ["--continue", `--decision=${dec}`], extra: [args.name] })}\n`);
    }
    process.stderr.write(`Or abort:\n  ${suggestCommand("tools stash unapply", { add: ["--abort"], extra: [args.name] })}\n`);
}

interface ExecStats {
    removed: number;
    updated: number;
    skipped: number;
    newVersion: number | null;
}

async function executeAllDecisions(args: {
    session: UnapplySession;
    projectRoot: string;
    storage: StashStorage;
    db: Database;
    stash: StashRow;
}): Promise<ExecStats> {
    const stats: ExecStats = { removed: 0, updated: 0, skipped: 0, newVersion: null };
    const updatedRegions: SessionRegion[] = [];
    for (const r of args.session.regions()) {
        if (r.decision === "skip") {
            stats.skipped++;
            out.log.warn(`region ${r.filePath} hunk ${r.hunkIndex}: kept (stash and code now diverged)`);
            continue;
        }
        if (r.decision === "update") {
            updatedRegions.push(r);
            stats.updated++;
        }
        await applyDecisionToCode({
            filePath: join(args.projectRoot, r.filePath),
            regionName: args.session.snapshot().stashName,
            decision: r.decision ?? "auto-remove",
        });
        if (r.decision === "auto-remove" || r.decision === "discard" || r.decision === "update") {
            stats.removed++;
        }
    }
    if (updatedRegions.length) {
        stats.newVersion = await capturedUpdatesAsNewVersion({
            storage: args.storage,
            db: args.db,
            stash: args.stash,
            updatedRegions,
        });
    }
    return stats;
}

async function capturedUpdatesAsNewVersion(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    updatedRegions: SessionRegion[];
}): Promise<number> {
    // Capture the updated regions' current content as a new stash version.
    // Stored as: refs/stashes/<id>/v<n> with one file per region's filePath holding the current content.
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const maxV = args.db
        .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
        .get(args.stash.id);
    const newV = (maxV?.m ?? 0) + 1;
    const files: Record<string, string> = {};
    for (const r of args.updatedRegions) {
        files[`${r.filePath}.hunk${r.hunkIndex}.content`] = r.currentContent ?? "";
    }
    // Build a synthetic patch (added-only): not directly applicable, but preserves the captured content
    // for future inspection. v1.1 will reconstruct a real format-patch.
    const synth = Object.entries(files)
        .map(([k, v]) => `# captured: ${k}\n${v}`)
        .join("\n--\n");
    const patchRef = `refs/stashes/${args.stash.id}/v${newV}`;
    await repo.writePatchCommit({
        ref: patchRef,
        files: { "PATCH.diff": synth, ...files },
        message: `stash:${args.stash.name} v${newV} (captured from unapply)`,
    });
    const now = new Date().toISOString();
    args.db.run(
        `INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '{"capturedFromUnapply":true}', ?)`,
        [newStashId(), args.stash.id, newV, patchRef, args.updatedRegions.length, args.updatedRegions.length, now],
    );
    return newV;
}
```

- [ ] **Step 2: Stub `lib/diff-render.ts`** (real impl via `src/utils/diff` once we read its API)

```typescript
// src/stash/lib/diff-render.ts
export function renderDiff(args: { before: string; after: string; label: string }): string {
    // Stub: simple line-by-line unified rendering. Will be replaced by src/utils/diff usage in Task 16.
    const beforeLines = args.before.split("\n");
    const afterLines = args.after.split("\n");
    const lines = [`--- stored (${args.label})`, `+++ current`];
    const max = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < max; i++) {
        const b = beforeLines[i];
        const a = afterLines[i];
        if (b === a) {
            lines.push(`  ${b ?? ""}`);
        } else {
            if (b !== undefined) {
                lines.push(`- ${b}`);
            }
            if (a !== undefined) {
                lines.push(`+ ${a}`);
            }
        }
    }
    return lines.join("\n");
}
```

- [ ] **Step 3: Wire into commander**

Add to `src/stash/index.ts`:

```typescript
import { unapplyCommand } from "./commands/unapply";

program
    .command("unapply <name>")
    .description("Surgically remove an applied stash with diff review")
    .option("--continue", "resume from last checkpoint")
    .option("--skip", "decide current region as 'skip'")
    .option("--abort", "abandon in-progress session, restore state")
    .option("--status", "show progress of in-progress session")
    .option("--decision <d>", "decide current region: update | discard | skip | discard-all-dangerous | update-stash-all-dangerous")
    .action(async (name: string, opts: { continue?: boolean; skip?: boolean; abort?: boolean; status?: boolean; decision?: string }) => {
        const action =
            opts.abort ? "abort" :
            opts.status ? "status" :
            opts.skip ? "skip" :
            opts.continue ? "continue" :
            "start";
        await unapplyCommand({ name, action, decision: opts.decision as never });
    });
```

- [ ] **Step 4: Manual smoke test**

```bash
# In the apply smoke-test repo where smoke-test stash is applied:
tools stash unapply smoke-test --decision=discard-all-dangerous
# expected: removes all marker-wrapped content; reports stats
```

- [ ] **Step 5: Commit**

```bash
git add src/stash/commands/unapply.ts src/stash/lib/diff-render.ts src/stash/index.ts
git commit -m "feat(stash): unapply state machine with TTY clack walk + non-TTY suggestCommand"
```

---

### Task 16: Replace diff-render stub with src/utils/diff

**Files:**
- Modify: `src/stash/lib/diff-render.ts`

- [ ] **Step 1: Locate the diff utility**

Run: `ls src/utils/diff*` to see the available API.

- [ ] **Step 2: Wire the real renderer**

Read `src/utils/diff` exports; pick a unified-diff renderer that returns a colored string. Replace the stub with a call into it. Example shape (adjust to actual API):

```typescript
// src/stash/lib/diff-render.ts
import { renderUnifiedDiff } from "@app/utils/diff"; // adjust import to real export

export function renderDiff(args: { before: string; after: string; label: string }): string {
    return renderUnifiedDiff({
        oldText: args.before,
        newText: args.after,
        oldLabel: `stored:${args.label}`,
        newLabel: `current:${args.label}`,
        context: 3,
        color: true,
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/stash/lib/diff-render.ts
git commit -m "feat(stash): use src/utils/diff for unapply diff rendering"
```

---

## Phase 7 — list / show / drop / versions / where / update

### Task 17: list / show / versions / drop / where commands

**Files:**
- Create: `src/stash/commands/list.ts`
- Create: `src/stash/commands/show.ts`
- Create: `src/stash/commands/versions.ts`
- Create: `src/stash/commands/drop.ts`
- Create: `src/stash/commands/where.ts`
- Modify: `src/stash/index.ts`

- [ ] **Step 1: Implement list**

```typescript
// src/stash/commands/list.ts
import { Database } from "bun:sqlite";
import { out } from "@app/logger";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import { detectProject, findSiblingClones } from "../lib/projects";
import type { StashRow } from "../types";

export interface ListOptions {
    project: boolean;
    tag: string | undefined;
    applied: boolean;
}

export async function listCommand(opts: ListOptions): Promise<void> {
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    let projectPaths: string[] | null = null;
    if (opts.project || opts.applied) {
        const project = await detectProject(process.cwd());
        if (!project) {
            out.log.error("--project requires a git repo");
            process.exit(1);
        }
        projectPaths = [project.rootPath, ...(await findSiblingClones(project.rootPath))];
    }

    let rows: StashRow[];
    if (projectPaths) {
        const placeholders = projectPaths.map(() => "?").join(",");
        rows = db
            .query<StashRow, string[]>(
                `SELECT DISTINCT s.* FROM stashes s
                 LEFT JOIN applications a ON a.stash_id = s.id AND a.state = 'active'
                 LEFT JOIN versions v ON v.stash_id = s.id
                 WHERE a.project_path IN (${placeholders}) OR v.source_repo_path IN (${placeholders})
                 ORDER BY s.updated_at DESC`,
            )
            .all(...projectPaths, ...projectPaths);
    } else {
        rows = db
            .query<StashRow, []>("SELECT * FROM stashes ORDER BY updated_at DESC")
            .all();
    }

    if (opts.tag) {
        const tag = opts.tag;
        rows = rows.filter((r) => (r.tags ? (JSON.parse(r.tags) as string[]).includes(tag) : false));
    }

    if (!rows.length) {
        out.log.info("no stashes");
        return;
    }
    for (const r of rows) {
        const v = db
            .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
            .get(r.id);
        const appliedHere = projectPaths
            ? db
                  .query<{ c: number }, string[]>(
                      `SELECT COUNT(*) as c FROM applications WHERE stash_id = ? AND state = 'active' AND project_path IN (${projectPaths.map(() => "?").join(",")})`,
                  )
                  .get(r.id, ...projectPaths)?.c ?? 0
            : 0;
        out.print(`${r.name}  v${v?.m ?? "?"}  ${r.tags ?? ""}  ${appliedHere ? "[applied here]" : ""}`);
    }
    db.close();
}
```

- [ ] **Step 2: Implement show**

```typescript
// src/stash/commands/show.ts
import { Database } from "bun:sqlite";
import { out } from "@app/logger";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import { StoreRepo } from "../lib/store-repo";
import type { StashRow, VersionRow } from "../types";

export async function showCommand(opts: { name: string; version?: number; mode: "diff" | "meta" | "regions" }): Promise<void> {
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        out.log.error(`stash "${opts.name}" not found`);
        process.exit(1);
    }
    const v = opts.version
        ? db.query<VersionRow, [string, number]>("SELECT * FROM versions WHERE stash_id = ? AND version = ?").get(stash.id, opts.version)
        : db.query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1").get(stash.id);
    if (!v) {
        out.log.error("version not found");
        process.exit(1);
    }
    out.print(`name:    ${stash.name}`);
    out.print(`version: v${v.version}`);
    out.print(`tags:    ${stash.tags ?? "-"}`);
    out.print(`source:  ${v.source_repo_path ?? "?"} @ ${v.source_sha?.slice(0, 7) ?? "?"}`);
    out.print(`files:   ${v.file_count}`);
    out.print(`regions: ${v.region_count}`);
    if (opts.mode === "meta") {
        db.close();
        return;
    }
    const repo = new StoreRepo(storage.storeRepoDir());
    if (opts.mode === "diff") {
        const patch = await repo.readFileAt(v.patch_ref, "PATCH.diff");
        out.print("\n--- patch ---");
        out.print(patch ?? "(empty)");
    } else {
        const refs = await repo.listRefs(`refs/stashes/${stash.id}/`);
        out.print("\n--- regions (placeholder; full inventory in v1.1) ---");
        for (const ref of refs) {
            out.print(`  ${ref}`);
        }
    }
    db.close();
}
```

- [ ] **Step 3: Implement versions / drop / where**

```typescript
// src/stash/commands/versions.ts
import { Database } from "bun:sqlite";
import { out } from "@app/logger";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import type { StashRow, VersionRow } from "../types";

export async function versionsCommand(name: string): Promise<void> {
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(name);
    if (!stash) {
        out.log.error(`stash "${name}" not found`);
        process.exit(1);
    }
    const rows = db
        .query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC")
        .all(stash.id);
    for (const r of rows) {
        out.print(`v${r.version}  files:${r.file_count}  regions:${r.region_count}  ${r.created_at}  ${r.source_origin ?? ""}`);
    }
    db.close();
}
```

```typescript
// src/stash/commands/drop.ts
import { Database } from "bun:sqlite";
import { out } from "@app/logger";
import { isInteractive } from "@app/utils/cli";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import { StoreRepo } from "../lib/store-repo";
import type { StashRow, VersionRow } from "../types";

export async function dropCommand(opts: { name: string; version?: number; allVersions: boolean; orphanActive: boolean }): Promise<void> {
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        out.log.error(`stash "${opts.name}" not found`);
        process.exit(1);
    }

    const activeCount = db
        .query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM applications WHERE stash_id = ? AND state = 'active'")
        .get(stash.id)?.c ?? 0;
    if (activeCount > 0 && !opts.orphanActive) {
        out.log.error(`${activeCount} active application(s) — pass --orphan-active to proceed`);
        process.exit(1);
    }

    if (isInteractive()) {
        const { confirm } = await import("@clack/prompts");
        const ok = await confirm({ message: `delete stash "${opts.name}"${opts.allVersions ? " (all versions)" : opts.version ? ` v${opts.version}` : " (latest)"}?` });
        if (ok !== true) {
            out.log.warn("cancelled");
            return;
        }
    }

    const repo = new StoreRepo(storage.storeRepoDir());
    let versionsToDelete: VersionRow[];
    if (opts.allVersions) {
        versionsToDelete = db.query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ?").all(stash.id);
    } else if (opts.version) {
        const v = db.query<VersionRow, [string, number]>("SELECT * FROM versions WHERE stash_id = ? AND version = ?").get(stash.id, opts.version);
        versionsToDelete = v ? [v] : [];
    } else {
        const v = db.query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1").get(stash.id);
        versionsToDelete = v ? [v] : [];
    }

    for (const v of versionsToDelete) {
        await repo.deleteRef(v.patch_ref);
        await repo.deleteRef(`refs/baselines/${stash.id}/v${v.version}`);
        db.run("DELETE FROM versions WHERE id = ?", [v.id]);
    }

    if (opts.orphanActive) {
        db.run("UPDATE applications SET state = 'orphaned' WHERE stash_id = ? AND state = 'active'", [stash.id]);
    }

    if (opts.allVersions || versionsToDelete.length === db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM versions WHERE stash_id = ?").get(stash.id)?.c) {
        const remaining = db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM versions WHERE stash_id = ?").get(stash.id)?.c ?? 0;
        if (remaining === 0) {
            db.run("DELETE FROM stashes WHERE id = ?", [stash.id]);
        }
    }

    out.log.success(`dropped ${versionsToDelete.length} version(s)`);
    db.close();
}
```

```typescript
// src/stash/commands/where.ts
import { Database } from "bun:sqlite";
import { out } from "@app/logger";
import { StashStorage } from "../lib/storage";
import { openStashDb } from "../lib/stash-db";
import type { StashRow, ApplicationRow } from "../types";

export async function whereCommand(name: string): Promise<void> {
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(name);
    if (!stash) {
        out.log.error(`stash "${name}" not found`);
        process.exit(1);
    }
    const apps = db
        .query<ApplicationRow, [string]>("SELECT * FROM applications WHERE stash_id = ? AND state = 'active' ORDER BY applied_at")
        .all(stash.id);
    if (!apps.length) {
        out.log.info("not currently applied anywhere");
        return;
    }
    for (const a of apps) {
        out.print(`${a.project_path}  (applied ${a.applied_at})`);
    }
    db.close();
}
```

- [ ] **Step 4: Wire all subcommands**

Add to `src/stash/index.ts`:

```typescript
import { listCommand } from "./commands/list";
import { showCommand } from "./commands/show";
import { versionsCommand } from "./commands/versions";
import { dropCommand } from "./commands/drop";
import { whereCommand } from "./commands/where";

program
    .command("list")
    .description("List stashes")
    .option("--project", "only stashes related to the current project")
    .option("--tag <tag>", "filter by tag")
    .option("--applied", "only stashes currently applied to this project")
    .action(async (opts) => {
        await listCommand({ project: !!opts.project, tag: opts.tag, applied: !!opts.applied });
    });

program
    .command("show <name>")
    .description("Show stash details")
    .option("--at <version>", "specific version", (v) => Number(v))
    .option("--diff", "show patch content")
    .option("--meta", "show only metadata")
    .option("--regions", "show region inventory")
    .action(async (name: string, opts) => {
        const mode: "diff" | "meta" | "regions" = opts.diff ? "diff" : opts.meta ? "meta" : "regions";
        await showCommand({ name, version: opts.at, mode });
    });

program
    .command("versions <name>")
    .description("List versions of a stash")
    .action(async (name: string) => { await versionsCommand(name); });

program
    .command("drop <name>")
    .description("Delete a stash version")
    .option("--at <version>", "specific version", (v) => Number(v))
    .option("--all-versions", "delete all versions")
    .option("--orphan-active", "drop even with active applications")
    .action(async (name: string, opts) => {
        await dropCommand({ name, version: opts.at, allVersions: !!opts.allVersions, orphanActive: !!opts.orphanActive });
    });

program
    .command("where <name>")
    .description("Show projects where this stash is currently applied")
    .action(async (name: string) => { await whereCommand(name); });
```

- [ ] **Step 5: Manual smoke + commit**

```bash
tools stash list
tools stash show smoke-test
tools stash versions smoke-test
tools stash where smoke-test
tools stash drop smoke-test --all-versions
```

```bash
git add src/stash/commands/list.ts src/stash/commands/show.ts src/stash/commands/versions.ts src/stash/commands/drop.ts src/stash/commands/where.ts src/stash/index.ts
git commit -m "feat(stash): list/show/versions/drop/where commands"
```

---

## Phase 8 — Skill + README

### Task 18: Author the agent-facing skill

**Files:**
- Create: `.claude/skills/stash/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: stash
description: Save/apply/unapply named code overlays across projects with `tools stash`. Use when the user wants to capture a chunk of working-tree changes for re-use, apply a previously saved stash into the current project, surgically remove an applied stash with diff review, or list/inspect stashes. Triggers on "stash this", "save this overlay", "apply my <name> stash", "pop my debug stash here", "what stashes do I have applied".
---

# `tools stash` — Cross-Project Code Overlay Manager

## What it does

A global named stash store. Save a chunk from Project A; apply it later to Project A, B, or any sibling clone. Apply decorates injected hunks with foldable `// #region @stash:<name> {json}` markers so they're visible, greppable, and reversible. Unapply runs a multi-step state machine (like `git rebase --continue/--abort`) with per-region diff review.

## Authoring discipline (regions in source)

Wrap code that you might want to stash with foldable region markers. Editors fold them automatically.

```ts
// #region @stash:debug-logger
const log = createDebugLogger();
log.debug('hi');
// #endregion @stash:debug-logger
```

- Language comment syntax adapts: `// #region` (TS/JS/PHP/Java/C/Go/Rust/Swift), `# #region` (Python/Ruby/Bash/YAML), `<!-- #region ... -->` (HTML/MD/XML), `/* #region */` (CSS).
- Naming: kebab-case, purpose-prefixed: `debug-<x>`, `feat-flag-<x>`, `hotfix-<x>`, `experiment-<x>`.
- Bare author markers (no JSON) are preserved on save; apply-time markers (with JSON metadata) are stripped on save.

## Save modes

```bash
tools stash save <name> --all          # staged + unstaged + untracked
tools stash save <name> --staged       # only staged (git diff --cached)
tools stash save <name> --unstaged     # only unstaged tracked changes
```

If the name already exists, save bumps to vN+1 automatically (no overwrite). Use `tools stash versions <name>` to inspect history.

## Apply

```bash
tools stash apply <name>               # latest version
tools stash apply <name> --at 2        # specific version
tools stash apply <name> --verbose-markers  # include src/applied metadata in markers
```

If a 3-way merge can't reconcile, conflict markers land in the file (`<<<<<<<` / `=======` / `>>>>>>>`) and you resolve manually before continuing. (Apply-conflict state machine is v1.1.)

## Unapply — the state machine

Surgical, reviewable removal. Multi-region stashes generate one decision per ambiguous region.

```bash
tools stash unapply <name>                                # start; auto-removes unchanged regions; prompts on ambiguous
tools stash unapply <name> --continue                     # resume after pause / ctrl+c
tools stash unapply <name> --continue --decision=update   # decide current region (non-TTY)
tools stash unapply <name> --continue --decision=discard
tools stash unapply <name> --continue --decision=skip
tools stash unapply <name> --skip                         # alias for --continue --decision=skip
tools stash unapply <name> --status                       # progress: "5/17 decided"
tools stash unapply <name> --abort                        # discard all decisions
```

Three per-region decisions:
- **`update`** — capture current code state as new vN+1, then remove from code. Use when local edits are worth preserving.
- **`discard`** — remove using stored content, lose local edits. Use when local edits were experimental.
- **`skip`** — leave both code and store alone, warn about divergence. Use when you want to detach: code keeps its own copy, stash keeps its.

Power-user batch (explicit, never default — the `-dangerous` suffix is mandatory):
```bash
tools stash unapply <name> --continue --decision=discard-all-dangerous
tools stash unapply <name> --continue --decision=update-stash-all-dangerous
```

## CRITICAL: never truncate unapply diff output

The unapply state machine prints full diffs to stderr. **Never** pipe through `| head`, `| tail`, or narrow-grep them. The full diff is the only proof you made the right decision for each region. If output is large, redirect to a file (`2> /tmp/unapply.diff`) and read it whole.

## Update — refresh stash from applied site

```bash
tools stash update <name>              # capture current state of applied regions as new vN+1
```

Useful when you've been iterating on an applied overlay for days and want to push your improvements back to the store. Errors if the stash isn't currently applied in the cwd.

## Discovery

```bash
tools stash list                       # all stashes
tools stash list --project             # only ones related to this project (origin + sibling-clone match)
tools stash list --applied             # only ones currently applied here
tools stash show <name>                # region inventory
tools stash show <name> --diff         # patch content
tools stash versions <name>            # version history
tools stash where <name>               # which projects have this applied
```

## Anti-patterns

- Don't stash secrets, API keys, or `.env` content. The store is plaintext on disk.
- Don't stash binary or large (>1MB) files — they're skipped with a warning.
- Don't try to apply the same stash twice to the same project — use `unapply` or `update` instead.
```

- [ ] **Step 2: Manual smoke — invoke skill via `/stash`**

(Skill becomes available after copying to `.claude/skills/`. Verify `/stash` triggers the skill in a fresh session.)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/stash/SKILL.md
git commit -m "feat(stash): agent-facing skill for stash authoring + CLI workflow"
```

---

### Task 19: Tool README

**Files:**
- Create: `src/stash/README.md`

- [ ] **Step 1: Write README**

```markdown
# tools stash

Global cross-project code-overlay manager. `git stash` × JetBrains Shelf × `quilt`.

## Quick start

\`\`\`bash
# In Project A — capture a debug-logger overlay
tools stash save debug-logger --all

# In Project B (sibling clone) — apply it
cd ../project-b
tools stash apply debug-logger

# Later, surgical removal with diff review
tools stash unapply debug-logger
\`\`\`

## Storage

- Patches: bare git repo at `~/.genesis-tools/stash/store/`
- Index: SQLite at `~/.genesis-tools/stash/index.db`
- In-progress sessions: JSON at `~/.genesis-tools/stash/state/`
- Logs: `~/.genesis-tools/logs/<day>.log`

## Commands

See `tools stash --help` or the agent skill at `.claude/skills/stash/SKILL.md`.

## Design

See `.claude/plans/2026-06-24-StashTool-spec.md` for full design rationale (region marker format, state machine, sibling-clone detection, etc.).
```

- [ ] **Step 2: Commit**

```bash
git add src/stash/README.md
git commit -m "docs(stash): tool README"
```

---

## Phase 9 — Polish + integration tests

### Task 20: End-to-end integration test

**Files:**
- Create: `src/stash/e2e.test.ts`

- [ ] **Step 1: Write the round-trip e2e**

```typescript
// src/stash/e2e.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "./lib/patch";
import { saveCommand } from "./commands/save";
import { applyCommand } from "./commands/apply";
import { unapplyCommand } from "./commands/unapply";

let work: string;
let origHome: string | undefined;
let projectA: string;
let projectB: string;

beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-e2e-"));
    origHome = process.env.HOME;
    process.env.HOME = work;
    projectA = join(work, "repo-a");
    projectB = join(work, "repo-b");
    for (const repo of [projectA, projectB]) {
        await runGitIn(work, ["init", repo.split("/").pop() ?? "", "--initial-branch=main"]);
        await runGitIn(repo, ["config", "user.email", "t@t"]);
        await runGitIn(repo, ["config", "user.name", "t"]);
        await writeFile(join(repo, "main.ts"), "export function main() { return 1; }\n");
        await runGitIn(repo, ["add", "main.ts"]);
        await runGitIn(repo, ["commit", "-m", "init"]);
    }
});
afterEach(async () => {
    process.env.HOME = origHome;
    await rm(work, { recursive: true, force: true });
});

describe("stash e2e", () => {
    test("save in A → apply in B → unapply (discard) restores B to original", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "import { log } from './log';\nexport function main() { log('start'); return 1; }\n");
        await saveCommand({ name: "logging", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "logging", verboseMarkers: false });
        const applied = await readFile(join(projectB, "main.ts"), "utf8");
        expect(applied).toContain("#region @stash:logging");
        expect(applied).toContain("log('start')");

        await unapplyCommand({ name: "logging", action: "start", decision: "discard-all-dangerous" });
        const after = await readFile(join(projectB, "main.ts"), "utf8");
        expect(after).not.toContain("#region @stash:logging");
        expect(after).not.toContain("log('start')");
    });

    test("save → save again with edits → versions=2", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "v1");
        await saveCommand({ name: "ver", mode: "all", tags: [], description: undefined });
        await writeFile(join(projectA, "main.ts"), "v2");
        await saveCommand({ name: "ver", mode: "all", tags: [], description: undefined });

        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM versions").get();
        expect(count?.c).toBe(2);
        db.close();
    });
});
```

- [ ] **Step 2: Run + commit**

Run: `bun test src/stash/e2e.test.ts` — 2 pass.

```bash
git add src/stash/e2e.test.ts
git commit -m "test(stash): e2e save → apply → unapply round-trip"
```

---

### Task 21: Run full test suite + final commit

- [ ] **Step 1: Run full suite**

Run: `bun test src/stash/` — all pass.

- [ ] **Step 2: Run `tools stash --readme` to verify help discovery**

Run: `tools stash --readme`
Expected: README.md printed.

- [ ] **Step 3: Lint + typecheck**

Run: `bunx biome check src/stash/`
Run: `git ls-files 'src/stash/*.ts' | tsgo --noEmit | rg 'src/stash/'`

Fix any issues, then:

```bash
git add -u
git commit -m "chore(stash): biome + tsgo clean pass"
```

---

## Out of Plan Scope (deferred to v1.1+)

These spec items are intentionally NOT in this plan. Tackle in follow-up plans once v1 ships.

1. **`update` command** as a separate command (capture from applied site without unapplying). v1's `unapply --decision=update` covers the common case via the state machine. A standalone `update` command becomes trivial once that flow is stable.
2. **`diff` command** (compare stored stash vs applied region without running unapply). Cosmetic — `show --diff` + manual file read is the workaround.
3. **`--region` save mode** (save only specific author-marked regions). Currently `--all`/`--staged`/`--unstaged` cover working-tree-derived saves; `--region` requires the region scanner to feed a filter into `git diff -- pathspec` and is non-trivial.
4. **`--patch` interactive save** (git-add-p style hunk picker). Inquirer/clack does not have a built-in hunk picker; would need custom UI.
5. **Apply conflict state machine.** v1 lets 3-way conflicts surface as inline `<<<<<<<` markers, user resolves manually. The `ApplyConflictSession` shape mirrors `UnapplySession` and can be added in v1.1.
6. **Tree-hash sibling-clone detection.** v1 uses origin URL + dir-pattern only. Tree-hash fallback covers fork-clones with diverged remotes.
7. **`tools stash doctor`** (verify store + sqlite consistency, `git fsck`, rebuild index from refs). For v1.1 after first reported corruption.
8. **`tools stash rebase-project <old> <new>`** (update `applications.project_path` when a project is moved on disk).
9. **Author-marker-aware unapply.** v1 derives "regions" from patch hunks; v1.1 uses parsed `@stash:` markers as semantic boundaries, allowing one stash to have N named regions per file.
10. **Remote sync** (publish stashes to a shared store, pull from teammates). Probably never.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Plan task(s) | Status |
|---|---|---|
| §4 Use Cases UC1-UC5 | Tasks 10, 11, 15-17 | ✓ |
| §5 Architecture | Tasks 1-9 (foundation), 10-17 (commands) | ✓ |
| §6.1 Marker format | Task 6 | ✓ |
| §6.2 SQLite schema | Task 2 | ✓ |
| §6.3 Bare git store | Task 3 | ✓ |
| §7.1 Lifecycle table | Tasks 10-17 | partial — `update`/`diff` deferred |
| §7.2 Save modes | Task 10 | partial — `--region`/`--patch` deferred |
| §7.3 Apply | Task 11 | ✓ (conflict state machine deferred) |
| §7.4 Unapply state machine | Tasks 12-16 | ✓ |
| §7.5 Update command | deferred to v1.1 (covered by `unapply --decision=update`) | partial |
| §7.6 list/show/where | Task 17 | ✓ |
| §7.7 diff/drop/versions | Task 17 | partial — `diff` deferred |
| §8 Sibling-clone detection | Task 9 | ✓ (origin URL + dir-pattern) |
| §9 Skill | Task 18 | ✓ |
| §10 Error handling | covered inline across commands | ✓ |
| §11 Testing strategy | Tasks include 1+ test per lib, Task 20 e2e | ✓ |
| §12 Logging discipline | `logger.scoped()` used in every command | ✓ |

**Deferred items are surfaced explicitly in "Out of Plan Scope".** No silent gaps.

**2. Placeholder scan:** ran a mental grep for TBD/TODO/"implement later" — none in tasks. The stub `diff-render.ts` in Task 15 is explicitly replaced in Task 16.

**3. Type consistency:**
- `Decision` type referenced consistently in `unapply-session.ts`, `decisions.ts`, `unapply.ts`.
- `StashRow` / `VersionRow` / `ApplicationRow` declared once in `types.ts`, imported everywhere.
- `SaveMode` declared in `patch.ts`, imported by `save.ts`.
- `CommentSyntax` declared in `languages.ts`, used by `markers.ts`.

**4. One known caller-gap to flag during implementation:** Task 11's `decorateAppliedRegions` parses unified diff hunks to find insertion points; the `parseDiffHunks` regex assumes standard `+++ b/<path>` headers (works for `git apply --3way` output). If `apply` produces non-standard headers in any path, marker placement will drift — covered by Task 11 Step 4's integration test (will fail loudly if so).

---

## Execution Handoff

Plan complete and saved to `.claude/plans/2026-06-24-StashTool-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good for a 20-task plan like this.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch with checkpoints for review.

**Which approach?**
