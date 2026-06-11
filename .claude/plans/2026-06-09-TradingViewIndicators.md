# TradingView Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `tools tradingview` with a server-computed indicator engine: stream any indicator's values AND its plotshape marks (buy/sell signals) for a symbol — history table then live — plus saved-chart inventory, indicator-library listing, and multi-symbol scanning.

**Architecture:** A new `ChartClient` (chart-session `cs_*` WebSocket protocol) plus a pine-facade REST layer fetch study metadata and attach studies via `create_study`; parsed plot series feed a signal detector that turns shape-plot transitions into events. ALL logic lives in `src/tradingview/lib/` (pure, EventEmitter/data-returning, zero terminal output) — commands in `src/tradingview/commands/` are thin renderers, so a future UI can import the same lib.

**Tech Stack:** Bun (native `WebSocket` — NEVER the `ws` package, see §9 of the handoff), commander, picocolors, `@app/logger` (lib uses `logger` only; `out` only in commands), `SafeJSON`, `Storage` (`@app/utils/storage`), bun test.

---

## Required reading (before ANY task)

1. `/Users/Martin/Tresors/Projects/GenesisBrain/GenesisTools/TradingView/2026-06-09-First.handoff.md` — the reverse-engineering field log. Critical sections: §4 (quote WS protocol & `~m~` framing), §5 (pro-symbol encoding), §6 (chart/series protocol — the part we build on), §9 (bun WebSocket gotcha — DO NOT use the `ws` package), §11–12 (field tables, gotchas).
2. `/Users/Martin/Tresors/Projects/GenesisBrain/GenesisTools/TradingView/Indicators.research01.md` — how indicators execute (server-side Pine), what protected scripts expose (computed output only), pine-facade endpoints, the two meanings of "marks".
3. `src/tradingview/lib/quote-client.ts` — the house pattern for a TV WebSocket client (typed EventEmitter, heartbeat echo, pending queue). `ChartClient` mirrors it.
4. Repo `CLAUDE.md` — code style (SafeJSON always, no `as any`, block-form `if`, logging conventions).

## Locked design decisions (from brainstorm 2026-06-09)

- **Scope, in priority order:** (1) indicator values+signals per symbol, (2) saved-chart study inventory + `--from-chart`, (3) indicator library listing, (4) multi-symbol scan. Each phase ships independently.
- **Mode:** history table first, then keep streaming live. `--once` exits after the snapshot.
- **Coverage:** built-ins (`STD;*`) AND community/library scripts (`PUB;*`), including protected ones (e.g. MDX `PUB;AGFHDbJ2`) — server sends computed output regardless of source visibility.
- **Output:** numeric plot values AND interpreted signal events (shape plots → "▲ Buy @ bar"). `--signals-only` suppresses numeric stream.
- **Notifications in v1:** `--notify` (voice via `tools say` + macOS banner) and `--exec <cmd>` hooks fire on live signal events.
- **UI-ready:** lib never touches stdout/stderr directly (no `out`, no `console`); only `logger.*` diagnostics. Commands own all rendering.
- **North-star acceptance test:** `tools tradingview indicator "PUB;AGFHDbJ2" BYBIT:BTCUSDT.P --tf 15` prints MDX history with marks and streams live Buy/Sell/momentum signals.

## Protocol primer (what the engineer must know beyond the handoff)

The handoff §6 captured the chart session but NOT `create_study`. Third-party clients (`@mathieuc/tradingview` npm, `tradingview-rs`) document the missing pieces at medium-high confidence; **Task 1 verifies them with a live capture before we write code against them.** Expected shapes:

**pine-facade translate** (gets everything needed to attach a study):

```
GET https://pine-facade.tradingview.com/pine-facade/translate/<urlencoded pineId>/<urlencoded version>
  Headers: cookie (required for PUB;* you have via account; optional for STD;*),
           origin: https://www.tradingview.com
```

Response (abridged):

```jsonc
{
  "success": true,
  "result": {
    "ilTemplate": "<huge compiled-IL string>",     // becomes create_study's `text`
    "metaInfo": {
      "scriptIdPart": "PUB;AGFHDbJ2",
      "description": "MDX Free (PA) Buy/Sell Confimation",
      "shortDescription": "MDX BuySell",
      "pine": { "version": "1.0" },
      "inputs": [
        // first entries are fake/hidden carriers: text, pineId, pineVersion
        { "id": "text",        "type": "text",    "isHidden": true, "isFake": true, "defval": "..." },
        { "id": "pineId",      "type": "text",    "isHidden": true, "isFake": true },
        { "id": "pineVersion", "type": "text",    "isHidden": true, "isFake": true },
        { "id": "in_0", "name": "Length", "type": "integer", "defval": 14 }
      ],
      "plots":  [ { "id": "plot_0", "type": "line" }, { "id": "plot_1", "type": "shapes" } ],
      "styles": { "plot_0": { "title": "RSI" }, "plot_1": { "title": "Buy" } }
    }
  }
}
```

**create_study** (chart socket, after `resolve_symbol` + `create_series`):

```jsonc
{"m":"create_study","p":[
  "cs_<id>",                      // chart session
  "st_1",                         // study id we invent
  "st1",                          // study version tag
  "sds_1",                        // the series id from create_series
  "Script@tv-scripting-101!",     // study runtime type for Pine scripts
  {
    "text": "<ilTemplate>",
    "pineId": "PUB;AGFHDbJ2",
    "pineVersion": "1.0",
    "in_0": { "v": 14, "f": true, "t": "integer" }   // one entry per real input
  }
]}
```

**Study data frames** — `timescale_update` (snapshot) and `du` (deltas) carry, in `p[1]`, an object keyed by series/study id:

```jsonc
{ "sds_1": { "s":  [ { "i": 0, "v": [1781037360, 67000.1, 67100.0, 66900.2, 67050.5, 1234.5] } ] },
  "st_1":  { "st": [ { "i": 0, "v": [1781037360, 31.42, null] } ] } }
// series "s" value array: [time, open, high, low, close, volume]
// study "st" value array: [time, plot_0, plot_1, ...] in metaInfo.plots order
```

A `plotshape` mark = **non-null/non-NaN value at a bar index on a `shapes`/`chars`/`arrows`-type plot**. NaN may arrive as JSON `null` or the string `"NaN"` — Task 1 confirms which; the parser must tolerate both.

**Lifecycle frames:** `study_loading` → data → `study_completed`. Errors: `study_error` frame `{"m":"study_error","p":["cs_..","st_1","s1","<reason>", ...]}` — surface verbatim (same philosophy as the quotes `symbolError`). Also possible: `critical_error`, `protocol_error` (connection-fatal → reconnect).

**Auth matrix:** STD built-ins work as guest on `data.tradingview.com`. PUB scripts and full realtime need the session cookie (for translate + `is_auth_to_get`) and the 4h JWT from `fetchAuthToken` on `prodata.tradingview.com`. Pre-flight PUB with `GET pine-facade/is_auth_to_get/<pineId>/<version>` (cookie) — non-2xx/false ⇒ clear error "your account cannot access this script".

## File structure (the decomposition contract)

```
src/tradingview/
├── index.ts                        # MODIFY: register indicator/charts/indicators/scan commands
├── commands/
│   ├── indicator.ts                # CREATE (Phase 1): thin controller for the core command
│   ├── charts.ts                   # CREATE (Phase 2)
│   ├── indicators.ts               # CREATE (Phase 3): library list/search
│   └── scan.ts                     # CREATE (Phase 4)
└── lib/
    ├── types.ts                    # MODIFY: + Bar, StudyMeta, PineInput, PinePlot, StudyPoint, SignalEvent
    ├── pine-facade.ts              # CREATE: translate / is_auth_to_get / list REST + spec parsing
    ├── indicator-aliases.ts        # CREATE: friendly-name → pineId resolution (cached standard list)
    ├── study.ts                    # CREATE: StudyMeta + user inputs → create_study param object
    ├── chart-client.ts             # CREATE: ChartClient EventEmitter (cs_* session, series+study parsing, reconnect)
    ├── signals.ts                  # CREATE: SignalDetector — shape-plot transitions → SignalEvent
    ├── notify.ts                   # CREATE: say/banner/exec dispatch on signals
    ├── charts-storage.ts           # CREATE (Phase 2): layout list + layout studies REST
    ├── scanner.ts                  # CREATE (Phase 4): scanner.tradingview.com snapshot REST
    ├── format.ts                   # MODIFY: indicator table/line/signal banner renderers
    └── __fixtures__/               # CREATE: sanitized captured frames (Task 1 output)
```

Rules: every lib module is import-safe for a future UI (no process.exit, no stdout). Commands: parse flags → call lib → render via format.ts → `out.*`.

---

## How to work this plan

- TDD per task: write the failing test, watch it fail, implement, watch it pass, commit. Frequent small commits (`feat(tradingview): ...`).
- Run tests with `bun test src/tradingview` (from repo root of THIS worktree: `/Users/Martin/Tresors/Projects/GenesisTools-worktrees/feat-tradingview`).
- Typecheck with `tsgo --noEmit 2>&1 | rg "src/tradingview"` — empty output for our files = clean. Use a 60s timeout.
- NEVER `npm`/`npx` — use `bun add` / `bunx`. NEVER import the `ws` package (handoff §9).
- Companion doc: `.claude/plans/2026-06-09-TradingViewIndicators.verify.md` is the verification playbook. After finishing each PHASE, run that phase's section there before moving on.
- Every code block below is the actual intended content — copy it, don't paraphrase it. If reality (Task 1 capture) contradicts a shape in this plan, the capture wins; update the plan inline and note it in the commit body.

---

# Phase 0 — Ground truth

### Task 1: Live capture — verify `create_study` / translate shapes, produce fixtures (operator-assisted)

**This task needs the chrome-devtools MCP and a logged-in TradingView browser session — it is run by the orchestrating Claude session, not blind-coded.** Everything later that parses study data uses the fixtures created here.

**Files:**
- Create: `src/tradingview/lib/__fixtures__/translate-std-rsi.json`
- Create: `src/tradingview/lib/__fixtures__/translate-pub-mdx.json`
- Create: `src/tradingview/lib/__fixtures__/chart-frames-rsi.txt` (raw `~m~` frames, one WS message per line)
- Create: `src/tradingview/lib/__fixtures__/chart-frames-mdx.txt`
- Modify (append-only!): `/Users/Martin/Tresors/Projects/GenesisBrain/GenesisTools/TradingView/2026-06-09-First.handoff.md`

- [ ] **Step 1: Re-arm the capture rig** from handoff §13: navigate chrome-devtools MCP to `https://www.tradingview.com/chart/`, inject the `window.__wsCap` WebSocket hook via `initScript`, reload.
- [ ] **Step 2: Add studies on-chart**: add built-in RSI, then add "MDX Free (PA) Buy/Sell Confimation" (script id `AGFHDbJ2`) to the chart (symbol BYBIT:BTCUSDT.P, 15m).
- [ ] **Step 3: Harvest REST**: via `list_network_requests`/`get_network_request`, save the full JSON response of `pine-facade/translate/STD%3BRSI%40tv-basicstudies/...` (or whatever STD id the client actually requested — RECORD the exact id) and `pine-facade/translate/PUB%3BAGFHDbJ2/...` into the two `translate-*.json` fixtures. Strip nothing — `ilTemplate` included.
- [ ] **Step 4: Harvest WS**: dump `window.__wsCap` frames for the chart socket; extract (a) the outgoing `create_study` frames for both studies, (b) incoming `study_loading`, first `timescale_update` containing `st_1`-style study data, 2-3 `du` frames, `study_completed`. Save raw into the two `chart-frames-*.txt` fixtures.
- [ ] **Step 5: Confirm the unknowns** and write the answers down: (1) exact create_study param list & study runtime type string; (2) study point shape (`{i, v:[time,...]}`?); (3) how NaN/no-mark is encoded on shape plots (null? "NaN"? absent?); (4) the exact STD pineId format for built-ins (`STD;RSI` vs `STD;RSI@tv-basicstudies`); (5) which plot ids MDX exposes and their `styles` titles (Buy/Sell/diamond names).
- [ ] **Step 6: Append findings to the handoff** under a `## 2026-06-09 HH:MM — create_study + translate capture` header (append-only, never rewrite earlier sections).
- [ ] **Step 7: Sanitize fixtures** — replace your real `sessionid`/JWT values inside fixtures with `REDACTED` (grep them: `rg -l "sessionid|eyJhbGciOiJSUzUxMiI" src/tradingview/lib/__fixtures__/`). The ilTemplate is fine to keep.
- [ ] **Step 8: Commit**

```bash
git add src/tradingview/lib/__fixtures__
git commit -m "chore(tradingview): captured create_study/translate fixtures for study engine"
```

**Verify (Task 1):** all four fixture files exist and are non-empty (`wc -c src/tradingview/lib/__fixtures__/*`); `rg -c "create_study" src/tradingview/lib/__fixtures__/chart-frames-rsi.txt` ≥ 1; `rg -c "sessionid=" src/tradingview/lib/__fixtures__/` returns nothing.

---

# Phase 1 — Study engine + `indicator` command

### Task 2: Types for bars, studies, signals

**Files:**
- Modify: `src/tradingview/lib/types.ts` (append at end)

- [ ] **Step 1: Append the new types** to `src/tradingview/lib/types.ts`:

```typescript
export interface Bar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface PineInput {
    id: string;
    name: string;
    type: string;
    defval: unknown;
    options?: string[];
    isHidden?: boolean;
    isFake?: boolean;
}

export interface PinePlot {
    id: string;
    type: string;
    title: string;
}

export interface StudyMeta {
    pineId: string;
    pineVersion: string;
    description: string;
    shortDescription: string;
    ilTemplate: string;
    inputs: PineInput[];
    plots: PinePlot[];
}

/** One bar's worth of study output: values aligned to StudyMeta.plots order. */
export interface StudyPoint {
    barIndex: number;
    time: number;
    values: Array<number | null>;
}

export interface SignalEvent {
    time: number;
    barIndex: number;
    plotId: string;
    plotTitle: string;
    value: number;
    kind: "history" | "live";
}
```

- [ ] **Step 2: Typecheck.** Run: `tsgo --noEmit 2>&1 | rg "src/tradingview"` — Expected: no output.
- [ ] **Step 3: Commit**

```bash
git add src/tradingview/lib/types.ts
git commit -m "feat(tradingview): study/signal types for the indicator engine"
```

### Task 3: `pine-facade.ts` — spec parsing + translate + auth pre-flight

**Files:**
- Create: `src/tradingview/lib/pine-facade.ts`
- Test: `src/tradingview/lib/pine-facade.test.ts`

- [ ] **Step 1: Write the failing tests** (spec parsing is pure; translate mapping uses the Task 1 fixture):

```typescript
import { describe, expect, test } from "bun:test";
import { mapTranslateResponse, parseScriptSpec } from "./pine-facade";
import stdRsi from "./__fixtures__/translate-std-rsi.json";

describe("parseScriptSpec", () => {
    test("passes through STD;/PUB;/USER; ids", () => {
        expect(parseScriptSpec("PUB;AGFHDbJ2")).toEqual({ pineId: "PUB;AGFHDbJ2" });
        expect(parseScriptSpec("STD;RSI")).toEqual({ pineId: "STD;RSI" });
    });

    test("extracts PUB id from a script-page URL", () => {
        const url = "https://www.tradingview.com/script/AGFHDbJ2-MDX-Free-PA-Buy-Sell-Confimation/";
        expect(parseScriptSpec(url)).toEqual({ pineId: "PUB;AGFHDbJ2" });
    });

    test("returns null for free-text (alias path handles it)", () => {
        expect(parseScriptSpec("rsi")).toBeNull();
    });
});

describe("mapTranslateResponse", () => {
    test("maps the captured STD;RSI translate fixture into StudyMeta", () => {
        const meta = mapTranslateResponse(stdRsi);
        expect(meta.pineId.startsWith("STD;")).toBe(true);
        expect(meta.ilTemplate.length).toBeGreaterThan(100);
        expect(meta.inputs.every((i) => !i.isFake)).toBe(true); // fake carriers stripped
        expect(meta.plots.length).toBeGreaterThan(0);
        expect(meta.plots[0].title.length).toBeGreaterThan(0); // titles merged from styles
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/pine-facade.test.ts` — Expected: FAIL, "Cannot find module './pine-facade'".
- [ ] **Step 3: Implement** `src/tradingview/lib/pine-facade.ts`:

```typescript
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { PineInput, PinePlot, StudyMeta } from "./types";
import { TV_ORIGIN } from "./ws";

const PINE_FACADE = "https://pine-facade.tradingview.com/pine-facade";
const SCRIPT_URL_RE = /tradingview\.com\/script\/([A-Za-z0-9]+)(?:-|\/|$)/;

export interface ScriptSpec {
    pineId: string;
}

/** "PUB;x" | "STD;x" | "USER;x" | script-page URL -> spec; free text -> null (alias path). */
export function parseScriptSpec(raw: string): ScriptSpec | null {
    const trimmed = raw.trim();
    if (/^(STD|PUB|USER);/.test(trimmed)) {
        return { pineId: trimmed };
    }
    const urlMatch = trimmed.match(SCRIPT_URL_RE);
    if (urlMatch) {
        return { pineId: `PUB;${urlMatch[1]}` };
    }
    return null;
}

interface TranslateEnvelope {
    success?: boolean;
    reason?: string;
    result?: {
        ilTemplate?: string;
        metaInfo?: {
            scriptIdPart?: string;
            description?: string;
            shortDescription?: string;
            pine?: { version?: string };
            inputs?: Array<{
                id?: string;
                name?: string;
                type?: string;
                defval?: unknown;
                options?: string[];
                isHidden?: boolean;
                isFake?: boolean;
            }>;
            plots?: Array<{ id?: string; type?: string }>;
            styles?: Record<string, { title?: string }>;
        };
    };
}

export function mapTranslateResponse(data: TranslateEnvelope): StudyMeta {
    const result = data.result;
    const meta = result?.metaInfo;
    if (!data.success || !result?.ilTemplate || !meta) {
        throw new Error(`pine-facade translate failed: ${data.reason ?? "missing result/metaInfo"}`);
    }

    const inputs: PineInput[] = (meta.inputs ?? [])
        .filter((i) => !i.isFake && !i.isHidden && i.id !== "text" && i.id !== "pineId" && i.id !== "pineVersion")
        .map((i) => ({
            id: i.id ?? "",
            name: i.name ?? i.id ?? "",
            type: i.type ?? "text",
            defval: i.defval,
            options: i.options,
        }));
    const plots: PinePlot[] = (meta.plots ?? []).map((p) => ({
        id: p.id ?? "",
        type: p.type ?? "line",
        title: meta.styles?.[p.id ?? ""]?.title ?? p.id ?? "",
    }));

    return {
        pineId: meta.scriptIdPart ?? "",
        pineVersion: meta.pine?.version ?? "1.0",
        description: meta.description ?? "",
        shortDescription: meta.shortDescription ?? "",
        ilTemplate: result.ilTemplate,
        inputs,
        plots,
    };
}

export async function translateIndicator({
    pineId,
    version = "last",
    cookie,
}: {
    pineId: string;
    version?: string;
    cookie?: string;
}): Promise<StudyMeta> {
    const url = `${PINE_FACADE}/translate/${encodeURIComponent(pineId)}/${encodeURIComponent(version)}`;
    logger.debug({ url }, "tradingview: pine-facade translate");
    const res = await fetch(url, {
        headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) },
    });
    if (!res.ok) {
        throw new Error(`pine-facade translate HTTP ${res.status} for ${pineId}`);
    }

    const data = SafeJSON.parse(await res.text(), { strict: true }) as TranslateEnvelope;
    return mapTranslateResponse(data);
}

export async function isAuthToGet({
    pineId,
    version = "last",
    cookie,
}: {
    pineId: string;
    version?: string;
    cookie?: string;
}): Promise<boolean> {
    const url = `${PINE_FACADE}/is_auth_to_get/${encodeURIComponent(pineId)}/${encodeURIComponent(version)}`;
    const res = await fetch(url, { headers: { origin: TV_ORIGIN, ...(cookie ? { cookie } : {}) } });
    if (!res.ok) {
        logger.debug({ status: res.status, pineId }, "tradingview: is_auth_to_get non-OK");
        return false;
    }

    const body = (await res.text()).trim();
    return body === "true" || body.includes('"auth":true') || body.includes("true");
}
```

  Note: the exact `is_auth_to_get` body shape comes from the Task 1 capture — adjust the final `return` to match what was actually observed and delete the speculative branches.

- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/pine-facade.test.ts` — Expected: PASS (all).
- [ ] **Step 5: Typecheck + commit**

```bash
tsgo --noEmit 2>&1 | rg "src/tradingview" ; git add src/tradingview/lib/pine-facade.ts src/tradingview/lib/pine-facade.test.ts
git commit -m "feat(tradingview): pine-facade translate + script spec parsing"
```

### Task 4: `indicator-aliases.ts` — friendly names → pineId

**Files:**
- Create: `src/tradingview/lib/indicator-aliases.ts`
- Test: `src/tradingview/lib/indicator-aliases.test.ts`

The standard-library listing endpoint is `GET https://pine-facade.tradingview.com/pine-facade/list/?filter=standard` (no auth) returning an array of entries with `scriptIdPart` (e.g. `STD;RSI`), `scriptName`, `version`. We cache it via `Storage` for 24h and resolve free text against it. A tiny hardcoded alias table covers everyday abbreviations whose full names differ (e.g. `bb` → "Bollinger Bands").

- [ ] **Step 1: Write the failing tests:**

```typescript
import { describe, expect, test } from "bun:test";
import { resolveAlias } from "./indicator-aliases";

const LIST = [
    { scriptIdPart: "STD;RSI", scriptName: "Relative Strength Index", version: "last" },
    { scriptIdPart: "STD;MACD", scriptName: "MACD", version: "last" },
    { scriptIdPart: "STD;Bollinger_Bands", scriptName: "Bollinger Bands", version: "last" },
    { scriptIdPart: "STD;VWAP", scriptName: "VWAP", version: "last" },
];

describe("resolveAlias", () => {
    test("alias table hit", () => {
        expect(resolveAlias("rsi", LIST)?.scriptIdPart).toBe("STD;RSI");
        expect(resolveAlias("bb", LIST)?.scriptIdPart).toBe("STD;Bollinger_Bands");
    });

    test("case-insensitive full-name match", () => {
        expect(resolveAlias("relative strength index", LIST)?.scriptIdPart).toBe("STD;RSI");
    });

    test("unknown name returns null", () => {
        expect(resolveAlias("frobnicator", LIST)).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/indicator-aliases.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/tradingview/lib/indicator-aliases.ts`:

```typescript
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";
import { TV_ORIGIN } from "./ws";

export interface StandardScript {
    scriptIdPart: string;
    scriptName: string;
    version: string;
}

const ALIASES: Record<string, string> = {
    rsi: "relative strength index",
    macd: "macd",
    ema: "moving average exponential",
    sma: "moving average simple",
    bb: "bollinger bands",
    vwap: "vwap",
    atr: "average true range",
    stoch: "stochastic",
    supertrend: "supertrend",
    adx: "average directional index",
    obv: "on balance volume",
};

const LIST_URL = "https://pine-facade.tradingview.com/pine-facade/list/?filter=standard";
const CACHE_KEY = "standard-scripts";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function resolveAlias(query: string, list: StandardScript[]): StandardScript | null {
    const q = (ALIASES[query.trim().toLowerCase()] ?? query.trim().toLowerCase()).trim();
    const exact = list.find((s) => s.scriptName.toLowerCase() === q);
    if (exact) {
        return exact;
    }

    const partial = list.filter((s) => s.scriptName.toLowerCase().includes(q));
    return partial.length === 1 ? partial[0] : null;
}

export async function fetchStandardList(): Promise<StandardScript[]> {
    const storage = new Storage("tradingview");
    const cached = await storage.getCacheValue<{ at: number; list: StandardScript[] }>(CACHE_KEY);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.list;
    }

    logger.debug({ url: LIST_URL }, "tradingview: fetching standard script list");
    const res = await fetch(LIST_URL, { headers: { origin: TV_ORIGIN } });
    if (!res.ok) {
        throw new Error(`pine-facade list HTTP ${res.status}`);
    }

    const raw = SafeJSON.parse(await res.text(), { strict: true }) as Array<Record<string, unknown>>;
    const list: StandardScript[] = raw
        .map((e) => ({
            scriptIdPart: String(e.scriptIdPart ?? ""),
            scriptName: String(e.scriptName ?? ""),
            version: String(e.version ?? "last"),
        }))
        .filter((e) => e.scriptIdPart.length > 0);
    await storage.setCacheValue(CACHE_KEY, { at: Date.now(), list });
    return list;
}
```

  ⚠️ `Storage` API: check `src/utils/storage/storage.ts` for the exact cache method names (`getCacheValue`/`setCacheValue` assumed here) and adjust — do NOT invent new storage helpers.

- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/indicator-aliases.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/indicator-aliases.ts src/tradingview/lib/indicator-aliases.test.ts
git commit -m "feat(tradingview): friendly indicator aliases backed by cached standard list"
```

### Task 5: `study.ts` — build the `create_study` payload

**Files:**
- Create: `src/tradingview/lib/study.ts`
- Test: `src/tradingview/lib/study.test.ts`

- [ ] **Step 1: Write the failing tests:**

```typescript
import { describe, expect, test } from "bun:test";
import type { StudyMeta } from "./types";
import { buildStudyValues, coerceInputValue, parseInputFlags } from "./study";

const META: StudyMeta = {
    pineId: "STD;RSI",
    pineVersion: "last",
    description: "Relative Strength Index",
    shortDescription: "RSI",
    ilTemplate: "IL_BLOB",
    inputs: [
        { id: "in_0", name: "Length", type: "integer", defval: 14 },
        { id: "in_1", name: "Source", type: "source", defval: "close", options: ["open", "close"] },
    ],
    plots: [{ id: "plot_0", type: "line", title: "RSI" }],
};

describe("parseInputFlags", () => {
    test("parses k=v pairs", () => {
        expect(parseInputFlags(["Length=21", "Source=open"])).toEqual({ length: "21", source: "open" });
    });

    test("rejects malformed pairs", () => {
        expect(() => parseInputFlags(["Length"])).toThrow(/expected name=value/);
    });
});

describe("coerceInputValue", () => {
    test("coerces by pine input type", () => {
        expect(coerceInputValue("21", "integer")).toBe(21);
        expect(coerceInputValue("0.5", "float")).toBe(0.5);
        expect(coerceInputValue("true", "bool")).toBe(true);
        expect(coerceInputValue("close", "source")).toBe("close");
    });

    test("throws on non-numeric integer", () => {
        expect(() => coerceInputValue("abc", "integer")).toThrow(/not a valid integer/);
    });
});

describe("buildStudyValues", () => {
    test("defaults + overrides + carriers", () => {
        const v = buildStudyValues(META, { length: "21" });
        expect(v.text).toBe("IL_BLOB");
        expect(v.pineId).toBe("STD;RSI");
        expect(v.pineVersion).toBe("last");
        expect(v.in_0).toEqual({ v: 21, f: true, t: "integer" });
        expect(v.in_1).toEqual({ v: "close", f: true, t: "source" });
    });

    test("unknown input name throws with the available names", () => {
        expect(() => buildStudyValues(META, { bogus: "1" })).toThrow(/Length, Source/);
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/study.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/tradingview/lib/study.ts`:

```typescript
import type { StudyMeta } from "./types";

export type StudyInputValue = { v: unknown; f: true; t: string };
export type StudyValues = { text: string; pineId: string; pineVersion: string } & Record<string, StudyInputValue | string>;

/** ["Length=21", ...] -> { length: "21" } (keys lowercased for case-insensitive matching). */
export function parseInputFlags(flags: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const flag of flags) {
        const eq = flag.indexOf("=");
        if (eq <= 0) {
            throw new Error(`--input "${flag}": expected name=value`);
        }

        result[flag.slice(0, eq).trim().toLowerCase()] = flag.slice(eq + 1).trim();
    }

    return result;
}

export function coerceInputValue(raw: string, type: string): unknown {
    if (type === "integer") {
        const n = Number(raw);
        if (!Number.isInteger(n)) {
            throw new Error(`"${raw}" is not a valid integer`);
        }

        return n;
    }

    if (type === "float") {
        const n = Number(raw);
        if (Number.isNaN(n)) {
            throw new Error(`"${raw}" is not a valid number`);
        }

        return n;
    }

    if (type === "bool") {
        return raw === "true" || raw === "1";
    }

    return raw;
}

/** Merge meta defaults with user overrides into the create_study values object. */
export function buildStudyValues(meta: StudyMeta, overrides: Record<string, string>): StudyValues {
    const values: StudyValues = { text: meta.ilTemplate, pineId: meta.pineId, pineVersion: meta.pineVersion };
    const known = new Map<string, (typeof meta.inputs)[number]>();
    for (const input of meta.inputs) {
        known.set(input.name.toLowerCase(), input);
        known.set(input.id.toLowerCase(), input);
        values[input.id] = { v: input.defval, f: true, t: input.type };
    }

    for (const [key, raw] of Object.entries(overrides)) {
        const input = known.get(key);
        if (!input) {
            const names = meta.inputs.map((i) => i.name).join(", ");
            throw new Error(`Unknown input "${key}". Available inputs: ${names}`);
        }

        values[input.id] = { v: coerceInputValue(raw, input.type), f: true, t: input.type };
    }

    return values;
}
```

- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/study.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/study.ts src/tradingview/lib/study.test.ts
git commit -m "feat(tradingview): create_study payload builder with typed input overrides"
```

### Task 6: `chart-client.ts` — the ChartClient (session, series, study parsing)

**Files:**
- Create: `src/tradingview/lib/chart-client.ts`
- Test: `src/tradingview/lib/chart-client.test.ts`

Mirror `quote-client.ts` exactly in style (typed EventEmitter + biome-ignore declaration merge, heartbeat echo, pending queue). The frame parser must be testable WITHOUT a network: expose `handleFrame(frame: string)` as a package-visible method and drive tests by feeding captured fixture frames.

- [ ] **Step 1: Write the failing tests** (use the Task 1 fixtures; the literals below show the SHAPE — replace index/values with ones present in your captured file):

```typescript
import { describe, expect, test } from "bun:test";
import { ChartClient } from "./chart-client";
import type { Bar, StudyPoint } from "./types";

function makeClient(): ChartClient {
    return new ChartClient({ authToken: "unauthorized_user_token" });
}

describe("ChartClient frame handling", () => {
    test("series snapshot emits bars", () => {
        const client = makeClient();
        const bars: Bar[] = [];
        client.on("bars", (b) => bars.push(...b));
        client.handleFrame(
            '{"m":"timescale_update","p":["cs_t",{"sds_1":{"s":[{"i":0,"v":[1781037360,100,110,90,105,5000]}]}}]}'
        );
        expect(bars).toEqual([{ time: 1781037360, open: 100, high: 110, low: 90, close: 105, volume: 5000 }]);
    });

    test("study data emits StudyPoints aligned to plot order", () => {
        const client = makeClient();
        const points: StudyPoint[] = [];
        client.on("studyData", ({ points: p }) => points.push(...p));
        client.handleFrame('{"m":"du","p":["cs_t",{"st_1":{"st":[{"i":42,"v":[1781037360,31.4,null]}]}}]}');
        expect(points).toEqual([{ barIndex: 42, time: 1781037360, values: [31.4, null] }]);
    });

    test("study_error is surfaced", () => {
        const client = makeClient();
        let err = "";
        client.on("studyError", ({ reason }) => {
            err = reason;
        });
        client.handleFrame('{"m":"study_error","p":["cs_t","st_1","s1","line 5: unknown identifier"]}');
        expect(err).toContain("unknown identifier");
    });

    test("tolerates string-NaN study values", () => {
        const client = makeClient();
        const points: StudyPoint[] = [];
        client.on("studyData", ({ points: p }) => points.push(...p));
        client.handleFrame('{"m":"du","p":["cs_t",{"st_1":{"st":[{"i":1,"v":[1781037420,"NaN",1]}]}}]}');
        expect(points[0].values).toEqual([null, 1]);
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/chart-client.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/tradingview/lib/chart-client.ts`:

```typescript
import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { encodeFrame, genSessionId, isHeartbeat, parseFrames } from "./protocol";
import type { StudyValues } from "./study";
import { toProSymbol } from "./symbols";
import type { Bar, StudyPoint } from "./types";
import { tvSocket } from "./ws";

interface ChartClientOpts {
    authToken?: string;
    host?: string;
    timezone?: string;
}

interface SymbolSpec {
    symbol: string;
    timeframe: string;
    barCount: number;
}

export interface ChartClient {
    on(event: "open", listener: () => void): this;
    on(event: "bars", listener: (bars: Bar[]) => void): this;
    on(event: "seriesCompleted", listener: () => void): this;
    on(event: "studyData", listener: (data: { studyId: string; points: StudyPoint[] }) => void): this;
    on(event: "studyCompleted", listener: (studyId: string) => void): this;
    on(event: "studyError", listener: (info: { studyId: string; reason: string }) => void): this;
    on(event: "symbolError", listener: (info: { symbol: string; errmsg: string }) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
}

/** Raw numeric cell from TV: numbers, null, or the literal string "NaN". */
function toCell(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    return null;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter events
export class ChartClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private readonly sessionId = genSessionId("cs_");
    private readonly authToken: string;
    private readonly host: string;
    private readonly timezone: string;
    private symbolSpec: SymbolSpec | null = null;
    private studyCounter = 0;
    private readonly studies = new Map<string, StudyValues>();
    private open = false;

    constructor(opts: ChartClientOpts = {}) {
        super();
        this.authToken = opts.authToken ?? "unauthorized_user_token";
        this.host = opts.host ?? "data.tradingview.com";
        this.timezone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    connect(): void {
        const url = `wss://${this.host}/socket.io/websocket?type=chart`;
        logger.debug({ url }, "tradingview: opening chart socket");
        this.ws = tvSocket(url);
        this.ws.addEventListener("open", () => this.onOpen());
        this.ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
        this.ws.addEventListener("error", () => this.emit("error", new Error("chart socket error")));
        this.ws.addEventListener("close", () => {
            this.open = false;
            this.emit("close");
        });
    }

    /** Must be called before connect(); one symbol/series per client (KISS for v1). */
    setSymbol(spec: SymbolSpec): void {
        this.symbolSpec = spec;
    }

    /** Attach a study; safe to call before or after connect(). Returns the study id. */
    addStudy(values: StudyValues): string {
        this.studyCounter += 1;
        const studyId = `st_${this.studyCounter}`;
        this.studies.set(studyId, values);
        if (this.open) {
            this.sendCreateStudy(studyId, values);
        }

        return studyId;
    }

    close(): void {
        this.ws?.close();
    }

    private onOpen(): void {
        if (!this.symbolSpec) {
            this.emit("error", new Error("setSymbol() must be called before connect()"));
            return;
        }

        this.open = true;
        this.send({ m: "set_auth_token", p: [this.authToken] });
        this.send({ m: "chart_create_session", p: [this.sessionId, ""] });
        this.send({ m: "switch_timezone", p: [this.sessionId, this.timezone] });
        this.send({
            m: "resolve_symbol",
            p: [this.sessionId, "sds_sym_1", toProSymbol(this.symbolSpec.symbol)],
        });
        this.send({
            m: "create_series",
            p: [this.sessionId, "sds_1", "s1", "sds_sym_1", this.symbolSpec.timeframe, this.symbolSpec.barCount, ""],
        });
        for (const [studyId, values] of this.studies) {
            this.sendCreateStudy(studyId, values);
        }

        this.emit("open");
    }

    private sendCreateStudy(studyId: string, values: StudyValues): void {
        this.send({
            m: "create_study",
            p: [this.sessionId, studyId, "st1", "sds_1", "Script@tv-scripting-101!", values],
        });
    }

    private onMessage(raw: string): void {
        for (const frame of parseFrames(raw)) {
            if (isHeartbeat(frame)) {
                this.ws?.send(encodeFrame(frame));
                continue;
            }

            this.handleFrame(frame);
        }
    }

    /** Package-visible for tests: handle one unwrapped JSON frame. */
    handleFrame(frame: string): void {
        let msg: { m?: string; p?: unknown[] };
        try {
            msg = SafeJSON.parse(frame, { strict: true });
        } catch {
            return;
        }

        if (!msg.m || !Array.isArray(msg.p)) {
            return;
        }

        if (msg.m === "timescale_update" || msg.m === "du") {
            this.handleData(msg.p);
            return;
        }

        if (msg.m === "series_completed") {
            this.emit("seriesCompleted");
            return;
        }

        if (msg.m === "study_completed") {
            this.emit("studyCompleted", String(msg.p[1] ?? ""));
            return;
        }

        if (msg.m === "study_error") {
            const reason = msg.p
                .slice(2)
                .map((part) => (typeof part === "string" ? part : SafeJSON.stringify(part)))
                .join(" ");
            this.emit("studyError", { studyId: String(msg.p[1] ?? ""), reason });
            return;
        }

        if (msg.m === "symbol_error") {
            this.emit("symbolError", { symbol: String(msg.p[2] ?? ""), errmsg: String(msg.p[3] ?? "symbol error") });
            return;
        }

        if (msg.m === "critical_error" || msg.m === "protocol_error") {
            this.emit("error", new Error(`${msg.m}: ${SafeJSON.stringify(msg.p)}`));
        }
    }

    private handleData(p: unknown[]): void {
        const payload = p[1];
        if (!payload || typeof payload !== "object") {
            return;
        }

        for (const [key, node] of Object.entries(payload as Record<string, unknown>)) {
            if (!node || typeof node !== "object") {
                continue;
            }

            const seriesRows = (node as { s?: unknown[] }).s;
            if (key.startsWith("sds_") && Array.isArray(seriesRows)) {
                const bars = seriesRows.map((row) => this.toBar(row)).filter((b): b is Bar => b !== null);
                if (bars.length > 0) {
                    this.emit("bars", bars);
                }

                continue;
            }

            const studyRows = (node as { st?: unknown[] }).st;
            if (key.startsWith("st_") && Array.isArray(studyRows)) {
                const points = studyRows.map((row) => this.toStudyPoint(row)).filter((x): x is StudyPoint => x !== null);
                if (points.length > 0) {
                    this.emit("studyData", { studyId: key, points });
                }
            }
        }
    }

    private toBar(row: unknown): Bar | null {
        const r = row as { i?: number; v?: unknown[] } | null;
        if (!r?.v || r.v.length < 5) {
            return null;
        }

        const [time, open, high, low, close, volume] = r.v;
        if (typeof time !== "number") {
            return null;
        }

        return {
            time,
            open: toCell(open) ?? 0,
            high: toCell(high) ?? 0,
            low: toCell(low) ?? 0,
            close: toCell(close) ?? 0,
            volume: toCell(volume) ?? undefined,
        };
    }

    private toStudyPoint(row: unknown): StudyPoint | null {
        const r = row as { i?: number; v?: unknown[] } | null;
        if (!r?.v || r.v.length < 2 || typeof r.v[0] !== "number") {
            return null;
        }

        return { barIndex: r.i ?? -1, time: r.v[0], values: r.v.slice(1).map(toCell) };
    }

    private send(obj: object): void {
        this.ws?.send(encodeFrame(obj));
    }
}
```

- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/chart-client.test.ts` — Expected: PASS.
- [ ] **Step 5: Replay full captured fixtures** — add one more test that reads `__fixtures__/chart-frames-rsi.txt`, feeds every line through `parseFrames` → `handleFrame`, and asserts bars.length > 0 and at least one studyData emission:

```typescript
test("replays the captured RSI session end-to-end", async () => {
    const raw = await Bun.file(new URL("./__fixtures__/chart-frames-rsi.txt", import.meta.url)).text();
    const client = makeClient();
    let barCount = 0;
    let studyEmits = 0;
    client.on("bars", (b) => {
        barCount += b.length;
    });
    client.on("studyData", () => {
        studyEmits += 1;
    });
    for (const line of raw.split("\n").filter(Boolean)) {
        for (const frame of parseFrames(line)) {
            if (!isHeartbeat(frame)) {
                client.handleFrame(frame);
            }
        }
    }
    expect(barCount).toBeGreaterThan(0);
    expect(studyEmits).toBeGreaterThan(0);
});
```

  (import `parseFrames`, `isHeartbeat` from `./protocol` in the test file)

- [ ] **Step 6: Run tests again.** Run: `bun test src/tradingview/lib/chart-client.test.ts` — Expected: PASS. If the replay test fails, the fixture shape differs from this plan's assumption — fix `handleData` to match the FIXTURE (ground truth), not the plan.
- [ ] **Step 7: Typecheck + commit**

```bash
tsgo --noEmit 2>&1 | rg "src/tradingview" ; git add src/tradingview/lib/chart-client.ts src/tradingview/lib/chart-client.test.ts
git commit -m "feat(tradingview): ChartClient — chart session, series bars, study data parsing"
```

### Task 7: ChartClient reconnect with backoff

Indicator watching is long-running (`--notify`); the JWT expires after 4h and TV drops idle/errored sockets. Reconnect must re-run the whole session setup (it already lives in `onOpen`) and re-attach studies (already in `onOpen`'s study loop).

**Files:**
- Modify: `src/tradingview/lib/chart-client.ts`
- Test: `src/tradingview/lib/chart-client.test.ts` (append)

- [ ] **Step 1: Write the failing test:**

```typescript
describe("reconnect", () => {
    test("schedules reconnects with exponential backoff and emits reconnecting", () => {
        const client = new ChartClient({ reconnect: true });
        const delays: number[] = [];
        client.on("reconnecting", ({ attempt, delayMs }) => {
            delays.push(delayMs);
            void attempt;
        });
        // simulate three consecutive closes without an open in between
        client.simulateCloseForTest();
        client.simulateCloseForTest();
        client.simulateCloseForTest();
        expect(delays).toEqual([1000, 2000, 4000]);
        client.dispose();
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/chart-client.test.ts` — Expected: FAIL ("reconnect"/"simulateCloseForTest" missing).
- [ ] **Step 3: Implement.** Changes to `chart-client.ts`:
  - Add to `ChartClientOpts`: `reconnect?: boolean; onAuthTokenRefresh?: () => Promise<string>;`
  - Add interface event: `on(event: "reconnecting", listener: (info: { attempt: number; delayMs: number }) => void): this;`
  - Add fields: `private reconnectAttempt = 0; private reconnectTimer: ReturnType<typeof setTimeout> | null = null; private disposed = false; private readonly reconnect: boolean; private authTokenCurrent: string; private readonly onAuthTokenRefresh?: () => Promise<string>;` (constructor wires them; `authTokenCurrent` starts as the constructor token and replaces direct `this.authToken` reads in `onOpen`).
  - Replace the close listener body with:

```typescript
this.ws.addEventListener("close", () => {
    this.open = false;
    this.emit("close");
    this.maybeReconnect();
});
```

  - Add the methods:

```typescript
private maybeReconnect(): void {
    if (!this.reconnect || this.disposed) {
        return;
    }

    if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer); // never stack timers across rapid closes
    }

    this.reconnectAttempt += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 30_000);
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.reconnectTimer = setTimeout(() => {
        void this.refreshAndConnect();
    }, delayMs);
}

private async refreshAndConnect(): Promise<void> {
    if (this.disposed) {
        return;
    }

    if (this.onAuthTokenRefresh) {
        try {
            this.authTokenCurrent = await this.onAuthTokenRefresh();
        } catch (err) {
            logger.warn({ err }, "tradingview: auth token refresh failed; reusing previous token");
        }
    }

    this.connect();
}

/** Test hook: trigger the close path without a socket. */
simulateCloseForTest(): void {
    this.open = false;
    this.emit("close");
    this.maybeReconnect();
}

dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
    }

    this.ws?.close();
}
```

  - In `onOpen()`, reset the counter: `this.reconnectAttempt = 0;` (first line after the guard).
- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/chart-client.test.ts` — Expected: PASS (all, including earlier ones).
- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/chart-client.ts src/tradingview/lib/chart-client.test.ts
git commit -m "feat(tradingview): chart socket reconnect with exponential backoff + JWT refresh hook"
```

### Task 8: `signals.ts` — shape-plot transitions → SignalEvents

**Files:**
- Create: `src/tradingview/lib/signals.ts`
- Test: `src/tradingview/lib/signals.test.ts`

Semantics: a mark exists when a `shapes`/`chars`/`arrows`-type plot has a non-null value at a bar. During the initial snapshot all marks are `kind: "history"`. After the snapshot (`markLive()` called when `study_completed` arrives), a mark appearing on a bar that previously had none is `kind: "live"` — re-delivery of the SAME mark (same plot, same bar) must NOT re-fire (TV re-sends the live bar on every tick).

- [ ] **Step 1: Write the failing tests:**

```typescript
import { describe, expect, test } from "bun:test";
import { SignalDetector } from "./signals";
import type { PinePlot } from "./types";

const PLOTS: PinePlot[] = [
    { id: "plot_0", type: "line", title: "RSI" },
    { id: "plot_1", type: "shapes", title: "Buy" },
    { id: "plot_2", type: "shapes", title: "Sell" },
];

describe("SignalDetector", () => {
    test("history snapshot yields history signals for non-null shape cells", () => {
        const det = new SignalDetector(PLOTS);
        const events = det.ingest([{ barIndex: 10, time: 1000, values: [55.2, 1, null] }]);
        expect(events).toEqual([
            { time: 1000, barIndex: 10, plotId: "plot_1", plotTitle: "Buy", value: 1, kind: "history" },
        ]);
    });

    test("line plots never produce signals", () => {
        const det = new SignalDetector(PLOTS);
        const events = det.ingest([{ barIndex: 11, time: 1060, values: [60.1, null, null] }]);
        expect(events).toEqual([]);
    });

    test("live mark fires once, re-delivery is deduped", () => {
        const det = new SignalDetector(PLOTS);
        det.ingest([{ barIndex: 10, time: 1000, values: [55.2, null, null] }]);
        det.markLive();
        const first = det.ingest([{ barIndex: 11, time: 1060, values: [48.0, null, 1] }]);
        const second = det.ingest([{ barIndex: 11, time: 1060, values: [48.0, null, 1] }]);
        expect(first.map((e) => e.kind)).toEqual(["live"]);
        expect(first[0].plotTitle).toBe("Sell");
        expect(second).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/signals.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/tradingview/lib/signals.ts`:

```typescript
import type { PinePlot, SignalEvent, StudyPoint } from "./types";

const SHAPE_TYPES = new Set(["shapes", "chars", "arrows"]);

export class SignalDetector {
    private readonly shapeIndexes: Array<{ valueIndex: number; plot: PinePlot }>;
    private readonly seen = new Set<string>();
    private live = false;

    constructor(plots: PinePlot[]) {
        this.shapeIndexes = plots
            .map((plot, valueIndex) => ({ valueIndex, plot }))
            .filter(({ plot }) => SHAPE_TYPES.has(plot.type));
    }

    /** Call when the initial snapshot is complete; subsequent marks are "live". */
    markLive(): void {
        this.live = true;
    }

    hasShapePlots(): boolean {
        return this.shapeIndexes.length > 0;
    }

    ingest(points: StudyPoint[]): SignalEvent[] {
        const events: SignalEvent[] = [];
        for (const point of points) {
            for (const { valueIndex, plot } of this.shapeIndexes) {
                const value = point.values[valueIndex];
                if (value === null || value === undefined) {
                    continue;
                }

                const key = `${plot.id}@${point.barIndex}`;
                if (this.seen.has(key)) {
                    continue;
                }

                this.seen.add(key);
                events.push({
                    time: point.time,
                    barIndex: point.barIndex,
                    plotId: plot.id,
                    plotTitle: plot.title,
                    value,
                    kind: this.live ? "live" : "history",
                });
            }
        }

        return events;
    }
}
```

- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/signals.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/signals.ts src/tradingview/lib/signals.test.ts
git commit -m "feat(tradingview): signal detector for plotshape marks with live dedupe"
```

### Task 9: `format.ts` — indicator renderers

**Files:**
- Modify: `src/tradingview/lib/format.ts` (append)
- Test: `src/tradingview/lib/format.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to the existing describe-block file; match existing test style):

```typescript
import { formatIndicatorHeader, formatSignalLine, formatStudyRow } from "./format";

describe("indicator formatting", () => {
    const plots = [
        { id: "plot_0", type: "line", title: "RSI" },
        { id: "plot_1", type: "shapes", title: "Buy" },
    ];

    test("study row renders time + numeric cells, em-dash for null", () => {
        const row = formatStudyRow({ barIndex: 1, time: 1781037360, values: [31.42, null] }, plots);
        expect(row).toContain("31.42");
        expect(row).toContain("—");
    });

    test("signal line includes title and ▲/bar time", () => {
        const line = formatSignalLine(
            { time: 1781037360, barIndex: 1, plotId: "plot_1", plotTitle: "Buy", value: 1, kind: "live" },
            "BYBIT:BTCUSDT.P"
        );
        expect(line).toContain("Buy");
        expect(line).toContain("BYBIT:BTCUSDT.P");
    });

    test("header lists plot columns", () => {
        expect(formatIndicatorHeader(plots)).toContain("RSI");
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/format.test.ts` — Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** — append to `src/tradingview/lib/format.ts`:

```typescript
import type { PinePlot, SignalEvent, StudyPoint } from "./types";

function fmtTime(epochSeconds: number): string {
    const d = new Date(epochSeconds * 1000);
    return d.toISOString().replace("T", " ").slice(0, 16);
}

function fmtCell(value: number | null): string {
    if (value === null) {
        return "—";
    }

    return Math.abs(value) >= 1000 ? value.toFixed(1) : value.toFixed(2);
}

export function formatIndicatorHeader(plots: PinePlot[]): string {
    const cols = plots.map((p) => p.title.padStart(10)).join(" ");
    return pc.bold(`${"time".padEnd(16)} ${cols}`);
}

export function formatStudyRow(point: StudyPoint, plots: PinePlot[]): string {
    const cells = point.values
        .slice(0, plots.length)
        .map((v, i) => {
            const text = fmtCell(v).padStart(10);
            return plots[i].type === "line" ? text : v === null ? pc.dim(text) : pc.yellow(text);
        })
        .join(" ");
    return `${pc.dim(fmtTime(point.time))} ${cells}`;
}

export function formatSignalLine(event: SignalEvent, symbol: string): string {
    const arrow = /sell|down|short/i.test(event.plotTitle) ? pc.red("▼") : pc.green("▲");
    const tag = event.kind === "live" ? pc.bgYellow(pc.black(" SIGNAL ")) : pc.dim("[hist]");
    return `${tag} ${arrow} ${pc.bold(event.plotTitle)}  ${symbol}  ${fmtTime(event.time)} (bar ${event.barIndex})`;
}
```

  (`pc` — picocolors — is already imported at the top of format.ts; merge imports, don't duplicate.)
- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/format.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/format.ts src/tradingview/lib/format.test.ts
git commit -m "feat(tradingview): indicator table/signal renderers"
```

### Task 10: `notify.ts` — say / exec on signals

**Files:**
- Create: `src/tradingview/lib/notify.ts`
- Test: `src/tradingview/lib/notify.test.ts`

Fire-and-forget: spawn detached, never await completion, never throw into the signal path. `--exec` receives the signal as `TV_SIGNAL` env var (JSON).

- [ ] **Step 1: Write the failing test** (inject a spawner so no real processes run):

```typescript
import { describe, expect, test } from "bun:test";
import { notifySignal } from "./notify";
import type { SignalEvent } from "./types";

const EVENT: SignalEvent = { time: 1781037360, barIndex: 1, plotId: "plot_1", plotTitle: "Buy", value: 1, kind: "live" };

describe("notifySignal", () => {
    test("spawns say and exec with TV_SIGNAL env", () => {
        const calls: Array<{ cmd: string[]; env?: Record<string, string> }> = [];
        notifySignal(EVENT, "BYBIT:BTCUSDT.P", { say: true, exec: "echo hi" }, (cmd, env) => {
            calls.push({ cmd, env });
        });
        const sayCall = calls.find((c) => c.cmd[0] === "tools");
        const execCall = calls.find((c) => c.cmd[0] === "sh");
        expect(sayCall?.cmd.join(" ")).toContain("Buy");
        expect(execCall?.env?.TV_SIGNAL).toContain('"plotTitle":"Buy"');
    });

    test("does nothing when no channels enabled", () => {
        const calls: string[][] = [];
        notifySignal(EVENT, "X", {}, (cmd) => {
            calls.push(cmd);
        });
        expect(calls).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test src/tradingview/lib/notify.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/tradingview/lib/notify.ts`:

```typescript
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { SignalEvent } from "./types";

export interface NotifyOpts {
    say?: boolean;
    exec?: string;
}

type Spawner = (cmd: string[], env?: Record<string, string>) => void;

const defaultSpawner: Spawner = (cmd, env) => {
    try {
        Bun.spawn(cmd, {
            env: { ...process.env, ...(env ?? {}) },
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
        }).unref();
    } catch (err) {
        logger.warn({ err, cmd: cmd[0] }, "tradingview: notify spawn failed");
    }
};

export function notifySignal(event: SignalEvent, symbol: string, opts: NotifyOpts, spawner: Spawner = defaultSpawner): void {
    if (opts.say) {
        const short = symbol.includes(":") ? symbol.split(":")[1] : symbol;
        spawner(["tools", "say", `${short} ${event.plotTitle} signal`, "--app", "tradingview"]);
    }

    if (opts.exec) {
        spawner(["sh", "-c", opts.exec], { TV_SIGNAL: SafeJSON.stringify({ ...event, symbol }, { strict: true }) });
    }
}
```

- [ ] **Step 4: Run tests.** Run: `bun test src/tradingview/lib/notify.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/notify.ts src/tradingview/lib/notify.test.ts
git commit -m "feat(tradingview): signal notifications (say/exec) with injectable spawner"
```

### Task 11: `commands/indicator.ts` + registration — the core command

**Files:**
- Create: `src/tradingview/commands/indicator.ts`
- Modify: `src/tradingview/index.ts`

No unit tests for the controller (it is glue); correctness is covered by lib tests + the verification playbook. Keep ALL protocol/data logic in lib — if you find yourself parsing frames here, stop and move it to lib.

- [ ] **Step 1: Implement** `src/tradingview/commands/indicator.ts`:

```typescript
import { logger, out } from "@app/logger";
import pc from "picocolors";
import { fetchAuthToken, resolveSession } from "../lib/auth";
import { ChartClient } from "../lib/chart-client";
import { formatIndicatorHeader, formatSignalLine, formatStudyRow } from "../lib/format";
import { fetchStandardList, resolveAlias } from "../lib/indicator-aliases";
import { notifySignal } from "../lib/notify";
import { isAuthToGet, parseScriptSpec, translateIndicator } from "../lib/pine-facade";
import { SignalDetector } from "../lib/signals";
import { buildStudyValues, parseInputFlags } from "../lib/study";
import { normalizeTicker } from "../lib/symbols";
import type { StudyMeta, StudyPoint } from "../lib/types";

export interface IndicatorOpts {
    tf: string;
    bars: string;
    input: string[];
    once?: boolean;
    signalsOnly?: boolean;
    json?: boolean;
    notify?: boolean;
    exec?: string;
    cookie?: string;
}

async function resolveMeta(spec: string, cookie: string | undefined): Promise<StudyMeta> {
    const parsed = parseScriptSpec(spec);
    if (parsed) {
        return translateIndicator({ pineId: parsed.pineId, cookie });
    }

    const list = await fetchStandardList();
    const hit = resolveAlias(spec, list);
    if (!hit) {
        throw new Error(`Unknown indicator "${spec}". Try a STD;/PUB; id, a script URL, or 'tools tradingview indicators ${spec}' to search.`);
    }

    return translateIndicator({ pineId: hit.scriptIdPart, version: hit.version, cookie });
}

export async function runIndicator(spec: string, symbol: string, opts: IndicatorOpts): Promise<void> {
    const ticker = normalizeTicker(symbol);
    const session = await resolveSession({ cookie: opts.cookie });
    const cookie = session?.cookie;

    const meta = await resolveMeta(spec, cookie);
    if (meta.pineId.startsWith("PUB;")) {
        const allowed = await isAuthToGet({ pineId: meta.pineId, version: meta.pineVersion, cookie });
        if (!allowed) {
            out.error(`Your account cannot access ${meta.pineId} (${meta.shortDescription || meta.description}).`);
            process.exit(1);
        }
    }

    let authToken = "unauthorized_user_token";
    let host = "data.tradingview.com";
    if (session) {
        authToken = await fetchAuthToken(session.cookie);
        host = "prodata.tradingview.com";
    } else if (meta.pineId.startsWith("PUB;")) {
        out.warn("No session configured — community scripts usually need one. Trying as guest.");
    }

    const values = buildStudyValues(meta, parseInputFlags(opts.input));
    const detector = new SignalDetector(meta.plots);
    const client = new ChartClient({
        authToken,
        host,
        reconnect: !opts.once,
        onAuthTokenRefresh: session ? () => fetchAuthToken(session.cookie) : undefined,
    });
    client.setSymbol({ symbol: ticker, timeframe: opts.tf, barCount: Number(opts.bars) });
    client.addStudy(values);

    out.printErr(pc.dim(`${meta.description} on ${ticker} (${opts.tf}, ${opts.bars} bars) via ${host} — Ctrl-C to stop\n`));
    if (!opts.signalsOnly && !opts.json) {
        out.printlnErr(formatIndicatorHeader(meta.plots));
    }

    const snapshot: StudyPoint[] = [];
    let liveMode = false;

    const emitPoint = (point: StudyPoint): void => {
        if (opts.json) {
            out.print(`${SafeJSONLine({ type: "point", symbol: ticker, ...point })}\n`);
            return;
        }

        if (!opts.signalsOnly) {
            out.printlnErr(formatStudyRow(point, meta.plots));
        }
    };

    client.on("studyData", ({ points }) => {
        for (const point of points) {
            if (liveMode) {
                emitPoint(point);
            } else {
                snapshot.push(point);
            }
        }

        for (const event of detector.ingest(points)) {
            if (opts.json) {
                out.print(`${SafeJSONLine({ type: "signal", symbol: ticker, ...event })}\n`);
            } else {
                out.printlnErr(formatSignalLine(event, ticker));
            }

            if (event.kind === "live") {
                notifySignal(event, ticker, { say: opts.notify, exec: opts.exec });
            }
        }
    });

    client.on("studyCompleted", () => {
        if (liveMode) {
            return;
        }

        snapshot.sort((a, b) => a.barIndex - b.barIndex);
        const tail = snapshot.slice(-Number(opts.bars));
        for (const point of tail) {
            emitPoint(point);
        }

        detector.markLive();
        liveMode = true;
        if (opts.once) {
            client.dispose();
            process.exit(0);
        }

        out.printErr(pc.dim("\n— live —\n"));
    });

    client.on("studyError", ({ reason }) => {
        out.error(`Study error: ${reason}`);
        client.dispose();
        process.exit(1);
    });
    client.on("symbolError", ({ symbol: sym, errmsg }) => {
        out.error(`✗ ${sym}: ${errmsg === "no_such_symbol" ? "no such symbol (check the EXCHANGE:TICKER spelling)" : errmsg}`);
        client.dispose();
        process.exit(1);
    });
    client.on("reconnecting", ({ attempt, delayMs }) =>
        out.printErr(pc.dim(`reconnecting (attempt ${attempt}) in ${Math.round(delayMs / 1000)}s…\n`))
    );
    client.on("error", (err) => logger.error({ err }, "tradingview: chart socket error"));

    process.on("SIGINT", () => {
        client.dispose();
        process.exit(0);
    });

    client.connect();
    await new Promise(() => {});
}
```

  Where `SafeJSONLine` is a two-line local helper at the top of the file (after imports):

```typescript
import { SafeJSON } from "@app/utils/json";

function SafeJSONLine(obj: object): string {
    return SafeJSON.stringify(obj, { strict: true }) ?? "";
}
```

  ⚠️ Check `out`'s real API in `@app/logger` before writing: the existing commands use `out.error`, `out.warn`, `out.printErr`, `out.printlnErr`, and stdout results go through `out.result`/`out.print`. NDJSON streaming uses `out.print` (stdout) so it is pipeable; human rendering stays on stderr like `quotes.ts` does.

- [ ] **Step 2: Register the command** — add to `src/tradingview/index.ts` after the `alerts` block:

```typescript
program
    .command("indicator")
    .description("Stream an indicator's values and signal marks for a symbol (history, then live)")
    .argument("<spec>", "Indicator: alias (rsi), name, STD;/PUB; id, or script URL")
    .argument("<symbol>", "Symbol like NASDAQ:AAPL or BYBIT:BTCUSDT.P")
    .option("--tf <resolution>", "Timeframe: 1, 5, 15, 60, 240, 1D, 1W…", "1D")
    .option("--bars <n>", "History bars to load", "300")
    .option("--input <name=value...>", "Override indicator inputs (repeatable)", (v: string, acc: string[]) => [...acc, v], [])
    .option("--once", "Print the history snapshot and exit")
    .option("--signals-only", "Suppress numeric rows; print only signal marks")
    .option("--json", "NDJSON to stdout (points + signals)")
    .option("--notify", "Voice notification on live signals (tools say)")
    .option("--exec <cmd>", "Run shell command on live signals (signal JSON in $TV_SIGNAL)")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .action((spec: string, symbol: string, opts: IndicatorOpts) => runIndicator(spec, symbol, opts));
```

  with `import { type IndicatorOpts, runIndicator } from "./commands/indicator";` at the top.
- [ ] **Step 3: Typecheck.** Run: `tsgo --noEmit 2>&1 | rg "src/tradingview"` — Expected: no output. Fix anything it prints.
- [ ] **Step 4: Smoke-run (guest, built-in).** Run: `timeout 30 bun run src/tradingview/index.ts indicator rsi NASDAQ:AAPL --once 2>&1 | tail -25` — Expected: an RSI table (≈300 rows, last rows with plausible 0-100 values), exit before the timeout. If `study_error` mentions the runtime type string, re-check it against the Task 1 capture.
- [ ] **Step 5: Commit**

```bash
git add src/tradingview/commands/indicator.ts src/tradingview/index.ts
git commit -m "feat(tradingview): indicator command — history + live values, signals, notify hooks"
```

### Task 12: README + handoff update for Phase 1

**Files:**
- Modify: `src/tradingview/README.md`
- Modify (append-only): the Obsidian handoff

- [ ] **Step 1:** Add an `## indicator` section to the README documenting all flags from Task 11 Step 2 plus 3 worked examples (rsi daily once; MDX 15m live with --notify; --json piping into jq).
- [ ] **Step 2:** Append a `## <date> — Phase 1 implemented` section to the handoff: what shipped, any shape corrections discovered vs. this plan.
- [ ] **Step 3:** Run the **Phase 1 section of the verification playbook** (`2026-06-09-TradingViewIndicators.verify.md`). All checks must pass before Phase 2.
- [ ] **Step 4: Commit**

```bash
git add src/tradingview/README.md
git commit -m "docs(tradingview): indicator command usage"
```

---

# Phase 2 — Saved charts inventory + `--from-chart`

### Task 13: Charts-storage capture (operator-assisted)

Same setup as Task 1. The handoff only captured the *sources* URL shape (`charts-storage.tradingview.com/charts-storage/get/layout/<layout>/sources?chart_id=...&jwt=...`) and the token mint (`/chart-token/?image_url=<layout>&user_id=<id>`); the layout LIST endpoint must be captured fresh.

**Files:**
- Create: `src/tradingview/lib/__fixtures__/charts-list.json`
- Create: `src/tradingview/lib/__fixtures__/charts-sources.json`
- Modify (append-only): the handoff

- [ ] **Step 1:** With chrome-devtools MCP on a logged-in session, open `https://www.tradingview.com/chart/` and the layout-switcher dialog; find the XHR that lists layouts (`list_network_requests` filtered to fetch/xhr; look for `charts` in URLs). Record method/URL/headers/response → `charts-list.json`.
- [ ] **Step 2:** Open one layout that has studies; capture the `charts-storage/.../sources` request+response → `charts-sources.json`. Confirm where studies and their inputs live in the payload, and whether `jwt` comes from `/chart-token/`.
- [ ] **Step 3:** Append endpoint documentation to the handoff (`## <date> — charts-storage capture`). Sanitize fixtures (no sessionid/jwt values).
- [ ] **Step 4: Commit** (`chore(tradingview): charts-storage fixtures`).

### Task 14: `charts-storage.ts`

**Files:**
- Create: `src/tradingview/lib/charts-storage.ts`
- Test: `src/tradingview/lib/charts-storage.test.ts`

- [ ] **Step 1: Write failing tests** against the captured fixtures — `mapLayoutList(fixture)` returns `[{ id, name, symbol, resolution, modified }]`; `mapLayoutStudies(fixture)` returns `[{ name, pineId?, inputs: Record<string, unknown> }]`. Exact property paths come from YOUR fixtures; assert on real values you can see in them.
- [ ] **Step 2:** Run: `bun test src/tradingview/lib/charts-storage.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `charts-storage.ts` with `listLayouts(session)` / `getLayoutStudies(session, layoutId)` (fetch + the two pure `map*` functions; chart-token mint inside `getLayoutStudies` if Step 2 of Task 13 proved it required). Follow the alerts-rest.ts house style: cookie + origin headers, envelope unwrap, SafeJSON strict.
- [ ] **Step 4:** Run tests — Expected: PASS. Typecheck clean.
- [ ] **Step 5: Commit** (`feat(tradingview): charts-storage layouts + studies`).

### Task 15: `commands/charts.ts` + `--from-chart`

**Files:**
- Create: `src/tradingview/commands/charts.ts`
- Modify: `src/tradingview/index.ts`, `src/tradingview/commands/indicator.ts`, `src/tradingview/lib/format.ts`

- [ ] **Step 1:** `tools tradingview charts` lists layouts (`formatLayoutRow` in format.ts: `name  symbol  resolution  modified  N studies`); `tools tradingview charts <layoutId>` prints each study with its inputs.
- [ ] **Step 2:** Add `--from-chart <layoutId>` to the indicator command: instead of `<spec>`, pull the layout's studies, translate each by pineId with the layout's saved input values, attach ALL of them to one ChartClient (one `addStudy` per study; cap at 5 with a warning — JWT `max_studies` is 25 but each adds load), label output rows/signals with the study's shortDescription. `<spec>` becomes optional (`.argument("[spec]")`) — error if both/neither given.
- [ ] **Step 3:** Typecheck + smoke (`tools tradingview charts` with your session lists your real layouts).
- [ ] **Step 4: Commit** (`feat(tradingview): charts inventory + indicator --from-chart`).

---

# Phase 3 — Indicator library listing

### Task 16: `commands/indicators.ts` (list/search)

**Files:**
- Create: `src/tradingview/commands/indicators.ts`
- Modify: `src/tradingview/lib/pine-facade.ts`, `src/tradingview/index.ts`
- Test: extend `src/tradingview/lib/pine-facade.test.ts`

- [ ] **Step 1:** Add `listIndicators({ filter, cookie })` to pine-facade.ts — GET `${PINE_FACADE}/list/?filter=<standard|saved|favorites>` (note: `saved`/`favorites` REQUIRE the cookie; exact filter tokens to verify in DevTools if `saved` 401s — capture like Task 13 Step 1). Map to `StandardScript[]`. Failing-then-passing test with a small inline fixture (3 entries) for the mapping.
- [ ] **Step 2:** `tools tradingview indicators [query] [--filter standard|saved|favorites]` — lists `pineId  name  version`, filtered by case-insensitive substring when `query` given. Reuses `fetchStandardList` cache for `standard`.
- [ ] **Step 3:** Typecheck + smoke: `tools tradingview indicators rsi` shows `STD;RSI`-family rows; `tools tradingview indicators --filter saved` shows your scripts (session required).
- [ ] **Step 4: Commit** (`feat(tradingview): indicator library listing/search`).

---

# Phase 4 — Multi-symbol scan

### Task 17: `scanner.ts` + `commands/scan.ts`

**Files:**
- Create: `src/tradingview/lib/scanner.ts`, `src/tradingview/commands/scan.ts`
- Modify: `src/tradingview/index.ts`
- Test: `src/tradingview/lib/scanner.test.ts`

The scanner is plain REST: `POST https://scanner.tradingview.com/global/scan` with body `{"symbols":{"tickers":["NASDAQ:AAPL","BYBIT:BTCUSDT.P"]},"columns":["close","RSI","RSI[1]","MACD.macd","MACD.signal","Recommend.All"]}` → `{"data":[{"s":"NASDAQ:AAPL","d":[273.5,61.2,...]}],"totalCount":2}`. No auth needed for these fields. Column tokens are scanner-specific (NOT pine ids) — keep a small curated map: `rsi→RSI`, `macd→MACD.macd,MACD.signal`, `stoch→Stoch.K,Stoch.D`, `adx→ADX`, `atr→ATR`, `ema50→EMA50`, `ema200→EMA200`, `sma50→SMA50`, `rating→Recommend.All`, plus passthrough for raw tokens.

- [ ] **Step 1: Failing tests** for `buildScanRequest(["rsi","macd"], tickers)` (column expansion + dedupe, `close` always included first) and `mapScanResponse(fixtureInline)` (zip columns back onto symbols; missing values → null).
- [ ] **Step 2:** Run: `bun test src/tradingview/lib/scanner.test.ts` — Expected: FAIL. Then implement `scanner.ts` (`buildScanRequest`, `mapScanResponse`, `scan({ indicators, tickers })` doing the fetch with origin header + SafeJSON strict parse). Tests PASS.
- [ ] **Step 3:** `commands/scan.ts`: `tools tradingview scan <indicators> --symbols <list>` (both comma-separated; `--json` for `out.result`). Table renderer `formatScanTable` in format.ts (columns: symbol, close, then expanded indicator columns; reuse the table util `src/utils/table.ts` if it fits, else simple padded columns like formatIndicatorHeader).
- [ ] **Step 4:** Typecheck + smoke: `tools tradingview scan rsi,rating --symbols NASDAQ:AAPL,NASDAQ:MSFT` prints two rows with plausible RSI (0-100) and rating (-1..1) values.
- [ ] **Step 5: Commit** (`feat(tradingview): multi-symbol indicator scan via scanner API`).

---

# Final task

### Task 18: Docs, full verification, wrap-up

- [ ] **Step 1:** README: add `charts`, `indicators`, `scan` sections with one example each; update the feature table at the top.
- [ ] **Step 2:** Run the FULL verification playbook (`.claude/plans/2026-06-09-TradingViewIndicators.verify.md`), all phases. Fix anything red before proceeding.
- [ ] **Step 3:** Full repo gates: `bun test src/tradingview` (all pass) and `tsgo --noEmit 2>&1 | rg "src/tradingview"` (empty).
- [ ] **Step 4:** Append final status section to the Obsidian handoff (what shipped, verified commands, any protocol corrections).
- [ ] **Step 5:** Commit + push the branch (`git push -u origin feat/tradingview` — push from INSIDE this worktree, never from the main repo).

---

## Self-review notes (resolved during plan writing)

- `quote_set_fields`-style field minimization doesn't apply to studies — plot set is fixed by the script. No action.
- `SafeJSON.stringify` may return undefined per its type; `SafeJSONLine` helper guards. Lib files use `{ strict: true }` parsing for API responses (real JSON, no comments).
- ChartClient deliberately supports ONE series/symbol per socket in v1 (YAGNI); multi-study on one symbol IS supported (needed by `--from-chart`). Multi-symbol = run multiple processes or extend later.
- Storage cache method names in Task 4 are assumptions — verify against `src/utils/storage/storage.ts` before coding (flagged inline).
- The runtime type string `"Script@tv-scripting-101!"` and the STD pineId format are the two highest-risk literals; both are pinned by Task 1's capture before any dependent code is written.

---

# 2026-06-10 — Reality reconciliation (post-implementation)

> Implementation landed (commits `455362ea7`…`e0ffb8136` + cleanup). Where this plan's protocol assumptions conflicted with reality, **reality won** per the plan's own rule. Full divergence catalog: `.claude/plans/GrokFileDrift.md`. The corrections below SUPERSEDE the corresponding text above — do not "fix" the code back to the plan.

1. **PUB slug ≠ scriptIdPart.** `PUB;AGFHDbJ2` is a publication slug (the script-page `imageUrl`); `pine-facade/translate` 404s on it. The internal id is `PUB;0u4crLN8uj6zMzf6TJ0lhIuiKOKlHd7G`, resolved at runtime by `resolvePubScriptRef()` (pubscripts-suggest-json search by slug, then script-page single-id / og:title fallback). `create_study.pineId` still gets the user-facing slug (matches official-client capture). Task 3's "translate the parsed pineId directly" is therefore amended.
2. **`is_auth_to_get` is NOT an execution gate.** It checks *source-code* access and returns `false` for protected scripts that execute fine. The Task 11 pre-flight block and the Auth-matrix bullet are dropped; translate success is the execution check. `isAuthToGet()` stays exported (documented) for a future UI's "view source" affordance.
3. **Charts endpoints (Phase 2).** Reality: `GET https://www.tradingview.com/my-charts/?limit=100` (layout list) and `GET https://www.tradingview.com/chart/{layoutId}/json/` (layout content incl. `content_study_meta`). No charts-storage host, no `/chart-token/` JWT mint. Task 13/14's charts-storage flow is superseded. Saved layouts store the **hash** form of PUB ids, so `--from-chart` needs no slug resolution.
4. **Empty-cell sentinel `1e+100`.** Live study frames encode absent shape/arrow slots as the number `1e+100` (alongside `null` and string `"NaN"` seen elsewhere). `toCell()` treats `|v| >= 1e99` as null. The primer's "null or string-NaN" list is amended.
5. **STD ids are bare** (`STD;RSI`); the `@tv-basicstudies` suffixed form 404s on translate.
6. **MDX plot map** (from `__fixtures__/translate-pub-mdx.json`): `plot_0` "ma slope" (line), `plot_1` colorer (ignored by signals), `plot_2` "Buy" / `plot_3` "Sell" (shapes), `plot_4` "Up Entry Arrow" / `plot_5` "Down Entry Arrow" (arrows). MDX `pineVersion` from translate is `1.0` (official client sent `2.0` in the capture; both attach fine).
7. **Shape signals come from plot columns only.** MDX also streams `graphicsCmds` (dwglabels/dwglines) in `du` frames; the implementation ignores graphics and reads numeric plot slots — sufficient for Buy/Sell/arrows. Graphics parsing = future work.
8. **Fixtures:** `translate-pub-mdx.json` = real 200 body for the hash id; `translate-pub-mdx-404.json` = the slug 404 envelope kept as documentation of drift #1. The `resolvePubScriptRef` slug test is live-network and gated behind `TV_NET_TESTS=1`.
9. **Capture method:** Task 1/13 harvesting was done by a standalone script `scripts/capture-tv-study-frames.ts` (native WS + translate) instead of the chrome-devtools `__wsCap` rig; the runner for the verify playbook is `scripts/tv-verify-all.sh`.
