# 19 — Feature: Obsidian (Plan 08 / D32) implementation notes

> Isolated worktree off `feat/dev-dashboard-mobile` @ `10981acc5`, committed directly. All work scoped
> to `DevDashboard/mobile/`. `src/api/*`, `src/ui/*`, `app/(tabs)/_layout.tsx`, other `src/features/*`,
> the `@dd/contract` package, and `DECISIONS.md` were NOT touched (read-only / orchestrator-owned).
> No Metro / `expo start` / simulator / `expo run` was started — device builds + Appium runs are the
> user's job.

## Status: COMPLETE — vault tree browser + WebView note reader + publish/unpublish/mkdir built, committed, green where verifiable without a sim.

- **`bunx tsc --noEmit` (app): 2 errors, BOTH pre-existing baseline** (`../../src/dev-dashboard/lib/e2e/box.ts` — `tweetnacl`/`tweetnacl-util` not installed in the repo-root `node_modules` of this fresh worktree; that's plan-02 E2E crypto, D29). **ZERO obsidian errors.**
- **`bunx tsc -p e2e/tsconfig.json`: 0 errors.**
- **`bun test src/`: 82 pass / 1 fail.** The 1 fail is the SAME pre-existing baseline (`src/transport/tiers/managed.test.ts` → `Cannot find package 'tweetnacl'`). My obsidian tests added **+29 passing** (53→82). No new failures.
- **`expo lint`: 0 problems** (exit 0, no output).
- Use `bunx tsc` NOT `tsgo` for the mobile app (tsgo can't resolve RN's `types` export condition — see plan-04/05 notes).

### ⚠️ Spawn-base correction (report to orchestrator)
This agent's worktree (`agent-a326abc325aa8a523`) was spawned on the WRONG base — branch `feat/tmux-cmux-dev-dashboard` @ `581f71f70` (the tmux line, which has **no `DevDashboard/`** at all) instead of `feat/dev-dashboard-mobile` @ `10981acc5`. The branch had zero unique commits (identical to `feat/tmux-cmux-dev-dashboard`), working tree clean, so it was repointed in place: `git checkout -B worktree-agent-a326abc325aa8a523 10981acc5` (a `backup/agent-a326-wrongbase` ref was left as an audit breadcrumb, matching the prior `backup/agent-a2b3ef-wrongbase` precedent). All my commits land on `10981acc5` + 4 new commits. **Sibling agent `aa57840c09c8ad30d` sits on the same wrong base** (`581f71f70`) and may be a stalled/mis-spawned agent — the orchestrator should check it.

## Commits (one per logical step), newest last

| Step | Commit | Subject |
|---|---|---|
| 1 | `891bb1f94` | D32 data layer + pure helpers (queries/hooks, expand-state, vault filter, note-html builder) + tests |
| 2 | `bc74d51a1` | vault tree browser + WebView note reader + mkdir modal (emerald theme, @expo/vector-icons) |
| 3 | `ad7258e39` | responsive route screen (tree + reader, expo-router param state sync, mkdir) |
| 4 | `d4448c9e3` | Appium ObsidianPage + spec (tree loads / note renders / publish round-trip) |

## Files created (all under `DevDashboard/mobile/`)

**Feature data layer (`src/features/obsidian/`):**
- `queries.ts` — `obsidianKeys` (co-located, root `"obsidian"`) + `treeQuery`/`noteQuery` `queryOptions` factories over the injected `DashboardClient`. No `refetchInterval` (Obsidian is request-driven, not a live metric stream — unlike Pulse). `noteQuery(client, null)` is `enabled: false`.
- `hooks.ts` — thin `useVaultTree`/`useNote` query hooks + `usePublishNote`/`useUnpublishNote`/`useMkdir` **mutation** hooks (`useMutation` over the same injected client; each invalidates the affected query on success so the UI flips — tree after mkdir, note after publish/unpublish). Components consume THESE (D32) — never raw `useQuery`/`useMutation`.
- `expanded-dirs.ts` (+`.test.ts`, 6 assertions) — pure `parseOpenDirs`/`serializeOpenDirs`/`ancestorDirsOf`/`expandedDirsForNote`/`expandedDirsForFolderToggle` (parity with the web `@app/utils/obsidian/expanded-dirs`).
- `vault-filter.ts` (+`.test.ts`, 5 tests) — pure `filterVaultEntries` (exact parity with the web `filterEntries`: folder kept on name-match OR matching descendant, with FILTERED children; folder-name-only match → `children: []`).
- `note-html.ts` (+`.test.ts`, 11 tests) — `buildNoteDocument(html)` (wraps server html in a full doc with the emerald theme CSS + hljs/KaTeX/mermaid client assets mirroring `share-template.ts` + the wikilink/external-link tap bridge in `<head>`), `parseNoteMessage(raw)` (SafeJSON, returns typed `NoteMessage | null`), `shareUrl(baseUrl, slug)`.

**Feature components (`src/features/obsidian/components/`):**
- `NoteRenderer.tsx` — `WebViewNoteRenderer` (the `NoteRendererProps` contract + the v1 WebView driver). Renders `buildNoteDocument(html)` in a `react-native-webview`; `onShouldStartLoadWithRequest` allows the first load + jsDelivr CDN subresources, blocks link-clicks (the in-page bridge already posted them to native). A future native driver implements the same props without touching the screen. **`NoteReader` re-keys it with `key={path}`** — see the "WebView re-key" fix below.
- `VaultTreeNode.tsx` — recursive single row (folder/file), `memo`'d, `@expo/vector-icons` Feather icons, `useThemeColors()` colors.
- `VaultTree.tsx` — search box (force-opens folders while typing) + `FlatList` of top-level entries (children recurse in-node).
- `NewFolderModal.tsx` — the mkdir modal.
- `NoteReader.tsx` — header (note path, publish OR share-url+unpublish) + the WebView body. Reads `baseUrl` from `useConnection`; external links + the share URL open via `expo-web-browser` `openBrowserAsync` (precedent: `src/components/external-link.tsx`).

**Screen:** `src/app/(tabs)/obsidian.tsx` — responsive split (side-by-side ≥768 px, bottom-sheet vault browser on phones), state synced through expo-router `note`/`open` params (parity with the web `?note=&open=`). Root testID = **`screen-obsidian`** (the `screen-<name>` convention — NOT the stale plan's `obsidian-screen`).

**E2E:** `e2e/pages/ObsidianPage.page.ts` (`obsidianPage` singleton, extends `BasePage`), `e2e/specs/obsidian.spec.ts` (3 cases, WDIO/Mocha, pairs via deep-link first like `pulse.spec`).

**Deps:** `react-native-webview@13.16.0` (added via `npx expo install` — SDK-55-resolved; task-pre-approved, same dep the terminals feature uses).

## ► NOTE-RENDERING CHOICE (D20): path (a) — WebView + server html. NO new markdown lib.

Went with **path (a)** as the task preferred: render the server's pre-rendered, sanitized `html`
(the SAME string the web mirror feeds `dangerouslySetInnerHTML`) inside `react-native-webview`, styled
to the emerald aesthetic via injected CSS + the hljs/KaTeX/mermaid client assets (mirroring
`share-template.ts`). **Did NOT add a RN markdown renderer** (`react-native-markdown-display` /
`react-native-render-html`) — that would re-parse `source`, lose KaTeX/mermaid/highlight/callouts/the
wikilink-tap contract (a *different* renderer, not parity), and duplicate the server pipeline
on-device. `react-native-webview` is the same dep the terminals feature already pulls in. **No D20
flag needed for the renderer** — path (a) is the sanctioned no-new-lib choice.

## Lib decisions / flags (D20)

1. **Icons: used `@expo/vector-icons` (Feather), NOT the plan's `lucide-react-native`.** lucide AND its
   peer `react-native-svg` are both ABSENT — adding them = a new lib (D20). `@expo/vector-icons` is
   already installed (Expo-bundled, transitive via `expo`), matching the codebase precedent
   (`src/components/ui/collapsible.tsx`). No new dep. **Plan deviation, not a blocking flag.**
2. **Clipboard: did NOT add `expo-clipboard` (a new lib).** The share-URL surface ships zero-new-lib:
   the URL renders as `<Text selectable>` (long-press → copy) inside a tappable row that opens the
   share page in the system browser (`expo-web-browser`, already a dep). **FLAG for the orchestrator:**
   for one-tap-copy parity with the web "copy" button, add `expo-clipboard` (Expo-first, D19/D20-aligned)
   and swap the open-row for `Clipboard.setStringAsync(url)`. Recommended, but a unilateral lib lock was
   avoided per D20.
3. **`react-native-webview@13.16.0`** — installed via `npx expo install` (task pre-approved; not a new
   D20 decision — it's D12's terminal dep, reused here).

## WebView re-key fix (caught in the done-review — a real runtime bug, not a tsc/test one)

The `WebViewNoteRenderer` uses a JS-side `firstLoadConsumed` ref to allow exactly the initial
html-string load (whose iOS URL is the `baseUrl`, not `about:blank`) and then block link-click
navigations. But a bare `html`-prop change (open note A → open note B in the SAME renderer instance)
reloads the WebView while the ref is already `true`, so `onShouldStartLoadWithRequest` would treat B's
load as a blocked link-click → **every note after the first renders blank.** Fixed in `NoteReader.tsx`
by re-keying the renderer per note (`<WebViewNoteRenderer key={path} … />`), which remounts it (ref
resets) and discards stale WKWebView state. tsc/lint re-verified clean. This is the feature's primary
repeated action, so it was a ship-blocker; it's a runtime-only behavior unit tests don't exercise (the
device spike in deferral #3 still applies to the first-load URL assumption itself).

## DEFERRAL: react-native-webview iOS New-Arch patch (D12 / plan 06 prerequisite)

`react-native-webview@13.16.0` was installed fresh here. Per D12, the iOS New-Arch path needs plan-06's
`patch-package` diff for webview issue #3863 (#3880) for the WebView to render correctly on device. If
plan 08 lands BEFORE plan 06, that patch is NOT present — the reader's WebView may not render on a real
iOS dev-client until 06's patch + `patch-package` postinstall are in place. **Orchestrator: ensure the
terminals (plan 06) webview patch is applied before relying on the Obsidian reader on-device.**

## Thin-fixture flag (mock obsidian)

`src/api/mock-client.ts`'s `obsidian.note()` **always returns `publishedSlug: null`** and ignores
publish state, and `publish()`/`unpublish()` don't mutate any shared store. So under the MOCK client
(no device connected) the publish→unpublish header flip **cannot be exercised** — tapping publish won't
surface the unpublish/share controls because the re-fetched note still has `publishedSlug: null`. The
tree browser, note rendering, search, expand/collapse, and mkdir all work fine under the mock. The
publish round-trip is only meaningfully testable against a **real agent** (which is what the Appium
spec targets). **FLAG:** if the orchestrator wants the publish flip demoable under the mock, the mock
needs stateful publish (track a published-set keyed by path; `note()` returns a slug when published).
I did NOT edit `mock-client.ts` (shared/read-only).

## Deviations from the plan-08 doc (and why) — the plan predates the actual foundation (D32 + plan-05)

1. **Layout follows the SHIPPED foundation, not the plan's stale paths.** Plan-08 (2026-05-29) predates
   D32 (2026-05-30) and the plan-05 build. It used `@devdashboard/contract`, `@/lib/contract`,
   `useTransport()`, a single `useObsidian.ts`, `app/(tabs)/obsidian.tsx`, `ObsidianTree`/`ObsidianReader`
   component names. The real foundation (per `16-impl-05-pulse-notes.md`) is: contract `@dd/contract`;
   client via `useDashboardClient()` from `@/api/client-provider`; per-feature `queries.ts`+`hooks.ts`
   split; screens at `src/app/(tabs)/`; `useConnection` (not `useTransport`) holds `baseUrl`. Built to
   the foundation + the task's file list (`queries.ts`/`hooks.ts`, `components/`, `src/(app/)(tabs)/obsidian.tsx`).
2. **Palette = emerald "Obsidian Terminal", not the plan's blue.** Plan-08's components + `note-html.ts`
   used a blue palette (`#58a6ff`/`#2a2f36`/`#15181c`). The real theme (`src/theme/colors.ts` /
   `tokens.css`) is emerald: accent `#34d399`, bg `#0c0e10`, panel `#101316`, border `#1e2428`, text
   `#e6edf3`/`#8b96a0`/`#5b6670`, danger `#f87171`. RN components use `useThemeColors()` + StyleSheet
   (the `ProcessTable` precedent; also sidesteps the tailwind content-glob which excludes
   `src/features`). The WebView CSS string hardcodes the emerald hex (+ mermaid `themeVariables`).
3. **Root testID `screen-obsidian`** (the `screen-<name>` convention used by `app.page.ts`'s `TAB_SCREEN`
   map), NOT the plan's `obsidian-screen`. All other `obsidian-*` testIDs kept as the plan specified.
4. **`publish`/`unpublish`/`mkdir` response types mirrored locally** (`PublishRes`/`UnpublishRes`/`MkdirRes`
   in `hooks.ts`) from the exported `PublishedNote` — the contract types those three inline (no exported
   `Obsidian*Res` aliases) and `@dd/contract` is read-only. `ObsidianTreeRes`/`ObsidianNoteRes` DO exist
   and are imported directly. Task 0 (add the contract obsidian group) was already done by plan 03 —
   the full `obsidian.{tree,note,mkdir,publish,unpublish}` group is present in `client.ts`; no contract edit needed.
5. **`SafeJSON` for `parseNoteMessage`** (via `@app/utils/json` → the RN shim aliased in tsconfig), per
   the task RULES. (The repo biome `JSON`-restriction explicitly EXCLUDES `DevDashboard/mobile`, so it
   was a choice, not a hard rule — but SafeJSON is the documented preference and a ready shim exists.)
   The in-page WebView bridge keeps plain `JSON.stringify` — that runs in the browser JS engine, where
   the native SafeJSON module does not exist.
6. **Tests = mock + factory seam (no React renderer)** — same call as plan-05: a React test renderer
   (`@testing-library/react-native`) would be a D20 lib decision, and the hooks are thin one-liners,
   so exercising the mock client + the `queryOptions` factories' `queryFn` is the meaningful seam.

## What REQUIRES a simulator / device (DEFERRED to the user / orchestrator)

1. **Build + launch dev-client** (`npx expo run:ios`) — `react-native-webview` is a native module (New
   Arch); cannot run in Expo Go. First run prebuilds `ios/`.
2. **WebView note rendering on device** — `buildNoteDocument` is tsc-clean + unit-tested for structure,
   but the actual HTML/CSS/JS render (KaTeX positioning, mermaid init, hljs theme, the click-bridge
   `postMessage`) is a runtime-only property of the iOS WKWebView. Verifiable only on a device.
3. **`onShouldStartLoadWithRequest` first-load behavior** — the impl allows exactly the first navigation
   (iOS `loadHTMLString:baseURL:` makes the first nav's URL the `baseUrl`, not `about:blank`). DEVICE
   SPIKE: log `request.url`/`request.navigationType` for the first few calls on a real iOS dev-client to
   confirm the ref approach holds; if the platform emits an extra pre-load (`about:blank` THEN baseUrl),
   widen the first-load allowance to also permit `about:blank`/`data:`.
4. **Tab registration** — `app/(tabs)/_layout.tsx` is orchestrator-owned; the Obsidian `NativeTabs.Trigger`
   is NOT yet registered (it currently has Pulse/Terminal/Sessions/QA/More). The orchestrator must add an
   "Obsidian" trigger pointing at the `obsidian` route AND extend `app.page.ts`'s `TabName`/`TAB_SCREEN`
   map (`Obsidian: "screen-obsidian"`). Until then the Appium spec self-navigates via `~Obsidian`.
5. **Obsidian Appium spec (`e2e/specs/obsidian.spec.ts`)** — authored + type-checks; NOT run (no sim).
   Pairs via a deep-linked pairing URI first (gate opens), then opens the Obsidian tab. Needs a test
   Agent reachable at the paired baseUrl with Basic auth satisfied + a seeded vault with a `Daily.md`
   root note (the mock vault also exposes `Daily.md`). The publish→unpublish case needs a real agent
   (the mock can't flip `publishedSlug` — see the thin-fixture flag).
6. **In-note vault `<img>` auth** — images loaded over the transport won't carry the Basic/cookie auth
   the WebView lacks → such images would 401. The server stubs embeds (`dd-md-embed-stub`) so this is
   limited; full image auth is the same cookie-plant problem the terminals feature solves — defer to a
   follow-up reusing that plant.
7. **CDN-dependent assets** (katex/hljs/mermaid via jsDelivr) — a fully-offline device shows raw
   math/mermaid/monochrome code. Acceptable for v1 (parity with the share page); a later task can
   self-host the assets on the Agent and point `buildNoteDocument` at `<baseUrl>/assets/...`.

## Coordinator ping note

No SendMessage/agent-to-coordinator tool exists in this agent's environment. The milestone + flags are
surfaced in the final report for the parent to relay:
**"Obsidian feature built on `10981acc5` (+4 commits, `891bb1f94`→`d4448c9e3`). tsc/test/lint green
modulo the pre-existing tweetnacl baseline (box.ts ×2 tsc, managed.test ×1 — plan-02 E2E, not mine).
Renderer = WebView+server-html (path a, no markdown lib). Flags: (1) icons → @expo/vector-icons not
lucide (no new dep); (2) clipboard → recommend adding `expo-clipboard` for one-tap-copy parity (shipped
selectable-text + open-in-browser instead, zero new lib); (3) mock `obsidian.note()` can't flip
`publishedSlug`, so the publish round-trip is real-agent-only. Orchestrator TODO: register the Obsidian
tab in `app/(tabs)/_layout.tsx` + extend `app.page.ts` TAB_SCREEN; and note this worktree was spawned on
the wrong base (tmux line) and self-corrected to `10981acc5` — sibling `aa57840c0` is on the same wrong base."**
