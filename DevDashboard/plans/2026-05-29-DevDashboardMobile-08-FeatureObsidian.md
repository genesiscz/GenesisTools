# 08 — Feature: Obsidian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first. Work in the `feat/dev-dashboard-mobile` worktree.
> **Depends on 03** (the `@devdashboard/contract` client) and **04** (the Expo app scaffold:
> expo-router, TanStack Query, the transport store, theme tokens, the Appium harness).
>
> **Search docs on demand** (ADR §0.1): before touching `react-native-webview` or
> `@react-native-async-storage`-style native code, query current docs — `context7`
> (`/websites/expo_dev_versions_v55_0_0`), the `expo:building-native-ui` /
> `expo:native-data-fetching` skills, and the WebView reference
> (`react-native-webview/docs/Reference.md`). Versions move; never code a native integration from
> memory.

**Goal:** Ship the Obsidian feature at full parity with the web `/obsidian` route on the Expo SDK 55
mobile app — a vault **tree browser**, a **note reader** that renders the server-provided HTML
(KaTeX / mermaid / highlight.js / callouts / wikilinks intact), **publish / unpublish** with
share-slug awareness, and **mkdir** — all driven through the `@devdashboard/contract` client.

**Architecture:** The web route splits into `tree` (data) + `reader` (HTML). We mirror that split
natively. The **tree** uses `VaultEntry[]` from `/api/obsidian/tree`, rendered as a recursively
collapsible RN list with URL/Zustand-synced expand state and a filter. The **reader** does **not**
re-parse markdown — it renders the **server's already-rendered `html`** (the same string the web
mirror feeds to `dangerouslySetInnerHTML`) inside a `react-native-webview` with injected dark-theme
CSS, intercepting `data-obsidian-note` wikilink taps via the WebView message bridge and routing them
back into expo-router. Publish/unpublish/mkdir are TanStack Query mutations on the contract client.

**Tech Stack:** Expo SDK 55 / RN 0.83 / React 19.2, expo-router v7, TanStack Query v5, Zustand,
`react-native-webview` (already pulled in by plan 06 for the terminal; reused here),
`@devdashboard/contract`. Pure-logic units via the RN test runner (`bun:test` for contract-side
helpers); E2E via Appium (ADR §8).

---

## Renderer decision (PROPOSED — confirm with the user per ADR §0.2 before locking)

**Decision: render the server-provided `html` inside `react-native-webview`. Do NOT use a native
markdown renderer (`react-native-markdown-display` / `react-native-render-html`).**

Evidence (verified 2026-05-29):

1. **The server already renders rich HTML.** `/api/obsidian/note?path=` returns
   `{ source, html, publishedSlug }` where `html` is produced by
   `src/dev-dashboard/lib/obsidian/markdown.ts` using `marked` + `marked-katex-extension` +
   `markedHighlight` (highlight.js) + a mermaid pass + GitHub-style callouts + wikilink anchors
   (`<a … class="dd-wikilink" data-obsidian-note="<vaultPath>">`). It is **sanitized server-side**
   (`sanitizeUrl`, `escapeHtml`). The web reader simply does
   `dangerouslySetInnerHTML={{ __html: data.html }}`.
2. **A native markdown renderer would re-parse `source`** and **lose** KaTeX math, mermaid diagrams,
   syntax-highlighted code, callouts, and the wikilink-tap contract — i.e. it would be a *different*
   renderer, not parity, and would duplicate the entire server pipeline on-device.
3. **`react-native-markdown-display` (iamacup) is no longer maintained** (its README explicitly says
   so and points to `react-native-enriched-markdown`) and lacks the extensions above.
   `react-native-render-html` is only now being revived as `@native-html/render`. Neither matches
   the server's feature set.
4. **`react-native-webview` is already a project dependency** (plan 06 uses it for the terminal,
   with the `patch-package` New-Arch diff). Rendering an HTML string is its core, low-risk use case
   (`source={{ html, baseUrl }}`), so there is **zero new native dependency** for this feature.

Trade-offs acknowledged: a WebView is heavier than native views and theming happens via injected CSS
rather than RN styles. That is the right trade for **pixel parity with the web reader** and for not
re-implementing KaTeX/mermaid/highlight on-device. If the user prefers a "more native feel" later, a
`TerminalRenderer`-style `NoteRenderer` seam is left in place (see Task 4) so a native driver can be
added without touching the route — but v1 ships the WebView driver only.

**Critical: the server `html` is incomplete on its own — it needs client-side assets.** The
fidelity claim only holds if `buildNoteDocument` loads the same assets the existing **share page**
(`src/dev-dashboard/lib/obsidian/share-template.ts`) loads. Verified from that file + `markdown.ts`:
- **highlight.js** emits `hljs-*` classes but is **monochrome without a theme CSS** → load
  `highlight.js/styles/atom-one-dark` (the share page uses the CDN URL + SRI).
- **KaTeX** (`marked-katex-extension`) emits positioned spans that are **visually broken without
  `katex.min.css`** → load it.
- **mermaid** is emitted as **raw escaped source** (`markdown.ts:447`:
  `<div class="mermaid">…escaped code…</div>`) and only becomes a diagram when **mermaid.js runs**
  client-side (`mermaid.initialize({ startOnLoad: true })`) → import the mermaid ESM module + init.

`buildNoteDocument` (Task 3) **mirrors `share-template.ts`'s `<head>`/`<script>`** for these three.
The `note` endpoint does **not** return the `hasMath`/`hasMermaid` flags the share page uses (it
returns only `{ source, html, publishedSlug }`), so the builder **detects** them from the html string
with the same heuristic the server uses internally (`html.includes('class="katex')` /
`html.includes('<div class="mermaid"')`) and loads KaTeX/mermaid only when present (hljs theme always,
since code is common). Asset URLs + SRI are **copied verbatim** from `share-template.ts` (keep them in
sync; a future task could export them from a shared const). **Caveat (CDN dependency):** these load
from jsDelivr, so a fully-offline device shows raw math/mermaid/monochrome code — acceptable for v1
(parity with the share page, which also uses the CDN); a later task can have the Agent self-host the
assets and point `buildNoteDocument` at `<baseUrl>/assets/...` for offline fidelity.

---

## Source-of-truth shapes (read, do not guess)

From `src/dev-dashboard/lib/obsidian/types.ts` + `src/utils/obsidian/vault-tree.ts` +
`src/dev-dashboard/config.ts` + `00-current-architecture.md` §obsidian:

```ts
// VaultEntry — src/utils/obsidian/vault-tree.ts
export interface VaultEntry {
    name: string;
    relativePath: string;
    isDirectory: boolean;
    children?: VaultEntry[];
}

// RenderedNote — the /api/obsidian/note GET response
export interface RenderedNote {
    source: string;          // raw markdown (unused by the WebView reader; kept for parity/debug)
    html: string;            // server-rendered, sanitized HTML
    publishedSlug: string | null;
}

// PublishedNote — src/dev-dashboard/config.ts
export interface PublishedNote {
    slug: string;
    vaultPath: string;
    publishedAt: string;
}
```

Routes (auth = `Authorization: Basic …` via the transport's `authHeader()`; share is token-gated):

- `GET  /api/obsidian/tree`              → `{ entries: VaultEntry[] }`
- `GET  /api/obsidian/note?path=<rel>`   → `{ source, html, publishedSlug }` (404 if missing)
- `POST /api/obsidian/publish`  `{ path }`     → `{ note: PublishedNote }`
- `POST /api/obsidian/unpublish` `{ slug }`    → `{ remaining: PublishedNote[] }`
- `POST /api/obsidian/mkdir`    `{ relativeDir }` → `{ ok, relativeDir }`
- public share URL = `<baseUrl>/share/<slug>` (the reader surfaces it; no auth on that path).

---

## File Structure

**Create (mobile app — under `DevDashboard/mobile/`):**

- `app/(tabs)/obsidian.tsx` — the Obsidian route screen (tree panel + reader, responsive split).
- `src/features/obsidian/ObsidianTree.tsx` — recursive collapsible vault tree (one responsibility:
  render `VaultEntry[]` + emit `onSelect` / `onFolderToggle`).
- `src/features/obsidian/ObsidianTreeNode.tsx` — a single tree row (folder or file).
- `src/features/obsidian/ObsidianReader.tsx` — the note reader: header (path, publish/unpublish,
  share-slug copy) + the `NoteRenderer` body.
- `src/features/obsidian/NoteRenderer.tsx` — the `NoteRenderer` interface + `WebViewNoteRenderer`
  driver (renders server `html`, intercepts wikilink taps + external links).
- `src/features/obsidian/note-html.ts` — pure helpers: `buildNoteDocument(html)` (wraps the server
  HTML with `<head>` theme CSS + the wikilink/link tap bridge script), `parseNoteMessage(raw)`
  (parses the WebView → native message), `shareUrl(baseUrl, slug)`.
- `src/features/obsidian/vault-filter.ts` — pure `filterVaultEntries(entries, query)` (mirrors the
  web `filterEntries`).
- `src/features/obsidian/expanded-dirs.ts` — pure `expandedDirsForNote` / `parseOpenDirs` /
  `serializeOpenDirs` / `expandedDirsForFolderToggle` (mirrors `@app/utils/obsidian/expanded-dirs`).
- `src/features/obsidian/useObsidian.ts` — TanStack Query hooks: `useVaultTree`, `useNote(path)`,
  `usePublishNote`, `useUnpublishNote`, `useMkdir`.
- `src/features/obsidian/ObsidianNewFolderModal.tsx` — the mkdir modal (folder-name input).
- `e2e/pages/obsidian.page.ts` — the `ObsidianPage` Page Object.
- `e2e/specs/obsidian.spec.ts` — the Appium spec (tree loads → note opens → renders → publish).

**Modify:**

- `src/features/obsidian/note-html.test.ts`, `vault-filter.test.ts`, `expanded-dirs.test.ts` —
  RN-test-runner unit tests (created alongside, listed per-task).
- `src/lib/contract.ts` (from plan 04) — confirm `obsidian.tree/note/publish/unpublish/mkdir`
  exist on the client; if 03 left `mkdir` out, add it (Task 1 verifies).

> **Path note:** the mobile app uses its own `src/` (no `@app/*` alias). It imports the contract via
> the workspace package name `@devdashboard/contract` (per ADR §1 / plan 03–04). Accessibility IDs
> for E2E are set with `accessibilityLabel` + `testID` (Appium reads `testID` as the iOS
> accessibility-id; see ADR §8).

---

### Task 0: Verify deps + contract methods are present

**Files:**
- Modify (only if a method is missing): `src/dev-dashboard/contract/endpoints.ts`,
  `src/dev-dashboard/contract/client.ts`

- [ ] **Step 1: Confirm `react-native-webview` is installed (added by plan 06)**

Run (from `DevDashboard/mobile/`):
`grep -n "react-native-webview" package.json || echo "MISSING"`
Expected: a version line (plan 06 added it). If `MISSING`, install it the SDK-55 way (ADR §6 install
rule — native modules via `npx expo install`, never `bun add`):
`npx expo install react-native-webview`

- [ ] **Step 2: Confirm the contract exposes every Obsidian method**

Run (from repo root):
`rg -n "obsidian" src/dev-dashboard/contract/client.ts src/dev-dashboard/contract/endpoints.ts`
Expected: `paths.obsidianTree`, `paths.obsidianNote`, plus an `obsidian` client group with
`tree`, `note`, `publish`, `unpublish`, **and `mkdir`**. Plan 03 defined `tree`/`note`; if
`publish`/`unpublish`/`mkdir` are absent, add them now (Steps 3–4). If all present, skip to Task 1.

- [ ] **Step 3: Add ONLY the missing path builders to `endpoints.ts`**

Plan 03 already defined `obsidianTree` and `obsidianNote` in the `paths` object — do **not** add them
again (duplicate keys). Add only the three that are missing:

```typescript
    // obsidianTree / obsidianNote already exist (plan 03) — add only these:
    obsidianPublish: () => "/api/obsidian/publish",
    obsidianUnpublish: () => "/api/obsidian/unpublish",
    obsidianMkdir: () => "/api/obsidian/mkdir",
```

And the response aliases (next to `ObsidianTreeRes`):

```typescript
import type { PublishedNote, RenderedNote, VaultEntry } from "@app/dev-dashboard/contract/dto";

export type ObsidianTreeRes = { entries: VaultEntry[] };
export type ObsidianNoteRes = RenderedNote;
export type ObsidianPublishRes = { note: PublishedNote };
export type ObsidianUnpublishRes = { remaining: PublishedNote[] };
export type ObsidianMkdirRes = { ok: boolean; relativeDir: string };
```

> If `RenderedNote` / `PublishedNote` are not yet in `dto.ts`, add them there as pure types (they
> already are pure — see "Source-of-truth shapes" above) and re-run the contract purity test
> (`bun test src/dev-dashboard/contract/contract-purity.test.ts`).

- [ ] **Step 4: Add the `obsidian` client group to `client.ts`**

Inside the object returned by `createDashboardClient`, alongside `system`/`ttyd`/`qa`:

```typescript
        obsidian: {
            tree: () => getJson<ObsidianTreeRes>(paths.obsidianTree()),
            note: (path: string) => getJson<ObsidianNoteRes>(paths.obsidianNote(path)),
            publish: (path: string) => post<ObsidianPublishRes>(paths.obsidianPublish(), { path }),
            unpublish: (slug: string) => post<ObsidianUnpublishRes>(paths.obsidianUnpublish(), { slug }),
            mkdir: (relativeDir: string) => post<ObsidianMkdirRes>(paths.obsidianMkdir(), { relativeDir }),
        },
```

(Import the new `Obsidian*Res` aliases at the top of `client.ts`.)

- [ ] **Step 5: Typecheck + run the contract client test**

Run: `bunx tsgo --noEmit | rg "contract/(client|endpoints)"`
Expected: no errors.
Run: `bun test src/dev-dashboard/contract/`
Expected: PASS (existing tests still green; purity guard still green).

- [ ] **Step 6: Commit (only if you changed the contract)**

```bash
git add src/dev-dashboard/contract/endpoints.ts src/dev-dashboard/contract/client.ts src/dev-dashboard/contract/dto.ts
git commit -m "feat(dd-contract): complete obsidian client group (publish/unpublish/mkdir)"
```

---

### Task 1: Pure expand-state helpers (`expanded-dirs.ts`) — TDD

These mirror `@app/utils/obsidian/expanded-dirs` used by the web route, so the tree's expand/collapse
behavior and the "open the note's ancestor folders" behavior match exactly. Mobile cannot import the
`@app/*` util (no alias across the Expo boundary), so we re-implement the tiny pure functions and
unit-test them.

**Files:**
- Create: `src/features/obsidian/expanded-dirs.ts`
- Test: `src/features/obsidian/expanded-dirs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import {
    expandedDirsForFolderToggle,
    expandedDirsForNote,
    parseOpenDirs,
    serializeOpenDirs,
} from "./expanded-dirs";

describe("parseOpenDirs / serializeOpenDirs", () => {
    it("round-trips a comma-joined set", () => {
        const set = parseOpenDirs("a,a/b,c");
        expect([...set].sort()).toEqual(["a", "a/b", "c"]);
        expect(serializeOpenDirs(set).split(",").sort()).toEqual(["a", "a/b", "c"]);
    });

    it("parses undefined/empty as an empty set", () => {
        expect(parseOpenDirs(undefined).size).toBe(0);
        expect(parseOpenDirs("").size).toBe(0);
        expect(serializeOpenDirs(new Set())).toBe("");
    });
});

describe("expandedDirsForNote", () => {
    it("adds every ancestor folder of the note path", () => {
        const next = expandedDirsForNote("ČEZ/bun/Analysis.md", parseOpenDirs("other"));
        expect([...next].sort()).toEqual(["other", "ČEZ", "ČEZ/bun"].sort());
    });

    it("a top-level note adds no folders", () => {
        expect(expandedDirsForNote("README.md", new Set()).size).toBe(0);
    });
});

describe("expandedDirsForFolderToggle", () => {
    it("adds on expand and removes on collapse", () => {
        const opened = expandedDirsForFolderToggle("ČEZ", true, new Set());
        expect(opened.has("ČEZ")).toBe(true);
        const closed = expandedDirsForFolderToggle("ČEZ", false, opened);
        expect(closed.has("ČEZ")).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `DevDashboard/mobile/`): `bun test src/features/obsidian/expanded-dirs.test.ts`
Expected: FAIL — `Cannot find module './expanded-dirs'`.

- [ ] **Step 3: Implement `expanded-dirs.ts`**

```typescript
export function parseOpenDirs(serialized: string | undefined): Set<string> {
    if (!serialized) {
        return new Set();
    }

    return new Set(serialized.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
}

export function serializeOpenDirs(dirs: ReadonlySet<string>): string {
    return [...dirs].join(",");
}

export function ancestorDirsOf(notePath: string): string[] {
    const normalized = notePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    parts.pop();

    const dirs: string[] = [];
    let prefix = "";

    for (const part of parts) {
        if (!part) {
            continue;
        }

        prefix = prefix ? `${prefix}/${part}` : part;
        dirs.push(prefix);
    }

    return dirs;
}

export function expandedDirsForNote(notePath: string, current: ReadonlySet<string>): Set<string> {
    const next = new Set(current);

    for (const dir of ancestorDirsOf(notePath)) {
        next.add(dir);
    }

    return next;
}

export function expandedDirsForFolderToggle(
    dir: string,
    expanded: boolean,
    current: ReadonlySet<string>
): Set<string> {
    const next = new Set(current);

    if (expanded) {
        next.add(dir);
    } else {
        next.delete(dir);
    }

    return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/features/obsidian/expanded-dirs.test.ts`
Expected: PASS (6 assertions across 3 describes).

- [ ] **Step 5: Commit**

```bash
git add src/features/obsidian/expanded-dirs.ts src/features/obsidian/expanded-dirs.test.ts
git commit -m "feat(mobile-obsidian): pure expand-state helpers (parity with web expanded-dirs)"
```

---

### Task 2: Pure vault filter (`vault-filter.ts`) — TDD

Mirrors the web `filterEntries` in `ObsidianTree.tsx`: case-insensitive, keeps a folder if its name
matches OR it has matching descendants.

**Files:**
- Create: `src/features/obsidian/vault-filter.ts`
- Test: `src/features/obsidian/vault-filter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import type { VaultEntry } from "@devdashboard/contract";
import { filterVaultEntries } from "./vault-filter";

const tree: VaultEntry[] = [
    {
        name: "ČEZ",
        relativePath: "ČEZ",
        isDirectory: true,
        children: [
            { name: "Analysis.md", relativePath: "ČEZ/Analysis.md", isDirectory: false },
            { name: "Notes.md", relativePath: "ČEZ/Notes.md", isDirectory: false },
        ],
    },
    { name: "README.md", relativePath: "README.md", isDirectory: false },
];

describe("filterVaultEntries", () => {
    it("returns the input unchanged for an empty query", () => {
        expect(filterVaultEntries(tree, "")).toEqual(tree);
    });

    it("keeps a folder whose descendant matches, pruning non-matches", () => {
        const out = filterVaultEntries(tree, "analysis");
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe("ČEZ");
        expect(out[0].children).toHaveLength(1);
        expect(out[0].children?.[0].name).toBe("Analysis.md");
    });

    it("keeps a folder when the folder name itself matches (children FILTERED — web parity)", () => {
        // EXACT parity with the web `filterEntries`: a folder-name match returns the folder with its
        // *filtered* children. Since neither child matches "čez", children is empty. (The tree UI
        // then renders the matched folder with no visible leaves under it.)
        const out = filterVaultEntries(tree, "čez");
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe("ČEZ");
        expect(out[0].children).toHaveLength(0);
    });

    it("folder-name match WITH a matching descendant keeps only the matching child", () => {
        const out = filterVaultEntries(tree, "analysis");
        // "ČEZ" name does not match "analysis", but the descendant does, so the folder is kept with
        // the filtered child. (Covered above too; this asserts the children array explicitly.)
        expect(out[0].children?.map((c) => c.name)).toEqual(["Analysis.md"]);
    });

    it("matches a top-level file", () => {
        const out = filterVaultEntries(tree, "readme");
        expect(out.map((e) => e.name)).toEqual(["README.md"]);
    });

    it("drops everything when nothing matches", () => {
        expect(filterVaultEntries(tree, "zzz")).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/features/obsidian/vault-filter.test.ts`
Expected: FAIL — `Cannot find module './vault-filter'`.

- [ ] **Step 3: Implement `vault-filter.ts`**

```typescript
import type { VaultEntry } from "@devdashboard/contract";

export function filterVaultEntries(entries: VaultEntry[], rawQuery: string): VaultEntry[] {
    const query = rawQuery.trim().toLowerCase();

    if (!query) {
        return entries;
    }

    return entries.flatMap((entry) => {
        if (entry.isDirectory) {
            const children = filterVaultEntries(entry.children ?? [], query);

            if (children.length > 0 || entry.name.toLowerCase().includes(query)) {
                return [{ ...entry, children }];
            }

            return [];
        }

        return entry.name.toLowerCase().includes(query) ? [entry] : [];
    });
}
```

> **Exact parity with the web `filterEntries`** (in `ObsidianTree.tsx`): keep a directory when its
> name matches OR it has matching descendants, and return it with the **filtered** `children` in both
> cases. A folder-name-only match therefore yields `children: []` (the matched folder shows with no
> visible leaves). This is intentionally identical to the web — do NOT "improve" it to keep all
> original children; the brief is parity and the web tree relies on this behavior.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/features/obsidian/vault-filter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/obsidian/vault-filter.ts src/features/obsidian/vault-filter.test.ts
git commit -m "feat(mobile-obsidian): pure vault tree filter (parity with web filterEntries)"
```

---

### Task 3: Note-HTML document builder + message parser (`note-html.ts`) — TDD

This is the heart of the renderer decision. The server gives us a `<body>`-fragment `html`. We wrap
it into a full HTML document with: (a) the dark theme CSS so it matches the app, (b) the **client
assets** that the server html depends on — highlight.js theme CSS (always), KaTeX CSS (when math is
present), and the mermaid ESM module + init (when a mermaid block is present) — mirroring
`src/dev-dashboard/lib/obsidian/share-template.ts`, and (c) a small bridge script that posts a JSON
message to native when the user taps a `data-obsidian-note` wikilink or an external link. We also
parse those messages.

**Files:**
- Create: `src/features/obsidian/note-html.ts`
- Test: `src/features/obsidian/note-html.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { buildNoteDocument, parseNoteMessage, shareUrl } from "./note-html";

describe("buildNoteDocument", () => {
    it("embeds the server html fragment inside a full document with theme + bridge", () => {
        const doc = buildNoteDocument('<h1>Hi</h1><a data-obsidian-note="ČEZ/x.md">x</a>');
        expect(doc).toContain("<!doctype html>");
        expect(doc).toContain('<meta name="viewport"');
        expect(doc).toContain("<h1>Hi</h1>");
        // theme tokens present (we inject CSS, not RN styles, for the WebView body):
        expect(doc).toContain("--dd-bg");
        // bridge present:
        expect(doc).toContain("ReactNativeWebView.postMessage");
        expect(doc).toContain("data-obsidian-note");
    });

    it("always loads the highlight.js theme CSS (code blocks are common)", () => {
        const doc = buildNoteDocument("<pre><code>x</code></pre>");
        expect(doc).toContain("highlightjs/cdn-release");
        expect(doc).toContain("atom-one-dark");
    });

    it("loads KaTeX CSS ONLY when math is present (detected from the html)", () => {
        const withMath = buildNoteDocument('<span class="katex">x</span>');
        const without = buildNoteDocument("<p>plain</p>");
        expect(withMath).toContain("katex.min.css");
        expect(without).not.toContain("katex.min.css");
    });

    it("imports + inits mermaid ONLY when a mermaid block is present", () => {
        const withMermaid = buildNoteDocument('<div class="mermaid">graph TD; A--&gt;B;</div>');
        const without = buildNoteDocument("<p>plain</p>");
        expect(withMermaid).toContain("mermaid.esm.min.mjs");
        expect(withMermaid).toContain("mermaid.initialize");
        expect(withMermaid).toContain('startOnLoad: true');
        expect(without).not.toContain("mermaid.esm.min.mjs");
    });

    it("keeps the click bridge in <head> so body content cannot terminate it", () => {
        const doc = buildNoteDocument("<p>before</script><script>alert(1)</script>after</p>");
        // The bridge script lives in <head> BEFORE the body, so body content (already
        // server-sanitized) cannot terminate OUR injected bridge <script> block.
        const headEnd = doc.indexOf("</head>");
        const bridge = doc.indexOf("ReactNativeWebView.postMessage");
        expect(bridge).toBeGreaterThan(-1);
        expect(bridge).toBeLessThan(headEnd);
    });
});

describe("parseNoteMessage", () => {
    it("parses a wikilink-tap message", () => {
        const msg = parseNoteMessage(JSON.stringify({ type: "note", path: "ČEZ/x.md" }));
        expect(msg).toEqual({ type: "note", path: "ČEZ/x.md" });
    });

    it("parses an external-link message", () => {
        const msg = parseNoteMessage(JSON.stringify({ type: "external", url: "https://x.dev" }));
        expect(msg).toEqual({ type: "external", url: "https://x.dev" });
    });

    it("returns null for malformed or unknown messages", () => {
        expect(parseNoteMessage("not json")).toBeNull();
        expect(parseNoteMessage(JSON.stringify({ type: "nope" }))).toBeNull();
        expect(parseNoteMessage(JSON.stringify({ type: "note" }))).toBeNull();
    });
});

describe("shareUrl", () => {
    it("builds <baseUrl>/share/<slug>, trimming a trailing slash", () => {
        expect(shareUrl("http://mac.local:3042/", "abc123")).toBe("http://mac.local:3042/share/abc123");
        expect(shareUrl("http://mac.local:3042", "abc123")).toBe("http://mac.local:3042/share/abc123");
    });

    it("returns null for a missing slug", () => {
        expect(shareUrl("http://h", null)).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/features/obsidian/note-html.test.ts`
Expected: FAIL — `Cannot find module './note-html'`.

- [ ] **Step 3: Implement `note-html.ts`**

```typescript
export type NoteMessage =
    | { type: "note"; path: string }
    | { type: "external"; url: string };

const THEME_CSS = `
:root {
    --dd-bg: #0c0e10;
    --dd-text-primary: #e6e9ec;
    --dd-text-secondary: #aab2bd;
    --dd-text-muted: #6b7480;
    --dd-border: #2a2f36;
    --dd-accent: #58a6ff;
    --dd-code-bg: #15181c;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body {
    margin: 0;
    padding: 0;
    background: var(--dd-bg);
    color: var(--dd-text-primary);
    font: 16px/1.65 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
}
.dd-note-root { padding: 16px 18px 64px; max-width: 760px; margin: 0 auto; word-wrap: break-word; overflow-wrap: anywhere; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; }
h1 { font-size: 1.7em; }
h2 { font-size: 1.4em; border-bottom: 1px solid var(--dd-border); padding-bottom: 0.2em; }
a { color: var(--dd-accent); text-decoration: none; }
a:active { opacity: 0.7; }
.dd-wikilink { color: var(--dd-accent); }
.dd-wikilink-unresolved { color: var(--dd-text-muted); cursor: default; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
code { background: var(--dd-code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--dd-code-bg); padding: 12px 14px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--dd-border); }
pre code { background: none; padding: 0; }
img { max-width: 100%; height: auto; border-radius: 8px; }
blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid var(--dd-border); color: var(--dd-text-secondary); }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--dd-border); padding: 6px 10px; }
hr { border: none; border-top: 1px solid var(--dd-border); margin: 2em 0; }
.markdown-alert { border-left: 3px solid var(--dd-border); border-radius: 6px; padding: 8px 14px; margin: 1em 0; background: rgba(255,255,255,0.03); }
.markdown-alert-title { display: flex; align-items: center; gap: 6px; font-weight: 600; margin: 0 0 0.4em; }
.dd-md-tag, .dd-md-inline-tag { display: inline-block; background: var(--dd-code-bg); border: 1px solid var(--dd-border); border-radius: 999px; padding: 0 8px; font-size: 0.8em; color: var(--dd-text-secondary); }
.katex { font-size: 1em; color: var(--dd-text-primary); }
.katex-display { margin: 1.2em 0; overflow-x: auto; overflow-y: hidden; }
.mermaid { background: var(--dd-code-bg); border: 1px solid var(--dd-border); border-radius: 8px; padding: 12px; overflow-x: auto; }
`;

// Asset URLs + SRI copied verbatim from src/dev-dashboard/lib/obsidian/share-template.ts.
// KEEP IN SYNC with that file (a later task can export them from a shared const module).
const HLJS_CSS_URL = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/atom-one-dark.min.css";
const HLJS_CSS_SRI = "sha384-oaMLBGEzBOJx3UHwac0cVndtX5fxGQIfnAeFZ35RTgqPcYlbprH9o9PUV/F8Le07";
const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
const KATEX_CSS_SRI = "sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+";
const MERMAID_JS_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs";

const MERMAID_SCRIPT = `
<script type="module">
import mermaid from "${MERMAID_JS_URL}";
mermaid.initialize({
    startOnLoad: true,
    theme: "dark",
    themeVariables: {
        background: "#15181c",
        primaryColor: "#15181c",
        primaryTextColor: "#e6e9ec",
        primaryBorderColor: "#58a6ff",
        lineColor: "#6b7480",
        secondaryColor: "#101316",
        tertiaryColor: "#0c0e10",
        nodeBorder: "#58a6ff",
        clusterBkg: "#15181c",
        clusterBorder: "#2a2f36"
    },
    securityLevel: "strict"
});
</script>`;

/** Same heuristic the server (`renderMarkdown`) uses internally to detect math/mermaid. */
function htmlHasMath(html: string): boolean {
    return /class="katex(?:[ "])/.test(html);
}

function htmlHasMermaid(html: string): boolean {
    return html.includes('<div class="mermaid"');
}

const BRIDGE_SCRIPT = `
(function () {
    function post(payload) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
    }
    document.addEventListener("click", function (event) {
        var el = event.target;
        while (el && el !== document.body) {
            if (el.tagName === "A") {
                var note = el.getAttribute("data-obsidian-note");
                if (note) {
                    event.preventDefault();
                    post({ type: "note", path: note });
                    return;
                }
                var href = el.getAttribute("href") || "";
                if (/^https?:/i.test(href)) {
                    event.preventDefault();
                    post({ type: "external", url: href });
                    return;
                }
            }
            el = el.parentElement;
        }
    }, true);
})();
`;

export function buildNoteDocument(bodyHtml: string): string {
    const head: string[] = [
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
        '<meta name="referrer" content="no-referrer" />',
        // hljs theme is always loaded (code blocks are common; monochrome without it):
        `<link rel="stylesheet" href="${HLJS_CSS_URL}" integrity="${HLJS_CSS_SRI}" crossorigin="anonymous" />`,
        `<style>${THEME_CSS}</style>`,
        // bridge MUST precede the body so body content can never terminate it:
        `<script>${BRIDGE_SCRIPT}</script>`,
    ];

    if (htmlHasMath(bodyHtml)) {
        head.splice(
            3,
            0,
            `<link rel="stylesheet" href="${KATEX_CSS_URL}" integrity="${KATEX_CSS_SRI}" crossorigin="anonymous" />`
        );
    }

    const body: string[] = [`<div class="dd-note-root">${bodyHtml}</div>`];

    if (htmlHasMermaid(bodyHtml)) {
        body.push(MERMAID_SCRIPT);
    }

    return [
        "<!doctype html>",
        '<html lang="en"><head>',
        head.join(""),
        "</head><body>",
        body.join(""),
        "</body></html>",
    ].join("");
}

export function parseNoteMessage(raw: string): NoteMessage | null {
    let data: unknown;

    try {
        data = JSON.parse(raw);
    } catch {
        return null;
    }

    if (typeof data !== "object" || data === null) {
        return null;
    }

    const obj = data as Record<string, unknown>;

    if (obj.type === "note" && typeof obj.path === "string" && obj.path.length > 0) {
        return { type: "note", path: obj.path };
    }

    if (obj.type === "external" && typeof obj.url === "string" && obj.url.length > 0) {
        return { type: "external", url: obj.url };
    }

    return null;
}

export function shareUrl(baseUrl: string, slug: string | null): string | null {
    if (!slug) {
        return null;
    }

    return `${baseUrl.replace(/\/$/, "")}/share/${slug}`;
}
```

> Note on `SafeJSON`: `SafeJSON` is a repo (`@app/utils/json`) construct; the mobile app does not
> have the `@app/*` alias, so in the Expo project use the standard global `JSON` (Biome's
> `JSON`-restriction rule is scoped to the repo's `src/`, not the Expo sub-project — confirm in plan
> 04's lint config). If plan 04 wired a mobile `SafeJSON`, use that import instead. The bridge
> string is static and contains no untrusted interpolation.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/features/obsidian/note-html.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 5: Commit**

```bash
git add src/features/obsidian/note-html.ts src/features/obsidian/note-html.test.ts
git commit -m "feat(mobile-obsidian): note HTML document builder + wikilink/external-link bridge"
```

---

### Task 4: `NoteRenderer` interface + `WebViewNoteRenderer` driver

Wrap the WebView behind a `NoteRenderer` component-contract so a native renderer can be slotted in
later (mirrors the ADR's swappable-renderer philosophy without over-building). v1 = WebView only.

**Files:**
- Create: `src/features/obsidian/NoteRenderer.tsx`

- [ ] **Step 1: Implement `NoteRenderer.tsx`**

```typescript
import { useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { buildNoteDocument, parseNoteMessage, type NoteMessage } from "./note-html";

export interface NoteRendererProps {
    /** Server-rendered, sanitized HTML fragment (RenderedNote.html). */
    html: string;
    /** Transport base URL — used so relative image/asset paths resolve and links can open. */
    baseUrl: string;
    /** Tapped a `data-obsidian-note` wikilink — route to that note. */
    onOpenNote: (path: string) => void;
    /** Tapped an external http(s) link — open in the system browser. */
    onOpenExternal: (url: string) => void;
}

const CDN_HOST_RE = /^https:\/\/cdn\.jsdelivr\.net\//;

/**
 * NoteRenderer contract: render a note for reading. v1 ships the WebView driver only.
 * A future native driver (e.g. react-native-enriched-markdown) implements the same props.
 */
export function WebViewNoteRenderer({ html, baseUrl, onOpenNote, onOpenExternal }: NoteRendererProps) {
    const document = useMemo(() => buildNoteDocument(html), [html]);
    // The first navigation is the HTML-string load itself. On iOS `loadHTMLString:baseURL:` sets
    // that navigation's URL to `baseUrl` (an http URL) — NOT `about:blank` — so we cannot key the
    // allow-decision off the URL. Instead we allow exactly the first load, then intercept the rest.
    const firstLoadConsumed = useRef(false);

    const onMessage = (event: WebViewMessageEvent): void => {
        const message: NoteMessage | null = parseNoteMessage(event.nativeEvent.data);

        if (!message) {
            return;
        }

        if (message.type === "note") {
            onOpenNote(message.path);
            return;
        }

        onOpenExternal(message.url);
    };

    return (
        <View style={styles.fill} testID="obsidian-note-webview-wrap">
            <WebView
                testID="obsidian-note-webview"
                originWhitelist={["*"]}
                source={{ html: document, baseUrl }}
                onMessage={onMessage}
                onShouldStartLoadWithRequest={(request) => {
                    // Allow the initial HTML-string load (its URL is the baseUrl on iOS) exactly once.
                    if (!firstLoadConsumed.current) {
                        firstLoadConsumed.current = true;
                        return true;
                    }

                    // CDN subresources (katex.css / hljs theme / mermaid module) must load too.
                    if (CDN_HOST_RE.test(request.url)) {
                        return true;
                    }

                    // Everything else is a link click — the in-page bridge already preventDefault'd it
                    // and posted to native; block the WebView from navigating away.
                    return false;
                }}
                scrollEnabled
                showsVerticalScrollIndicator
                javaScriptEnabled
                domStorageEnabled={false}
                setSupportMultipleWindows={false}
                style={styles.fill}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1, backgroundColor: "#0c0e10" },
});
```

> **`onShouldStartLoadWithRequest` gotcha — DO NOT key off `about:blank`.** When the WebView loads a
> `source={{ html, baseUrl }}` string, iOS `loadHTMLString:baseURL:` makes the **initial navigation's
> URL the `baseUrl`** (an `http://…` URL), not `about:blank`. So a guard like
> `return request.url === "about:blank"` returns `false` for the real initial load and **blanks the
> page** — which would make the Appium "note renders" case (this feature's definition of done) fail
> outright. The implementation above instead allows **exactly the first navigation** via a
> `firstLoadConsumed` ref, allows CDN subresources (katex/hljs/mermaid), and blocks everything else
> (link clicks, which the in-page bridge already `preventDefault`'d + posted to native). **Device
> spike (do this when running Task 9 Step 3):** log `request.url` / `request.navigationType` for the
> first few calls on a real iOS dev-client to confirm the first-load URL really is the baseUrl and
> that the ref approach holds; if the platform emits an extra pre-load (e.g. `about:blank` THEN the
> baseUrl), widen the first-load allowance to also permit `about:blank`/`data:`. Note the open
> question in the hand-off.

- [ ] **Step 2: Typecheck**

Run (from `DevDashboard/mobile/`): `bunx tsgo --noEmit | rg "NoteRenderer"`
Expected: no errors. (If `react-native-webview` types are missing, ensure `npx expo install`
completed in Task 0 and `WebView`/`WebViewMessageEvent` resolve.)

- [ ] **Step 3: Commit**

```bash
git add src/features/obsidian/NoteRenderer.tsx
git commit -m "feat(mobile-obsidian): WebViewNoteRenderer (server-html parity reader)"
```

---

### Task 5: TanStack Query hooks (`useObsidian.ts`)

**Files:**
- Create: `src/features/obsidian/useObsidian.ts`

- [ ] **Step 1: Implement the hooks**

```typescript
import type { PublishedNote, RenderedNote, VaultEntry } from "@devdashboard/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/lib/contract";

export const obsidianKeys = {
    tree: () => ["obsidian", "tree"] as const,
    note: (path: string) => ["obsidian", "note", path] as const,
};

export function useVaultTree() {
    const client = useDashboardClient();

    return useQuery<{ entries: VaultEntry[] }>({
        queryKey: obsidianKeys.tree(),
        queryFn: () => client.obsidian.tree(),
    });
}

export function useNote(path: string | null) {
    const client = useDashboardClient();

    return useQuery<RenderedNote>({
        queryKey: obsidianKeys.note(path ?? ""),
        queryFn: () => client.obsidian.note(path as string),
        enabled: !!path,
    });
}

export function usePublishNote(path: string) {
    const client = useDashboardClient();
    const qc = useQueryClient();

    return useMutation<{ note: PublishedNote }, Error, void>({
        mutationFn: () => client.obsidian.publish(path),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: obsidianKeys.note(path) });
        },
    });
}

export function useUnpublishNote(path: string) {
    const client = useDashboardClient();
    const qc = useQueryClient();

    return useMutation<{ remaining: PublishedNote[] }, Error, string>({
        mutationFn: (slug: string) => client.obsidian.unpublish(slug),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: obsidianKeys.note(path) });
        },
    });
}

export function useMkdir() {
    const client = useDashboardClient();
    const qc = useQueryClient();

    return useMutation<{ ok: boolean; relativeDir: string }, Error, string>({
        mutationFn: (relativeDir: string) => client.obsidian.mkdir(relativeDir),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: obsidianKeys.tree() });
        },
    });
}
```

> `useDashboardClient` is the hook from plan 04 that returns the `createDashboardClient` instance
> built from the active transport (`baseUrl` + `authHeader` from the SecureStore). If plan 04 named
> it differently (e.g. `useContract()`), adjust the import; do NOT construct a new client here.

- [ ] **Step 2: Typecheck**

Run: `bunx tsgo --noEmit | rg "useObsidian"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/obsidian/useObsidian.ts
git commit -m "feat(mobile-obsidian): TanStack Query hooks (tree/note/publish/unpublish/mkdir)"
```

---

### Task 6: `ObsidianTreeNode` + `ObsidianTree` (vault browser)

**Files:**
- Create: `src/features/obsidian/ObsidianTreeNode.tsx`
- Create: `src/features/obsidian/ObsidianTree.tsx`

- [ ] **Step 1: Implement `ObsidianTreeNode.tsx`**

```typescript
import type { VaultEntry } from "@devdashboard/contract";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react-native";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface Props {
    entry: VaultEntry;
    depth: number;
    selected: string | null;
    expandedDirs: ReadonlySet<string>;
    forceOpen: boolean;
    onSelect: (relativePath: string) => void;
    onFolderToggle: (dir: string, expanded: boolean) => void;
}

function ObsidianTreeNodeImpl({
    entry,
    depth,
    selected,
    expandedDirs,
    forceOpen,
    onSelect,
    onFolderToggle,
}: Props) {
    const indent = { paddingLeft: 8 + depth * 14 };

    if (entry.isDirectory) {
        const expanded = forceOpen || expandedDirs.has(entry.relativePath);

        return (
            <View>
                <Pressable
                    testID={`obsidian-folder-${entry.relativePath}`}
                    accessibilityLabel={`folder ${entry.name}`}
                    accessibilityRole="button"
                    style={[styles.row, indent]}
                    onPress={() => onFolderToggle(entry.relativePath, !expanded)}
                >
                    {expanded ? (
                        <ChevronDown size={14} color="#aab2bd" />
                    ) : (
                        <ChevronRight size={14} color="#aab2bd" />
                    )}
                    <Folder size={14} color="#aab2bd" />
                    <Text style={styles.label} numberOfLines={1}>
                        {entry.name}
                    </Text>
                </Pressable>
                {expanded
                    ? (entry.children ?? []).map((child) => (
                          <ObsidianTreeNode
                              key={child.relativePath}
                              entry={child}
                              depth={depth + 1}
                              selected={selected}
                              expandedDirs={expandedDirs}
                              forceOpen={forceOpen}
                              onSelect={onSelect}
                              onFolderToggle={onFolderToggle}
                          />
                      ))
                    : null}
            </View>
        );
    }

    const isActive = selected === entry.relativePath;

    return (
        <Pressable
            testID={`obsidian-note-${entry.relativePath}`}
            accessibilityLabel={`note ${entry.name}`}
            accessibilityRole="button"
            style={[styles.row, indent, isActive && styles.active]}
            onPress={() => onSelect(entry.relativePath)}
        >
            <View style={styles.fileSpacer} />
            <FileText size={14} color={isActive ? "#0c0e10" : "#aab2bd"} />
            <Text style={[styles.label, isActive && styles.activeLabel]} numberOfLines={1}>
                {entry.name}
            </Text>
        </Pressable>
    );
}

export const ObsidianTreeNode = memo(ObsidianTreeNodeImpl);

const styles = StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingRight: 8 },
    label: { flex: 1, color: "#aab2bd", fontFamily: "Menlo", fontSize: 12 },
    active: { backgroundColor: "#58a6ff", borderRadius: 6 },
    activeLabel: { color: "#0c0e10", fontWeight: "600" },
    fileSpacer: { width: 14 },
});
```

> `lucide-react-native` is the RN port of the web's `lucide-react`. If plan 04 standardized on a
> different icon lib, swap the imports to match — keep the same icons (chevron/folder/file).

- [ ] **Step 2: Implement `ObsidianTree.tsx`**

```typescript
import type { VaultEntry } from "@devdashboard/contract";
import { useMemo, useState } from "react";
import { FlatList, StyleSheet, TextInput, View } from "react-native";
import { ObsidianTreeNode } from "./ObsidianTreeNode";
import { filterVaultEntries } from "./vault-filter";

interface Props {
    entries: VaultEntry[];
    selected: string | null;
    expandedDirs: ReadonlySet<string>;
    onSelect: (relativePath: string) => void;
    onFolderToggle: (dir: string, expanded: boolean) => void;
}

export function ObsidianTree({ entries, selected, expandedDirs, onSelect, onFolderToggle }: Props) {
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => filterVaultEntries(entries, query), [entries, query]);
    const forceOpen = query.trim().length > 0;

    return (
        <View style={styles.fill}>
            <TextInput
                testID="obsidian-tree-search"
                accessibilityLabel="search notes"
                placeholder="Search notes"
                placeholderTextColor="#6b7480"
                value={query}
                onChangeText={setQuery}
                style={styles.search}
                autoCapitalize="none"
                autoCorrect={false}
            />
            <FlatList
                testID="obsidian-tree-list"
                data={filtered}
                keyExtractor={(item) => item.relativePath}
                renderItem={({ item }) => (
                    <ObsidianTreeNode
                        entry={item}
                        depth={0}
                        selected={selected}
                        expandedDirs={expandedDirs}
                        forceOpen={forceOpen}
                        onSelect={onSelect}
                        onFolderToggle={onFolderToggle}
                    />
                )}
                keyboardShouldPersistTaps="handled"
                style={styles.fill}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
    search: {
        height: 36,
        marginBottom: 8,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#2a2f36",
        backgroundColor: "rgba(0,0,0,0.2)",
        color: "#e6e9ec",
        fontSize: 13,
    },
});
```

> **Recursion + FlatList:** the FlatList renders only top-level entries; each `ObsidianTreeNode`
> renders its expanded children recursively (a regular `View` tree). This matches the web `<ul>`
> recursion. Vault trees here are dozens-to-hundreds of nodes (a personal vault), so this is fine;
> if a vault ever gets huge, a future task can flatten to a single virtualized list — not needed
> for v1.

- [ ] **Step 3: Typecheck**

Run: `bunx tsgo --noEmit | rg "ObsidianTree"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/obsidian/ObsidianTreeNode.tsx src/features/obsidian/ObsidianTree.tsx
git commit -m "feat(mobile-obsidian): recursive vault tree browser with filter"
```

---

### Task 7: `ObsidianNewFolderModal` (mkdir)

**Files:**
- Create: `src/features/obsidian/ObsidianNewFolderModal.tsx`

- [ ] **Step 1: Implement the modal**

```typescript
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

interface Props {
    visible: boolean;
    /** The folder the new dir is created under ("" = vault root). */
    parentDir: string;
    submitting: boolean;
    onClose: () => void;
    onCreate: (relativeDir: string) => void;
}

export function ObsidianNewFolderModal({ visible, parentDir, submitting, onClose, onCreate }: Props) {
    const [name, setName] = useState("");

    const submit = (): void => {
        const trimmed = name.trim();

        if (!trimmed) {
            return;
        }

        const relativeDir = parentDir ? `${parentDir}/${trimmed}` : trimmed;
        onCreate(relativeDir);
        setName("");
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose}>
                <Pressable style={styles.card} onPress={(event) => event.stopPropagation()}>
                    <Text style={styles.title}>New folder</Text>
                    {parentDir ? <Text style={styles.parent}>{`in ${parentDir}`}</Text> : null}
                    <TextInput
                        testID="obsidian-new-folder-input"
                        accessibilityLabel="new folder name"
                        placeholder="folder-name"
                        placeholderTextColor="#6b7480"
                        value={name}
                        onChangeText={setName}
                        autoFocus
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.input}
                        onSubmitEditing={submit}
                    />
                    <View style={styles.actions}>
                        <Pressable testID="obsidian-new-folder-cancel" style={styles.btn} onPress={onClose}>
                            <Text style={styles.btnText}>Cancel</Text>
                        </Pressable>
                        <Pressable
                            testID="obsidian-new-folder-create"
                            accessibilityLabel="create folder"
                            style={[styles.btn, styles.primary]}
                            disabled={submitting || !name.trim()}
                            onPress={submit}
                        >
                            <Text style={[styles.btnText, styles.primaryText]}>
                                {submitting ? "Creating..." : "Create"}
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 24 },
    card: { backgroundColor: "#15181c", borderRadius: 12, borderWidth: 1, borderColor: "#2a2f36", padding: 16, gap: 10 },
    title: { color: "#e6e9ec", fontSize: 15, fontWeight: "600" },
    parent: { color: "#6b7480", fontSize: 12, fontFamily: "Menlo" },
    input: {
        height: 40,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#2a2f36",
        backgroundColor: "rgba(0,0,0,0.25)",
        color: "#e6e9ec",
    },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    btn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
    primary: { backgroundColor: "#58a6ff" },
    btnText: { color: "#aab2bd", fontWeight: "600" },
    primaryText: { color: "#0c0e10" },
});
```

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "ObsidianNewFolderModal"`
Expected: no errors.

```bash
git add src/features/obsidian/ObsidianNewFolderModal.tsx
git commit -m "feat(mobile-obsidian): new-folder (mkdir) modal"
```

---

### Task 8: `ObsidianReader` (header + publish/unpublish + share slug + renderer)

**Files:**
- Create: `src/features/obsidian/ObsidianReader.tsx`

- [ ] **Step 1: Implement the reader**

```typescript
import { useTransport } from "@/lib/transport";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { Copy, Globe, GlobeLock } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { WebViewNoteRenderer } from "./NoteRenderer";
import { shareUrl } from "./note-html";
import { useNote, usePublishNote, useUnpublishNote } from "./useObsidian";

interface Props {
    path: string;
    onOpenNote: (path: string) => void;
}

export function ObsidianReader({ path, onOpenNote }: Props) {
    const transport = useTransport();
    const baseUrl = transport.baseUrl();
    const { data, isPending, isError } = useNote(path);
    const publish = usePublishNote(path);
    const unpublish = useUnpublishNote(path);
    const [copied, setCopied] = useState(false);

    if (isPending) {
        return (
            <View style={styles.center} testID="obsidian-reader-loading">
                <ActivityIndicator color="#58a6ff" />
            </View>
        );
    }

    if (isError || !data) {
        return (
            <View style={styles.center} testID="obsidian-reader-error">
                <Text style={styles.muted}>Failed to load note.</Text>
            </View>
        );
    }

    const url = shareUrl(baseUrl, data.publishedSlug);

    return (
        <View style={styles.fill} testID="obsidian-reader">
            <View style={styles.header}>
                <Text style={styles.path} numberOfLines={1} testID="obsidian-reader-path">
                    {path}
                </Text>
                {url ? (
                    <View style={styles.headerActions}>
                        <Pressable
                            testID="obsidian-share-copy"
                            accessibilityLabel="copy share link"
                            style={styles.iconBtn}
                            onPress={async () => {
                                await Clipboard.setStringAsync(url);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            }}
                        >
                            <Copy size={13} color="#aab2bd" />
                            <Text style={styles.btnLabel}>{copied ? "copied" : "copy"}</Text>
                        </Pressable>
                        <Pressable
                            testID="obsidian-unpublish"
                            accessibilityLabel="unpublish note"
                            style={styles.iconBtn}
                            disabled={unpublish.isPending}
                            onPress={() => {
                                if (data.publishedSlug) {
                                    unpublish.mutate(data.publishedSlug);
                                }
                            }}
                        >
                            <GlobeLock size={13} color="#aab2bd" />
                            <Text style={styles.btnLabel}>unpublish</Text>
                        </Pressable>
                    </View>
                ) : (
                    <Pressable
                        testID="obsidian-publish"
                        accessibilityLabel="publish note"
                        style={styles.iconBtn}
                        disabled={publish.isPending}
                        onPress={() => publish.mutate()}
                    >
                        <Globe size={13} color="#aab2bd" />
                        <Text style={styles.btnLabel}>{publish.isPending ? "..." : "publish"}</Text>
                    </Pressable>
                )}
            </View>
            <WebViewNoteRenderer
                html={data.html}
                baseUrl={baseUrl}
                onOpenNote={onOpenNote}
                onOpenExternal={(externalUrl) => {
                    Linking.openURL(externalUrl).catch(() => {
                        /* user-cancelled or unsupported scheme; safe to ignore visually */
                    });
                }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1, backgroundColor: "#0c0e10" },
    center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0c0e10" },
    muted: { color: "#6b7480" },
    header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#2a2f36",
    },
    path: { flex: 1, color: "#aab2bd", fontFamily: "Menlo", fontSize: 11 },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    iconBtn: {
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 5,
        paddingHorizontal: 9,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: "#2a2f36",
    },
    btnLabel: { color: "#aab2bd", fontSize: 11 },
});
```

> `useTransport` is plan 02/04's hook exposing the active `Transport` (`baseUrl()` etc.). `expo-clipboard`
> and `expo-linking` are Expo modules; install via `npx expo install expo-clipboard expo-linking` if
> plan 04 has not already (check `package.json` first). Do NOT swallow the `Linking.openURL`
> rejection silently per the repo's "never swallow errors" rule — the `.catch` here is annotated and
> intentional (a cancelled external open is not an app error); if plan 04 wired a mobile logger,
> `log.debug` it instead of the comment.

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "ObsidianReader"`
Expected: no errors.

```bash
git add src/features/obsidian/ObsidianReader.tsx
git commit -m "feat(mobile-obsidian): note reader (publish/unpublish/share-slug + WebView body)"
```

---

### Task 9: The route screen (`app/(tabs)/obsidian.tsx`) with responsive split + state sync

**Files:**
- Create: `app/(tabs)/obsidian.tsx`

- [ ] **Step 1: Implement the route**

```typescript
import { ObsidianNewFolderModal } from "@/features/obsidian/ObsidianNewFolderModal";
import { ObsidianReader } from "@/features/obsidian/ObsidianReader";
import { ObsidianTree } from "@/features/obsidian/ObsidianTree";
import {
    expandedDirsForFolderToggle,
    expandedDirsForNote,
    parseOpenDirs,
    serializeOpenDirs,
} from "@/features/obsidian/expanded-dirs";
import { useMkdir, useVaultTree } from "@/features/obsidian/useObsidian";
import { useLocalSearchParams, useRouter } from "expo-router";
import { FolderPlus, FolderTree, X } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";

export default function ObsidianScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ note?: string; open?: string }>();
    const { width } = useWindowDimensions();
    const isWide = width >= 768;

    const note = typeof params.note === "string" ? params.note : null;
    const openParam = typeof params.open === "string" ? params.open : undefined;

    const { data, error } = useVaultTree();
    const mkdir = useMkdir();

    const [browserOpen, setBrowserOpen] = useState(false);
    const [newFolderOpen, setNewFolderOpen] = useState(false);

    const openDirs = useMemo(() => parseOpenDirs(openParam), [openParam]);
    const displayOpenDirs = useMemo(() => {
        if (!note) {
            return openDirs;
        }

        return expandedDirsForNote(note, openDirs);
    }, [note, openDirs]);

    const pushSearch = useCallback(
        (next: { note?: string | null; open?: Set<string> }) => {
            const nextNote = next.note !== undefined ? next.note : note;
            const nextOpen = serializeOpenDirs(next.open ?? openDirs);
            router.setParams({
                note: nextNote ?? undefined,
                open: nextOpen || undefined,
            });
        },
        [note, openDirs, router]
    );

    const onFolderToggle = useCallback(
        (dir: string, expanded: boolean) => {
            pushSearch({ open: expandedDirsForFolderToggle(dir, expanded, openDirs) });
        },
        [openDirs, pushSearch]
    );

    const onSelectNote = useCallback(
        (path: string) => {
            pushSearch({ note: path, open: expandedDirsForNote(path, openDirs) });

            if (!isWide) {
                setBrowserOpen(false);
            }
        },
        [isWide, openDirs, pushSearch]
    );

    const tree = data ? (
        <ObsidianTree
            entries={data.entries}
            selected={note}
            expandedDirs={displayOpenDirs}
            onSelect={onSelectNote}
            onFolderToggle={onFolderToggle}
        />
    ) : (
        <Text style={styles.muted} testID="obsidian-tree-status">
            {error instanceof Error ? error.message : "Loading vault..."}
        </Text>
    );

    const reader = note ? (
        <ObsidianReader path={note} onOpenNote={onSelectNote} />
    ) : (
        <View style={styles.placeholder} testID="obsidian-empty">
            <Text style={styles.muted}>
                {isWide ? "Pick a note on the left." : "Open the vault browser to pick a note."}
            </Text>
        </View>
    );

    const newFolderModal = (
        <ObsidianNewFolderModal
            visible={newFolderOpen}
            parentDir=""
            submitting={mkdir.isPending}
            onClose={() => setNewFolderOpen(false)}
            onCreate={(relativeDir) =>
                mkdir.mutate(relativeDir, {
                    onSuccess: () => setNewFolderOpen(false),
                })
            }
        />
    );

    if (isWide) {
        return (
            <View style={styles.wide} testID="obsidian-screen">
                <View style={styles.sidebar}>
                    <View style={styles.sidebarHeader}>
                        <Text style={styles.sidebarTitle}>Vault</Text>
                        <Pressable
                            testID="obsidian-add-folder"
                            accessibilityLabel="new folder"
                            onPress={() => setNewFolderOpen(true)}
                        >
                            <FolderPlus size={16} color="#aab2bd" />
                        </Pressable>
                    </View>
                    {tree}
                </View>
                <View style={styles.main}>{reader}</View>
                {newFolderModal}
            </View>
        );
    }

    return (
        <View style={styles.narrow} testID="obsidian-screen">
            <View style={styles.bar}>
                <Pressable
                    testID="obsidian-open-browser"
                    accessibilityLabel="open vault browser"
                    accessibilityState={{ expanded: browserOpen }}
                    style={styles.barBtn}
                    onPress={() => setBrowserOpen(true)}
                >
                    <FolderTree size={14} color="#aab2bd" />
                    <Text style={styles.barLabel}>Vault</Text>
                </Pressable>
                <Text style={styles.barNote} numberOfLines={1}>
                    {note ? note.split("/").pop() : "No note selected"}
                </Text>
            </View>
            <View style={styles.main}>{reader}</View>

            <Modal
                visible={browserOpen}
                animationType="slide"
                transparent
                onRequestClose={() => setBrowserOpen(false)}
            >
                <View style={styles.sheetBackdrop}>
                    <View style={styles.sheet} testID="obsidian-vault-browser">
                        <View style={styles.sheetHeader}>
                            <Text style={styles.sidebarTitle}>Browse vault</Text>
                            <View style={styles.headerRow}>
                                <Pressable
                                    testID="obsidian-add-folder"
                                    accessibilityLabel="new folder"
                                    onPress={() => setNewFolderOpen(true)}
                                >
                                    <FolderPlus size={16} color="#aab2bd" />
                                </Pressable>
                                <Pressable
                                    testID="obsidian-close-browser"
                                    accessibilityLabel="close vault browser"
                                    onPress={() => setBrowserOpen(false)}
                                >
                                    <X size={16} color="#aab2bd" />
                                </Pressable>
                            </View>
                        </View>
                        <View style={styles.sheetBody}>{tree}</View>
                    </View>
                </View>
            </Modal>
            {newFolderModal}
        </View>
    );
}

const styles = StyleSheet.create({
    wide: { flex: 1, flexDirection: "row", backgroundColor: "#0c0e10", padding: 8, gap: 8 },
    sidebar: {
        width: 260,
        backgroundColor: "#15181c",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#2a2f36",
        padding: 8,
    },
    sidebarHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
    sidebarTitle: { color: "#e6e9ec", fontSize: 13, fontWeight: "600" },
    main: { flex: 1, borderRadius: 10, overflow: "hidden", backgroundColor: "#15181c", borderWidth: 1, borderColor: "#2a2f36" },
    narrow: { flex: 1, backgroundColor: "#0c0e10", padding: 8, gap: 8 },
    bar: {
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: "#15181c",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#2a2f36",
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    barBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
    barLabel: { color: "#e6e9ec", fontSize: 13, fontWeight: "600" },
    barNote: { flex: 1, color: "#6b7480", fontFamily: "Menlo", fontSize: 11 },
    placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
    muted: { color: "#6b7480", fontFamily: "Menlo", fontSize: 12 },
    sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
    sheet: {
        maxHeight: "80%",
        backgroundColor: "#15181c",
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        borderWidth: 1,
        borderColor: "#2a2f36",
        padding: 12,
    },
    sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
    headerRow: { flexDirection: "row", alignItems: "center", gap: 14 },
    sheetBody: { flex: 1, minHeight: 240 },
});
```

> **State sync = expo-router params** (mirrors the web's TanStack-Router `?note=&open=` search
> params). `router.setParams` updates the URL params in place, so the selected note + expanded
> folders survive tab switches and deep links — exact parity with the web route's `pushSearch`.

- [ ] **Step 2: Typecheck**

Run: `bunx tsgo --noEmit | rg "app/\(tabs\)/obsidian|features/obsidian"`
Expected: no errors.

- [ ] **Step 3: Run the app + manual smoke (dev-client)**

Run: `npx expo start --dev-client` → connect to a running Agent (LAN/Tailscale per plan 02) →
open the Obsidian tab.
Expected: vault tree loads; tapping a folder expands; tapping a note opens it and the WebView
renders the formatted note (headings, code blocks). On narrow width the "Vault" button opens the
bottom sheet; on wide the split shows.

- [ ] **Step 4: Commit**

```bash
git add "app/(tabs)/obsidian.tsx"
git commit -m "feat(mobile-obsidian): responsive route (tree + reader, param state sync, mkdir)"
```

---

### Task 10: Appium Page Object + spec (the definition of done)

Per ADR §8, the feature is **done only when its Appium spec passes** on the iOS simulator/dev-client.
Use the `appium` skill (`appium_*` MCP tools); locate by accessibility-id (the `testID`s above) first.

**Files:**
- Create: `e2e/pages/obsidian.page.ts`
- Create: `e2e/specs/obsidian.spec.ts`

- [ ] **Step 1: Write the Page Object**

```typescript
import type { Browser } from "webdriverio";

/** Page Object for the Obsidian tab. Locators use accessibility-id (RN `testID`). */
export class ObsidianPage {
    constructor(private readonly driver: Browser) {}

    private byId(id: string) {
        return this.driver.$(`~${id}`);
    }

    async screen() {
        return this.byId("obsidian-screen");
    }

    async isLoaded(): Promise<boolean> {
        return (await this.screen()).isExisting();
    }

    /** Narrow layout: open the bottom-sheet vault browser. No-op safe on wide layout. */
    async openBrowserIfNarrow(): Promise<void> {
        const opener = this.byId("obsidian-open-browser");

        if (await opener.isExisting()) {
            await opener.click();
            await this.byId("obsidian-vault-browser").waitForDisplayed({ timeout: 5000 });
        }
    }

    async waitForTree(): Promise<void> {
        await this.byId("obsidian-tree-list").waitForExist({ timeout: 10000 });
    }

    async expandFolder(relativePath: string): Promise<void> {
        const folder = this.byId(`obsidian-folder-${relativePath}`);
        await folder.waitForDisplayed({ timeout: 5000 });
        await folder.click();
    }

    async openNote(relativePath: string): Promise<void> {
        const item = this.byId(`obsidian-note-${relativePath}`);
        await item.waitForDisplayed({ timeout: 5000 });
        await item.click();
    }

    async search(query: string): Promise<void> {
        const input = this.byId("obsidian-tree-search");
        await input.setValue(query);
    }

    async readerVisible(): Promise<boolean> {
        return this.byId("obsidian-reader").isExisting();
    }

    async noteWebViewVisible(): Promise<boolean> {
        return this.byId("obsidian-note-webview").isExisting();
    }

    async readerPath(): Promise<string> {
        return (await this.byId("obsidian-reader-path").getText()).trim();
    }

    async tapPublish(): Promise<void> {
        await this.byId("obsidian-publish").click();
    }

    async waitForPublished(): Promise<void> {
        await this.byId("obsidian-unpublish").waitForDisplayed({ timeout: 8000 });
    }

    async tapUnpublish(): Promise<void> {
        await this.byId("obsidian-unpublish").click();
    }

    async createFolder(name: string): Promise<void> {
        await this.byId("obsidian-add-folder").click();
        await this.byId("obsidian-new-folder-input").setValue(name);
        await this.byId("obsidian-new-folder-create").click();
    }
}
```

- [ ] **Step 2: Write the spec**

```typescript
import { ObsidianPage } from "../pages/obsidian.page";
import { connectToTestAgent } from "../support/connect"; // from plan 04's harness
import { openTab } from "../support/nav";                // from plan 04's harness

describe("Obsidian feature", () => {
    let page: ObsidianPage;

    before(async () => {
        await connectToTestAgent();      // pairs to the seeded Agent + auth (plan 04 fixture)
        await openTab("obsidian");       // selects the Obsidian native tab
        page = new ObsidianPage(driver); // `driver` is the global WDIO browser
    });

    it("loads the vault tree", async () => {
        expect(await page.isLoaded()).toBe(true);
        await page.openBrowserIfNarrow();
        await page.waitForTree();
    });

    it("opens a note and renders it in the WebView", async () => {
        await page.openBrowserIfNarrow();
        await page.waitForTree();
        // The plan-04 test Agent seeds a known note (e.g. "README.md" at vault root).
        await page.openNote("README.md");
        expect(await page.readerVisible()).toBe(true);
        expect(await page.noteWebViewVisible()).toBe(true);
        expect(await page.readerPath()).toContain("README.md");
    });

    it("publishes then unpublishes a note (share-slug toggles the controls)", async () => {
        await page.openBrowserIfNarrow();
        await page.openNote("README.md");
        await page.tapPublish();
        await page.waitForPublished(); // unpublish + copy controls now visible (publishedSlug set)
        await page.tapUnpublish();
        // back to the publish control
        await driver.$("~obsidian-publish").waitForDisplayed({ timeout: 8000 });
    });
});
```

> The spec leans on plan 04's E2E support (`connectToTestAgent`, `openTab`, the global `driver`, and
> a **seeded test vault** with a known `README.md` at the root). If plan 04 names a different seed
> note, update the two `openNote("README.md")` calls. The publish/unpublish test mutates the Agent's
> `publishedNotes` config — ensure the test Agent uses a throwaway config dir (plan 04 fixture).

- [ ] **Step 3: Run the spec**

Drive via the `appium` skill / `appium_*` MCP tools against the iOS simulator running the dev-client
(boot + session create via `appium_session_management`). The exact runner command is plan 04's
(`e2e` script). Expected: all 3 specs pass.

Per ADR §8: **the feature is "done" only when `e2e/specs/obsidian.spec.ts` passes.**

- [ ] **Step 4: Commit**

```bash
git add e2e/pages/obsidian.page.ts e2e/specs/obsidian.spec.ts
git commit -m "test(mobile-obsidian): Appium ObsidianPage + spec (tree/open/render/publish)"
```

---

## Self-Review checklist

1. **Renderer parity:** the reader renders the **server `html`** (the same string the web mirror
   feeds `dangerouslySetInnerHTML`), AND `buildNoteDocument` loads the client assets that html
   depends on — hljs theme CSS (always), KaTeX CSS (when math present), mermaid ESM + init (when a
   mermaid block present) — mirroring `share-template.ts`, so KaTeX/mermaid/highlight.js/callouts/
   wikilinks render identically (NOT broken math / raw mermaid / monochrome code). No native markdown
   re-parse. The `NoteRenderer` props contract leaves room for a future native driver without
   touching the route.
2. **Wikilink contract:** taps on `a[data-obsidian-note]` post `{ type: "note", path }` to native
   and route via `onSelectNote` → `router.setParams({ note })` — exact parity with the web
   `onArticleClick` handler. External http(s) links open in the system browser.
3. **Share-slug awareness:** when `publishedSlug` is set, the header shows the copyable
   `<baseUrl>/share/<slug>` + unpublish; otherwise it shows publish. Mutations invalidate the note
   query so the controls flip after publish/unpublish.
4. **State sync:** selected note + expanded folders persist via expo-router params (`note`, `open`),
   mirroring the web's `?note=&open=` — deep-linkable and tab-switch-stable.
5. **Filter + expand parity:** `filterVaultEntries` and the `expanded-dirs` helpers are unit-tested
   against the web behaviors — a folder-name match returns the folder with its **filtered** children
   (exact web parity; folder-name-only match → empty children), descendant match prunes non-matches,
   ancestor auto-expand on note open.
6. **Contract-only data access:** every call goes through `client.obsidian.*`; no raw `fetch`, no
   hardcoded `/api/...` strings in feature code (paths live in `endpoints.ts`).
7. **Conventions:** no one-line ifs; blank line before `if` / after closing brace; objects for 3+
   params; no `as any`; native modules installed via `npx expo install` (Task 0). The single
   annotated `.catch` on `Linking.openURL` is intentional and documented (not a swallowed error).
8. **Types:** `VaultEntry`, `RenderedNote`, `PublishedNote` come from `@devdashboard/contract`;
   `NoteRenderer`/`NoteMessage` are the names used throughout (no divergent aliases).
9. **Tests:** `expanded-dirs.test.ts`, `vault-filter.test.ts`, `note-html.test.ts` pass on the RN
   test runner; the Appium spec passes.
10. **Known limitations (documented, not blockers):** (a) **In-note `<img>` from the vault** loaded
    over the transport will not carry the `Basic`/cookie auth the WebView lacks → such images would
    401. The server stubs embeds (`dd-md-embed-stub`) so this is limited in practice; full image
    auth is the same cookie-planting problem plan 06 solves for ttyd — defer to a follow-up that
    reuses 06's `@react-native-cookies/cookies` plant. (b) **CDN-dependent assets** (katex/hljs/
    mermaid) mean a fully-offline device shows raw math/mermaid/monochrome code — acceptable for v1
    (parity with the share page); a later task self-hosts them on the Agent.

## Appium E2E (per ADR §8)

- **Spec:** `e2e/specs/obsidian.spec.ts` — 3 cases: (1) vault tree loads, (2) a note opens and
  renders in the WebView, (3) publish → unpublish round-trip (share-slug toggles the header
  controls).
- **Page Object:** `e2e/pages/obsidian.page.ts` — `ObsidianPage` with `isLoaded`,
  `openBrowserIfNarrow`, `waitForTree`, `expandFolder`, `openNote`, `search`, `readerVisible`,
  `noteWebViewVisible`, `readerPath`, `tapPublish`, `waitForPublished`, `tapUnpublish`,
  `createFolder`.
- **Locators (accessibility-id = RN `testID`):** `obsidian-screen`, `obsidian-open-browser`,
  `obsidian-vault-browser`, `obsidian-close-browser`, `obsidian-tree-list`, `obsidian-tree-search`,
  `obsidian-folder-<relativePath>`, `obsidian-note-<relativePath>`, `obsidian-reader`,
  `obsidian-reader-path`, `obsidian-note-webview`, `obsidian-publish`, `obsidian-unpublish`,
  `obsidian-share-copy`, `obsidian-add-folder`, `obsidian-new-folder-input`,
  `obsidian-new-folder-create`, `obsidian-new-folder-cancel`.
- **MCP tools:** drive with `appium_session_management` (session create against the booted iOS
  simulator dev-client), `appium_find_element` (by accessibility-id), `appium_gesture` (tap/scroll —
  use `action=scroll_to_element` for off-screen tree nodes), and `appium_get_text` for the reader
  path assertion. Prefer the `appium` skill's documented flow over ad-hoc tool names.
- **Definition of done:** the feature is **done only when `obsidian.spec.ts` passes** on the iOS
  simulator/dev-client.

## Hand-off / dependencies on sibling plans

- **Plan 03 (contract):** must expose `client.obsidian.{tree,note,publish,unpublish,mkdir}` and the
  `RenderedNote`/`PublishedNote` DTOs. Task 0 adds `mkdir`/`publish`/`unpublish` if 03 left them out.
- **Plan 04 (mobile foundation):** provides `useDashboardClient()` / `useTransport()`, the theme
  tokens (the inline hex here mirrors `--dd-*`; swap to plan 04's token module if it exposes one),
  the icon lib (`lucide-react-native` assumed), the E2E harness (`connectToTestAgent`, `openTab`,
  global `driver`), and a **seeded test vault** with a root `README.md`.
- **Plan 06 (terminals):** already adds `react-native-webview` (+ patch-package New-Arch diff);
  this feature reuses that install. If 08 is implemented before 06, Task 0 Step 1 installs it.
