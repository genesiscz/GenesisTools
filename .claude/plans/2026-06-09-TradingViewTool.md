# TradingView Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/tradingview/` — a GenesisTools CLI that streams TradingView's live quote WebSocket feed and the live price-alerts feed (fires + create/update/delete events) to the terminal in a nicely formatted way.

**Architecture:** Two independent real-time clients over the reverse-engineered TradingView protocols. (1) The **quotes** feed connects to `wss://data.tradingview.com/socket.io/websocket` using the socket.io-style `~m~<len>~m~<json>` framing, authenticates as guest (`unauthorized_user_token`) or with a real JWT, creates a quote session and streams `qsd` (quote symbol data) frames. (2) The **alerts** feed lists existing alerts via the `pricealerts.tradingview.com` REST API and subscribes to the cookie-authenticated push socket `wss://pushstream.tradingview.com/message-pipe-ws/private_feed`, decoding `alert_fired` / `alerts_created` / `alerts_updated` events. Protocol framing + heartbeat live in a shared `protocol.ts`; each feed is a small `EventEmitter`-style client; commands are thin controllers; formatting is isolated for testability.

**Tech Stack:** TypeScript on Bun, `commander` (CLI), `@clack/prompts` + `picocolors` (UX), `ws` v7 (WebSocket with custom handshake headers — already installed), `@app/logger` (`logger`/`out`), `@app/utils/storage` (`Storage` for the session config), `@app/utils/json` (`SafeJSON`).

---

## Reverse-Engineered Protocol Reference

This section is ground truth captured live from `tradingview.com` on 2026-06-09 (a logged-in `pro_premium` session). Implement against it exactly.

### Frame framing (both quote sockets)

Every logical message is wrapped: `~m~<byteLength>~m~<payload>`. A single WS message may concatenate several frames. `<payload>` is either:
- a JSON object string, e.g. `{"m":"qsd","p":[...]}`, or
- a heartbeat token `~h~<N>` (e.g. `~h~2`).

**Heartbeat:** server sends `~m~4~m~~h~2`. The client MUST echo the inner token back, re-wrapped: send `~m~3~m~~h~2`. (The wrapper length is the byte length of `~h~2` = 4… note: the inner token `~h~2` is 4 bytes, so the echo is `~m~4~m~~h~2`. Use the actual byte length of the token string.) Failing to echo causes disconnect after ~20s.

**Encode helper:** `` const frame = (obj) => { const s = JSON.stringify(obj); return `~m~${s.length}~m~${s}`; } `` — note TradingView uses the JSON string `.length` (UTF-16 code units), which matches byte length for the ASCII payloads it sends. Use string length to be byte-for-byte identical to the official client.

### Quotes feed

- **URL (guest, realtime-where-allowed):** `wss://data.tradingview.com/socket.io/websocket?type=chart`
- **URL (authenticated / pro data):** `wss://prodata.tradingview.com/socket.io/websocket?type=chart` (requires the JWT below).
- **Origin header required:** `https://www.tradingview.com` (set on the WS handshake or the server rejects).
- **Handshake greeting (incoming, ignore):** `~m~NNN~m~{"session_id":"...","timestamp":...,"release":"...","studies_metadata_hash":"...","...":...}`
- **Outgoing sequence (client → server):**
  1. `{"m":"set_auth_token","p":["<JWT or 'unauthorized_user_token'>"]}`
  2. `{"m":"quote_create_session","p":["<qsSessionId>"]}` — session id is any unique string, the official client uses `qs_<12 random base62>`.
  3. `{"m":"quote_set_fields","p":["<qsSessionId>", "lp","ch","chp","volume","short_name","description", ...moreFields]}`
  4. `{"m":"quote_add_symbols","p":["<qsSessionId>", "NASDAQ:AAPL"]}` (repeat per symbol; symbol may be a plain `EXCHANGE:TICKER` string or a JSON spec string like `={"adjustment":"splits","symbol":"NASDAQ:MSTR"}`).
- **Incoming `qsd` (quote symbol data):** `{"m":"qsd","p":["<qsSessionId>",{"n":"NASDAQ:AAPL","s":"ok","v":{"lp":290.55,"ch":-10.99,"chp":-3.64,"volume":69202003,"short_name":"AAPL","description":"Apple Inc."}}]}`. The `v` object is a **partial delta** — only changed fields are present on later updates; merge into a per-symbol cache.
- **Incoming `quote_completed`:** `{"m":"quote_completed","p":["<qsSessionId>","NASDAQ:AAPL"]}` — first snapshot done.
- **Useful field set** (full list the official client requests): `base-currency-logoid, logo, ch, chp, currency-logoid, currency_code, currency_id, base_currency_id, current_session, description, exchange, format, fractional, is_tradable, language, local_description, listed_exchange, logoid, lp, lp_time, minmov, minmove2, original_name, pricescale, pro_name, short_name, type, typespecs, update_mode, volume, variable_tick_size, value_unit_id, unit_id, measure`.

**Verified:** a guest session against `data.tradingview.com` with fields `lp,ch,chp,volume,short_name,description` returns a valid `qsd` for `NASDAQ:AAPL` within ~1s.

### JWT auth token (only needed for prodata / realtime)

The realtime JWT is embedded in the homepage HTML for a logged-in session:
- `GET https://www.tradingview.com/` with the session cookie → regex `"auth_token":"([^"]+)"` → JWT.
- Decoded payload contains `user_id, exp, plan, max_active_alerts, ...`. It expires (~4h `exp - iat`); re-fetch when expired.
- For the guest quotes feed the literal string `"unauthorized_user_token"` is used instead.

### Alerts — REST (`https://pricealerts.tradingview.com`)

All require the session cookie (`sessionid` + `sessionid_sign`) and `Origin: https://www.tradingview.com`.

- **List:** `GET /list_alerts?log_username=<user>&user_id=<id>` → `{"s":"ok","r":[<alert>...]}`.
- **Recent fires:** `POST /get_offline_fires?log_username=<user>` body `{"payload":{"limit":2000}}` → `{"s":"ok","r":[{"fires_count":N,"latest_fire":{<fire>}}]}`.
- **Create:** `POST /create_alert?log_username=<user>` body `{"payload":{<alert input>}}`.
- **Delete:** `POST /delete_alerts?log_username=<user>` body `{"payload":{"alert_ids":[<id>...]}}`.

**Alert object shape (from `list_alerts`):**
```jsonc
{
  "symbol": "={\"symbol\":\"OANDA:SPX500USD\",\"adjustment\":\"splits\",\"session\":\"regular\",\"currency-id\":\"USD\"}",
  "resolution": "1",
  "condition": { "type": "cross", "frequency": "on_first_fire", "series": [{"type":"barset"},{"type":"value","value":7385.6}], "cross_interval": true, "resolution": "1" },
  "expiration": "2026-07-09T19:57:37Z",
  "expiration_policy": { "time": "...", "policy": "fixed_date" },
  "email": false, "sms_over_email": false, "mobile_push": true, "popup": true,
  "message": "SPX500USD Crossing 7,385.6",
  "web_hook": null, "name": null,
  "alert_id": 4891901279, "type": "price", "active": true,
  "create_time": "2026-06-09T19:57:39Z", "last_fire_time": "2026-06-09T20:07:01Z",
  "last_error": null, "last_stop_reason": null,
  "presentation_data": { "main_series": { "type":"index","formatter":"price","pricescale":10,"logoid":"indices/s-and-p-500" } },
  "kinds": ["regular"]
}
```

### Alerts — live push feed

- **URL:** `wss://pushstream.tradingview.com/message-pipe-ws/private_feed`
- **Auth:** session cookie on the WS handshake. **No subscribe message** — it is pure server-push for the authenticated user. (`Origin: https://www.tradingview.com` required.)
- **Frame shape (one JSON object per WS message, NOT `~m~` framed):**
```jsonc
{ "id": 7,
  "text": {
    "content": { "...": "...", "m": "alert_fired", "_rts": 1781036145702 },
    "channel": "pricealerts"
  } }
```
- **Event types (`text.content.m`):**
  - `alert_fired` — `content.p = { fire_id, alert_id, symbol, pro_symbol, message, fire_time, bar_time, resolution, sound_file, sound_duration, popup, cross_interval, name, kinds }`.
  - `alerts_created` — `content.p = [<full alert object>]`.
  - `alerts_updated` — `content.p = [<full alert object>]` (also fires on stop/auto-deactivate; watch `last_stop_reason`).
- There is also a `public` channel socket (`/message-pipe-ws/public`) — not needed for v1.

**Verified end-to-end:** creating an alert via `create_alert` produced `alerts_created`, then `alerts_updated` (active=true), then `alert_fired` with a `fire_id`, all on the `private_feed` socket within seconds; `delete_alerts` cleaned it up.

### Symbol spec encoding

A "pro symbol" is the string `"="` followed by a JSON object: `={"symbol":"NASDAQ:MSTR","adjustment":"splits","session":"regular","currency-id":"USD"}`. For the quotes feed a bare `EXCHANGE:TICKER` string also works. A small helper should accept a bare ticker and optionally wrap it.

---

## File Structure

- `src/tradingview/index.ts` — commander entry; registers `quotes` + `alerts` subcommands; ends with `await runTool(program, { tool: "tradingview" })`.
- `src/tradingview/lib/types.ts` — all shared interfaces (`QuoteValue`, `QuoteUpdate`, `Alert`, `AlertFire`, `AlertEvent`, `TvSession`).
- `src/tradingview/lib/protocol.ts` — pure framing: `encodeFrame`, `parseFrames`, `isHeartbeat`, `heartbeatEcho`, `genSessionId`. Fully unit-tested, no I/O.
- `src/tradingview/lib/symbols.ts` — `toProSymbol(ticker, opts?)`, `parseProSymbol(spec)`. Unit-tested.
- `src/tradingview/lib/auth.ts` — `resolveSession(opts)`: reads cookie from flag/env/config; `fetchAuthToken(cookie)`: regex JWT from homepage; `decodeJwt(jwt)`.
- `src/tradingview/lib/quote-client.ts` — `QuoteClient` (EventEmitter): connects, handshake, heartbeat echo, `addSymbols`, emits `quote` (merged per-symbol snapshot) and `error`/`close`.
- `src/tradingview/lib/alerts-rest.ts` — `listAlerts`, `getRecentFires`, `createAlert`, `deleteAlerts` against the REST API.
- `src/tradingview/lib/alerts-feed.ts` — `AlertsFeed` (EventEmitter): connects to `private_feed`, decodes events, emits `fired` / `created` / `updated`.
- `src/tradingview/lib/format.ts` — terminal formatters: `formatQuoteLine`, `formatQuoteTable`, `formatAlertRow`, `formatAlertFire`. Pure string functions, unit-tested.
- `src/tradingview/commands/quotes.ts` — controller for `tools tradingview quotes <symbols...>`.
- `src/tradingview/commands/alerts.ts` — controller for `tools tradingview alerts`.
- `src/tradingview/lib/protocol.test.ts`, `symbols.test.ts`, `format.test.ts` — colocated unit tests.
- `src/tradingview/README.md` — usage doc surfaced by `tools tradingview --readme`.

**Config:** `~/.genesis-tools/tradingview/config.json` via `Storage("tradingview")`, shape `{ session?: { username, userId, cookie } }`. Env overrides: `TRADINGVIEW_COOKIE` (full cookie string) OR `TRADINGVIEW_SESSIONID` + `TRADINGVIEW_SESSIONID_SIGN` + `TRADINGVIEW_USERNAME` + `TRADINGVIEW_USER_ID`.

---

## Task 1: Protocol framing primitives

**Files:**
- Create: `src/tradingview/lib/protocol.ts`
- Test: `src/tradingview/lib/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tradingview/lib/protocol.test.ts
import { describe, expect, it } from "bun:test";
import { encodeFrame, parseFrames, isHeartbeat, heartbeatEcho, genSessionId } from "./protocol";

describe("protocol framing", () => {
    it("encodes an object as ~m~<len>~m~<json>", () => {
        expect(encodeFrame({ m: "x", p: [1] })).toBe('~m~16~m~{"m":"x","p":[1]}');
    });

    it("encodes a raw string payload", () => {
        expect(encodeFrame("~h~2")).toBe("~m~4~m~~h~2");
    });

    it("splits a concatenated multi-frame message", () => {
        const msg = '~m~4~m~~h~2~m~13~m~{"m":"hi"}';
        expect(parseFrames(msg)).toEqual(["~h~2", '{"m":"hi"}']);
    });

    it("detects heartbeat tokens", () => {
        expect(isHeartbeat("~h~7")).toBe(true);
        expect(isHeartbeat('{"m":"qsd"}')).toBe(false);
    });

    it("builds a re-wrapped heartbeat echo", () => {
        expect(heartbeatEcho("~h~2")).toBe("~m~4~m~~h~2");
    });

    it("generates a 12-char-ish session id with prefix", () => {
        const id = genSessionId("qs_");
        expect(id.startsWith("qs_")).toBe(true);
        expect(id.length).toBeGreaterThan(8);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tradingview/lib/protocol.test.ts`
Expected: FAIL — `Cannot find module "./protocol"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tradingview/lib/protocol.ts
const FRAME_RE = /~m~(\d+)~m~/g;

export function encodeFrame(payload: object | string): string {
    const s = typeof payload === "string" ? payload : JSON.stringify(payload);
    return `~m~${s.length}~m~${s}`;
}

export function parseFrames(message: string): string[] {
    const frames: string[] = [];
    FRAME_RE.lastIndex = 0;
    let match = FRAME_RE.exec(message);
    while (match !== null) {
        const len = Number(match[1]);
        const start = FRAME_RE.lastIndex;
        frames.push(message.slice(start, start + len));
        FRAME_RE.lastIndex = start + len;
        match = FRAME_RE.exec(message);
    }
    return frames;
}

export function isHeartbeat(frame: string): boolean {
    return frame.startsWith("~h~");
}

export function heartbeatEcho(frame: string): string {
    return encodeFrame(frame);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function genSessionId(prefix: string): string {
    let out = "";
    for (let i = 0; i < 12; i++) {
        out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return prefix + out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tradingview/lib/protocol.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/protocol.ts src/tradingview/lib/protocol.test.ts
git commit -m "feat(tradingview): socket.io-style frame protocol primitives"
```

---

## Task 2: Symbol spec encoding

**Files:**
- Create: `src/tradingview/lib/symbols.ts`
- Test: `src/tradingview/lib/symbols.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tradingview/lib/symbols.test.ts
import { describe, expect, it } from "bun:test";
import { toProSymbol, parseProSymbol, normalizeTicker } from "./symbols";

describe("symbols", () => {
    it("wraps a bare ticker into a pro symbol spec", () => {
        expect(toProSymbol("NASDAQ:MSTR")).toBe(
            '=' + JSON.stringify({ symbol: "NASDAQ:MSTR", adjustment: "splits" })
        );
    });

    it("includes session when provided", () => {
        expect(toProSymbol("OANDA:SPX500USD", { session: "regular" })).toBe(
            '=' + JSON.stringify({ symbol: "OANDA:SPX500USD", adjustment: "splits", session: "regular" })
        );
    });

    it("parses a pro symbol spec back to its ticker", () => {
        const spec = '={"symbol":"NASDAQ:MSTR","adjustment":"splits"}';
        expect(parseProSymbol(spec)).toBe("NASDAQ:MSTR");
    });

    it("returns the bare ticker unchanged when not a spec", () => {
        expect(parseProSymbol("NASDAQ:MSTR")).toBe("NASDAQ:MSTR");
    });

    it("uppercases and trims a ticker", () => {
        expect(normalizeTicker("  nasdaq:aapl ")).toBe("NASDAQ:AAPL");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tradingview/lib/symbols.test.ts`
Expected: FAIL — `Cannot find module "./symbols"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tradingview/lib/symbols.ts
import { SafeJSON } from "@app/utils/json";

interface ProSymbolOpts {
    adjustment?: string;
    session?: string;
    currencyId?: string;
}

export function normalizeTicker(ticker: string): string {
    return ticker.trim().toUpperCase();
}

export function toProSymbol(ticker: string, opts: ProSymbolOpts = {}): string {
    const spec: Record<string, string> = {
        symbol: normalizeTicker(ticker),
        adjustment: opts.adjustment ?? "splits",
    };
    if (opts.session) {
        spec.session = opts.session;
    }
    if (opts.currencyId) {
        spec["currency-id"] = opts.currencyId;
    }
    return "=" + SafeJSON.stringify(spec);
}

export function parseProSymbol(spec: string): string {
    if (!spec.startsWith("=")) {
        return spec;
    }
    try {
        const obj = SafeJSON.parse<{ symbol: string }>(spec.slice(1));
        return obj.symbol;
    } catch {
        return spec;
    }
}
```

Note: `toProSymbol("NASDAQ:MSTR")` must serialize keys in the order `{symbol, adjustment}` to match the test. `SafeJSON.stringify` preserves insertion order, so build the object with `symbol` first.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tradingview/lib/symbols.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/symbols.ts src/tradingview/lib/symbols.test.ts
git commit -m "feat(tradingview): pro-symbol spec encode/decode helpers"
```

---

## Task 3: Shared types

**Files:**
- Create: `src/tradingview/lib/types.ts`

- [ ] **Step 1: Write the types** (no test — pure declarations)

```typescript
// src/tradingview/lib/types.ts
export interface QuoteValue {
    lp?: number;
    ch?: number;
    chp?: number;
    volume?: number;
    short_name?: string;
    description?: string;
    pro_name?: string;
    currency_code?: string;
    lp_time?: number;
    [field: string]: unknown;
}

export interface QuoteSnapshot {
    symbol: string;
    value: QuoteValue;
    updatedAt: number;
}

export interface TvSession {
    username: string;
    userId: number;
    cookie: string;
}

export interface AlertCondition {
    type: string;
    frequency: string;
    series: Array<{ type: string; value?: number }>;
    cross_interval?: boolean;
    resolution: string;
}

export interface Alert {
    alert_id: number;
    symbol: string;
    pro_symbol?: string;
    resolution: string;
    condition: AlertCondition;
    message: string;
    name: string | null;
    active: boolean;
    type: string;
    expiration: string | null;
    create_time: string;
    last_fire_time: string | null;
    last_error: string | null;
    last_stop_reason: string | null;
    web_hook: string | null;
    email: boolean;
    mobile_push: boolean;
    popup: boolean;
    kinds: string[];
}

export interface AlertFire {
    fire_id: number;
    alert_id: number;
    symbol: string;
    pro_symbol?: string;
    message: string;
    fire_time: string;
    bar_time: string;
    resolution: string;
    name: string | null;
    kinds: string[];
}

export type AlertEvent =
    | { kind: "fired"; fire: AlertFire }
    | { kind: "created"; alerts: Alert[] }
    | { kind: "updated"; alerts: Alert[] };
```

- [ ] **Step 2: Typecheck**

Run: `tsgo --noEmit | rg "src/tradingview/lib/types"`
Expected: no output (no errors for this file).

- [ ] **Step 3: Commit**

```bash
git add src/tradingview/lib/types.ts
git commit -m "feat(tradingview): shared protocol/domain types"
```

---

## Task 4: Terminal formatters

**Files:**
- Create: `src/tradingview/lib/format.ts`
- Test: `src/tradingview/lib/format.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tradingview/lib/format.test.ts
import { describe, expect, it } from "bun:test";
import { formatQuoteLine, formatAlertRow, formatAlertFire } from "./format";
import type { Alert, AlertFire, QuoteSnapshot } from "./types";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("format", () => {
    it("renders a quote line with symbol, price, and signed change", () => {
        const snap: QuoteSnapshot = {
            symbol: "NASDAQ:AAPL",
            value: { lp: 290.55, ch: -10.99, chp: -3.64, short_name: "AAPL" },
            updatedAt: 0,
        };
        const line = stripAnsi(formatQuoteLine(snap));
        expect(line).toContain("AAPL");
        expect(line).toContain("290.55");
        expect(line).toContain("-10.99");
        expect(line).toContain("-3.64%");
    });

    it("renders a quote line without crashing on missing fields", () => {
        const snap: QuoteSnapshot = { symbol: "X:Y", value: {}, updatedAt: 0 };
        expect(() => formatQuoteLine(snap)).not.toThrow();
    });

    it("renders an alert row with id, symbol, condition and active state", () => {
        const alert = {
            alert_id: 123,
            symbol: '={"symbol":"OANDA:SPX500USD"}',
            resolution: "1",
            condition: { type: "cross", frequency: "on_first_fire", series: [{ type: "barset" }, { type: "value", value: 7385.6 }], resolution: "1" },
            message: "SPX Crossing 7385.6",
            name: null,
            active: true,
        } as Alert;
        const row = stripAnsi(formatAlertRow(alert));
        expect(row).toContain("123");
        expect(row).toContain("OANDA:SPX500USD");
        expect(row).toContain("7385.6");
    });

    it("renders a fired alert banner with symbol and message", () => {
        const fire: AlertFire = {
            fire_id: 9, alert_id: 1, symbol: "OANDA:SPX500USD",
            message: "SPX Crossing 7385.6", fire_time: "2026-06-09T20:15:45Z",
            bar_time: "2026-06-09T20:15:00Z", resolution: "1", name: null, kinds: ["regular"],
        };
        const banner = stripAnsi(formatAlertFire(fire));
        expect(banner).toContain("OANDA:SPX500USD");
        expect(banner).toContain("SPX Crossing 7385.6");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tradingview/lib/format.test.ts`
Expected: FAIL — `Cannot find module "./format"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tradingview/lib/format.ts
import pc from "picocolors";
import { parseProSymbol } from "./symbols";
import type { Alert, AlertFire, QuoteSnapshot } from "./types";

function fmtNum(n: number | undefined, digits = 2): string {
    if (n === undefined || Number.isNaN(n)) {
        return "—";
    }
    return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signColor(n: number | undefined): (s: string) => string {
    if (n === undefined || n === 0) {
        return pc.dim;
    }
    return n > 0 ? pc.green : pc.red;
}

export function formatQuoteLine(snap: QuoteSnapshot): string {
    const v = snap.value;
    const label = v.short_name ?? parseProSymbol(snap.symbol);
    const price = fmtNum(typeof v.lp === "number" ? v.lp : undefined);
    const color = signColor(typeof v.ch === "number" ? v.ch : undefined);
    const ch = typeof v.ch === "number" ? `${v.ch > 0 ? "+" : ""}${fmtNum(v.ch)}` : "—";
    const chp = typeof v.chp === "number" ? `${v.chp > 0 ? "+" : ""}${fmtNum(v.chp)}%` : "—";
    const vol = typeof v.volume === "number" ? pc.dim(`vol ${fmtNum(v.volume, 0)}`) : "";
    return `${pc.bold(label.padEnd(12))} ${price.padStart(12)}  ${color(`${ch.padStart(10)} ${chp.padStart(8)}`)}  ${vol}`;
}

function conditionText(alert: Alert): string {
    const target = alert.condition?.series?.find((s) => s.type === "value")?.value;
    const type = alert.condition?.type ?? "?";
    return target === undefined ? type : `${type} ${fmtNum(target)}`;
}

export function formatAlertRow(alert: Alert): string {
    const sym = parseProSymbol(alert.symbol);
    const state = alert.active ? pc.green("●") : pc.dim("○");
    const id = pc.dim(String(alert.alert_id).padStart(12));
    return `${state} ${id}  ${pc.bold(sym.padEnd(20))} ${pc.cyan(conditionText(alert).padEnd(18))} ${pc.dim(alert.message)}`;
}

export function formatAlertFire(fire: AlertFire): string {
    const sym = parseProSymbol(fire.symbol);
    const time = new Date(fire.fire_time).toLocaleTimeString("en-US", { hour12: false });
    const head = pc.bgYellow(pc.black(" ALERT "));
    return `${head} ${pc.dim(time)}  ${pc.bold(pc.yellow(sym))}  ${fire.message}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tradingview/lib/format.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tradingview/lib/format.ts src/tradingview/lib/format.test.ts
git commit -m "feat(tradingview): terminal formatters for quotes and alerts"
```

---

## Task 5: Session/auth resolution

**Files:**
- Create: `src/tradingview/lib/auth.ts`

- [ ] **Step 1: Write the implementation** (network/env-dependent; covered by manual verification in Task 9, not unit-tested)

```typescript
// src/tradingview/lib/auth.ts
import { logger } from "@app/logger";
import { Storage } from "@app/utils/storage";
import type { TvSession } from "./types";

const TV_ORIGIN = "https://www.tradingview.com";

interface SessionOpts {
    cookie?: string;
    username?: string;
    userId?: number;
}

function cookieFromParts(): string | undefined {
    const sid = process.env.TRADINGVIEW_SESSIONID;
    const sign = process.env.TRADINGVIEW_SESSIONID_SIGN;
    if (sid && sign) {
        return `sessionid=${sid}; sessionid_sign=${sign}`;
    }
    return undefined;
}

export async function resolveSession(opts: SessionOpts = {}): Promise<TvSession | null> {
    const cookie = opts.cookie ?? process.env.TRADINGVIEW_COOKIE ?? cookieFromParts();
    if (cookie) {
        const username = opts.username ?? process.env.TRADINGVIEW_USERNAME ?? "";
        const userId = opts.userId ?? Number(process.env.TRADINGVIEW_USER_ID ?? 0);
        const session: TvSession = { username, userId, cookie };
        if (!username || !userId) {
            const enriched = await enrichFromHomepage(session);
            if (enriched) {
                return enriched;
            }
        }
        return session;
    }

    const storage = new Storage("tradingview");
    const stored = await storage.getConfigValue<TvSession>("session");
    if (stored?.cookie) {
        return stored;
    }
    logger.debug("tradingview: no session cookie found in flags, env, or config");
    return null;
}

export async function saveSession(session: TvSession): Promise<void> {
    const storage = new Storage("tradingview");
    await storage.setConfigValue("session", session);
}

async function enrichFromHomepage(session: TvSession): Promise<TvSession | null> {
    try {
        const res = await fetch(TV_ORIGIN + "/", {
            headers: { cookie: session.cookie, origin: TV_ORIGIN },
        });
        const html = await res.text();
        const uname = html.match(/"username":"([^"]+)"/);
        const uid = html.match(/"id":(\d+),"username"/) ?? html.match(/"user_id":(\d+)/);
        return {
            ...session,
            username: session.username || (uname ? uname[1] : ""),
            userId: session.userId || (uid ? Number(uid[1]) : 0),
        };
    } catch (err) {
        logger.debug({ err }, "tradingview: failed to enrich session from homepage");
        return null;
    }
}

export async function fetchAuthToken(cookie: string): Promise<string> {
    const res = await fetch(TV_ORIGIN + "/", {
        headers: { cookie, origin: TV_ORIGIN },
    });
    const html = await res.text();
    const m = html.match(/"auth_token":"([^"]+)"/);
    if (!m) {
        logger.debug("tradingview: auth_token not found in homepage, falling back to guest");
        return "unauthorized_user_token";
    }
    return m[1];
}
```

- [ ] **Step 2: Typecheck**

Run: `tsgo --noEmit | rg "src/tradingview/lib/auth"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/tradingview/lib/auth.ts
git commit -m "feat(tradingview): session cookie + auth-token resolution"
```

---

## Task 6: Quote WebSocket client

**Files:**
- Create: `src/tradingview/lib/quote-client.ts`

- [ ] **Step 1: Write the implementation** (live-WS; verified manually in Task 9)

```typescript
// src/tradingview/lib/quote-client.ts
import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import WebSocket from "ws";
import { encodeFrame, genSessionId, isHeartbeat, parseFrames } from "./protocol";
import type { QuoteSnapshot, QuoteValue } from "./types";

const DEFAULT_FIELDS = [
    "lp", "ch", "chp", "volume", "short_name", "description",
    "pro_name", "currency_code", "lp_time", "exchange", "type",
];

interface QuoteClientOpts {
    authToken?: string;
    host?: string;
    fields?: string[];
}

export interface QuoteClient {
    on(event: "quote", listener: (snap: QuoteSnapshot) => void): this;
    on(event: "open", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
}

export class QuoteClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private readonly sessionId = genSessionId("qs_");
    private readonly cache = new Map<string, QuoteValue>();
    private readonly fields: string[];
    private readonly authToken: string;
    private readonly host: string;
    private pending: string[] = [];

    constructor(opts: QuoteClientOpts = {}) {
        super();
        this.authToken = opts.authToken ?? "unauthorized_user_token";
        this.host = opts.host ?? "data.tradingview.com";
        this.fields = opts.fields ?? DEFAULT_FIELDS;
    }

    connect(): void {
        const url = `wss://${this.host}/socket.io/websocket?type=chart`;
        logger.debug({ url, host: this.host }, "tradingview: opening quote socket");
        this.ws = new WebSocket(url, { origin: "https://www.tradingview.com" });
        this.ws.on("open", () => this.onOpen());
        this.ws.on("message", (data: WebSocket.RawData) => this.onMessage(String(data)));
        this.ws.on("error", (err) => this.emit("error", err));
        this.ws.on("close", () => this.emit("close"));
    }

    addSymbols(symbols: string[]): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.pending.push(...symbols);
            return;
        }
        for (const sym of symbols) {
            this.send({ m: "quote_add_symbols", p: [this.sessionId, sym] });
        }
    }

    close(): void {
        this.ws?.close();
    }

    private onOpen(): void {
        this.send({ m: "set_auth_token", p: [this.authToken] });
        this.send({ m: "quote_create_session", p: [this.sessionId] });
        this.send({ m: "quote_set_fields", p: [this.sessionId, ...this.fields] });
        this.emit("open");
        if (this.pending.length > 0) {
            const queued = this.pending;
            this.pending = [];
            this.addSymbols(queued);
        }
    }

    private onMessage(raw: string): void {
        for (const frame of parseFrames(raw)) {
            if (isHeartbeat(frame)) {
                this.ws?.send(encodeFrame(frame));
                continue;
            }
            this.handleJson(frame);
        }
    }

    private handleJson(frame: string): void {
        let msg: { m?: string; p?: unknown[] };
        try {
            msg = SafeJSON.parse(frame);
        } catch {
            return;
        }
        if (msg.m !== "qsd" || !Array.isArray(msg.p)) {
            return;
        }
        const payload = msg.p[1] as { n?: string; s?: string; v?: QuoteValue } | undefined;
        if (!payload?.n || payload.s !== "ok" || !payload.v) {
            return;
        }
        const merged = { ...(this.cache.get(payload.n) ?? {}), ...payload.v };
        this.cache.set(payload.n, merged);
        this.emit("quote", { symbol: payload.n, value: merged, updatedAt: Date.now() } satisfies QuoteSnapshot);
    }

    private send(obj: object): void {
        this.ws?.send(encodeFrame(obj));
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `tsgo --noEmit | rg "src/tradingview/lib/quote-client"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/tradingview/lib/quote-client.ts
git commit -m "feat(tradingview): streaming quote websocket client"
```

---

## Task 7: Alerts REST + live feed

**Files:**
- Create: `src/tradingview/lib/alerts-rest.ts`
- Create: `src/tradingview/lib/alerts-feed.ts`

- [ ] **Step 1: Write the REST client**

```typescript
// src/tradingview/lib/alerts-rest.ts
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Alert, TvSession } from "./types";

const BASE = "https://pricealerts.tradingview.com";
const TV_ORIGIN = "https://www.tradingview.com";

interface ApiEnvelope<T> {
    s: string;
    r: T;
}

function headers(session: TvSession): Record<string, string> {
    return { cookie: session.cookie, origin: TV_ORIGIN, "content-type": "text/plain;charset=UTF-8" };
}

export async function listAlerts(session: TvSession): Promise<Alert[]> {
    const url = `${BASE}/list_alerts?log_username=${encodeURIComponent(session.username)}&user_id=${session.userId}`;
    const res = await fetch(url, { headers: headers(session) });
    const body = (await res.json()) as ApiEnvelope<Alert[]>;
    if (body.s !== "ok") {
        logger.warn({ status: body.s }, "tradingview: list_alerts non-ok");
        return [];
    }
    return body.r;
}

export interface RecentFire {
    fires_count: number;
    latest_fire: {
        fire_id: number;
        alert_id: number;
        symbol: string;
        message: string;
        fire_time: string;
        bar_time: string;
        resolution: string;
        name: string | null;
        kinds: string[];
    };
}

export async function getRecentFires(session: TvSession, limit = 2000): Promise<RecentFire[]> {
    const url = `${BASE}/get_offline_fires?log_username=${encodeURIComponent(session.username)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: headers(session),
        body: SafeJSON.stringify({ payload: { limit } }),
    });
    const body = (await res.json()) as ApiEnvelope<RecentFire[]>;
    return body.s === "ok" ? body.r : [];
}

export async function deleteAlerts(session: TvSession, alertIds: number[]): Promise<boolean> {
    const url = `${BASE}/delete_alerts?log_username=${encodeURIComponent(session.username)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: headers(session),
        body: SafeJSON.stringify({ payload: { alert_ids: alertIds } }),
    });
    const body = (await res.json()) as ApiEnvelope<unknown>;
    return body.s === "ok";
}
```

- [ ] **Step 2: Write the live feed client**

```typescript
// src/tradingview/lib/alerts-feed.ts
import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import WebSocket from "ws";
import type { Alert, AlertFire, TvSession } from "./types";

const FEED_URL = "wss://pushstream.tradingview.com/message-pipe-ws/private_feed";

export interface AlertsFeed {
    on(event: "fired", listener: (fire: AlertFire) => void): this;
    on(event: "created", listener: (alerts: Alert[]) => void): this;
    on(event: "updated", listener: (alerts: Alert[]) => void): this;
    on(event: "open", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
}

interface PushFrame {
    id: number;
    text?: { content?: { m?: string; p?: unknown }; channel?: string };
}

export class AlertsFeed extends EventEmitter {
    private ws: WebSocket | null = null;

    constructor(private readonly session: TvSession) {
        super();
    }

    connect(): void {
        logger.debug("tradingview: opening alerts private_feed");
        this.ws = new WebSocket(FEED_URL, {
            origin: "https://www.tradingview.com",
            headers: { cookie: this.session.cookie },
        });
        this.ws.on("open", () => this.emit("open"));
        this.ws.on("message", (data: WebSocket.RawData) => this.onMessage(String(data)));
        this.ws.on("error", (err) => this.emit("error", err));
        this.ws.on("close", () => this.emit("close"));
    }

    close(): void {
        this.ws?.close();
    }

    private onMessage(raw: string): void {
        let frame: PushFrame;
        try {
            frame = SafeJSON.parse(raw);
        } catch {
            return;
        }
        const content = frame.text?.content;
        if (frame.text?.channel !== "pricealerts" || !content?.m) {
            return;
        }
        switch (content.m) {
            case "alert_fired":
                this.emit("fired", content.p as AlertFire);
                break;
            case "alerts_created":
                this.emit("created", content.p as Alert[]);
                break;
            case "alerts_updated":
                this.emit("updated", content.p as Alert[]);
                break;
            default:
                logger.debug({ m: content.m }, "tradingview: unhandled alerts event");
        }
    }
}
```

- [ ] **Step 3: Typecheck**

Run: `tsgo --noEmit | rg "src/tradingview/lib/alerts"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/tradingview/lib/alerts-rest.ts src/tradingview/lib/alerts-feed.ts
git commit -m "feat(tradingview): alerts REST client and live push feed"
```

---

## Task 8: Commands + entry point

**Files:**
- Create: `src/tradingview/commands/quotes.ts`
- Create: `src/tradingview/commands/alerts.ts`
- Create: `src/tradingview/index.ts`

- [ ] **Step 1: Write the quotes command**

```typescript
// src/tradingview/commands/quotes.ts
import { logger, out } from "@app/logger";
import pc from "picocolors";
import { fetchAuthToken, resolveSession } from "../lib/auth";
import { formatQuoteLine } from "../lib/format";
import { QuoteClient } from "../lib/quote-client";
import { normalizeTicker } from "../lib/symbols";

interface QuotesOpts {
    auth?: boolean;
    cookie?: string;
}

export async function runQuotes(symbols: string[], opts: QuotesOpts): Promise<void> {
    if (symbols.length === 0) {
        out.error("Provide at least one symbol, e.g. NASDAQ:AAPL");
        process.exit(1);
    }

    const tickers = symbols.map(normalizeTicker);
    let authToken = "unauthorized_user_token";
    let host = "data.tradingview.com";

    if (opts.auth) {
        const session = await resolveSession({ cookie: opts.cookie });
        if (session) {
            authToken = await fetchAuthToken(session.cookie);
            host = "prodata.tradingview.com";
        } else {
            out.warn("No session found; falling back to guest data.");
        }
    }

    out.printErr(pc.dim(`Streaming ${tickers.length} symbol(s) from ${host} — Ctrl-C to stop\n`));
    const client = new QuoteClient({ authToken, host });

    client.on("open", () => client.addSymbols(tickers));
    client.on("quote", (snap) => out.printlnErr(formatQuoteLine(snap)));
    client.on("error", (err) => logger.error({ err }, "tradingview: quote socket error"));
    client.on("close", () => out.printErr(pc.dim("\nConnection closed.")));

    process.on("SIGINT", () => {
        client.close();
        process.exit(0);
    });

    client.connect();
    await new Promise(() => {});
}
```

- [ ] **Step 2: Write the alerts command**

```typescript
// src/tradingview/commands/alerts.ts
import { logger, out } from "@app/logger";
import pc from "picocolors";
import { resolveSession } from "../lib/auth";
import { AlertsFeed } from "../lib/alerts-feed";
import { listAlerts } from "../lib/alerts-rest";
import { formatAlertFire, formatAlertRow } from "../lib/format";
import { parseProSymbol } from "../lib/symbols";

interface AlertsOpts {
    cookie?: string;
    listOnly?: boolean;
}

export async function runAlerts(opts: AlertsOpts): Promise<void> {
    const session = await resolveSession({ cookie: opts.cookie });
    if (!session) {
        out.error(
            "No TradingView session found. Set TRADINGVIEW_COOKIE (or TRADINGVIEW_SESSIONID + " +
                "TRADINGVIEW_SESSIONID_SIGN + TRADINGVIEW_USERNAME + TRADINGVIEW_USER_ID), or run `tools tradingview login`."
        );
        process.exit(1);
    }

    const alerts = await listAlerts(session);
    out.printlnErr(pc.bold(`\n${alerts.length} alert(s):\n`));
    for (const alert of alerts) {
        out.printlnErr(formatAlertRow(alert));
    }

    if (opts.listOnly) {
        return;
    }

    out.printErr(pc.dim("\nListening for live alert fires — Ctrl-C to stop\n"));
    const feed = new AlertsFeed(session);
    feed.on("fired", (fire) => out.printlnErr(formatAlertFire(fire)));
    feed.on("created", (created) =>
        created.forEach((a) => out.printlnErr(pc.green(`+ created ${parseProSymbol(a.symbol)} — ${a.message}`)))
    );
    feed.on("updated", (updated) =>
        updated.forEach((a) => {
            const reason = a.last_stop_reason ? pc.dim(` (${a.last_stop_reason})`) : "";
            out.printlnErr(pc.cyan(`~ updated ${parseProSymbol(a.symbol)} — ${a.active ? "active" : "inactive"}${reason}`));
        })
    );
    feed.on("error", (err) => logger.error({ err }, "tradingview: alerts feed error"));
    feed.on("close", () => out.printErr(pc.dim("\nFeed closed.")));

    process.on("SIGINT", () => {
        feed.close();
        process.exit(0);
    });

    feed.connect();
    await new Promise(() => {});
}
```

- [ ] **Step 3: Write the entry point**

```typescript
// src/tradingview/index.ts
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { runAlerts } from "./commands/alerts";
import { runQuotes } from "./commands/quotes";

const program = new Command();

program
    .name("tradingview")
    .description("Stream TradingView live quotes and price-alert feeds");

program
    .command("quotes")
    .description("Stream a live quote feed for one or more symbols")
    .argument("<symbols...>", "Symbols like NASDAQ:AAPL OANDA:SPX500USD")
    .option("--auth", "Use the logged-in session (prodata host) instead of guest data")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .action((symbols: string[], opts: { auth?: boolean; cookie?: string }) => runQuotes(symbols, opts));

program
    .command("alerts")
    .description("List price alerts and stream live alert fires")
    .option("--cookie <cookie>", "TradingView session cookie string")
    .option("--list-only", "Print current alerts and exit (no live feed)")
    .action((opts: { cookie?: string; listOnly?: boolean }) => runAlerts(opts));

await runTool(program, { tool: "tradingview" });
```

- [ ] **Step 4: Typecheck the whole tool**

Run: `tsgo --noEmit | rg "src/tradingview/"`
Expected: no output.

- [ ] **Step 5: Smoke-test help + guest quotes**

Run: `bun run src/tradingview/index.ts --help`
Expected: shows `quotes` and `alerts` subcommands.

Run: `timeout 12 bun run src/tradingview/index.ts quotes NASDAQ:AAPL`
Expected: at least one formatted quote line for `AAPL` with a price, printed to the terminal, then exits on timeout.

- [ ] **Step 6: Commit**

```bash
git add src/tradingview/commands src/tradingview/index.ts
git commit -m "feat(tradingview): quotes and alerts commands + CLI entry"
```

---

## Task 9: Live verification + README

**Files:**
- Create: `src/tradingview/README.md`

- [ ] **Step 1: Verify guest quotes feed (no login)**

Run: `timeout 15 bun run src/tradingview/index.ts quotes NASDAQ:AAPL NASDAQ:MSTR OANDA:SPX500USD`
Expected: formatted lines for all three symbols update at least once. Green for positive change, red for negative.

- [ ] **Step 2: Verify alerts list + live feed (requires session)**

Provide a real cookie via env, then:

Run: `TRADINGVIEW_COOKIE="sessionid=...; sessionid_sign=..." TRADINGVIEW_USERNAME=<u> TRADINGVIEW_USER_ID=<id> timeout 20 bun run src/tradingview/index.ts alerts`
Expected: prints the current alert rows; then "Listening for live alert fires". (If a test alert is created/fires in the TradingView UI during this window, an `ALERT` banner appears.)

Run (list-only, fast): `... bun run src/tradingview/index.ts alerts --list-only`
Expected: prints alert rows and exits 0.

- [ ] **Step 3: Run the full unit suite for the tool**

Run: `bun test src/tradingview/`
Expected: PASS (protocol, symbols, format tests — 15 tests total).

- [ ] **Step 4: Write the README**

```markdown
# tradingview

Stream TradingView's live quote feed and price-alert feed to your terminal.

## Usage

    tools tradingview quotes NASDAQ:AAPL OANDA:SPX500USD
    tools tradingview alerts
    tools tradingview alerts --list-only

## Quotes

`quotes <symbols...>` opens TradingView's market-data WebSocket and prints a
live, color-coded line per symbol (price, absolute change, percent change,
volume). Works as **guest** with no login — guest data is realtime where the
exchange allows it, delayed otherwise.

Pass `--auth` to use your logged-in session (`prodata` host) for full realtime
data on your plan's entitlements.

## Alerts

`alerts` lists your existing price alerts, then subscribes to the live push
feed and prints a banner whenever an alert **fires**, plus create/update events.
Requires a logged-in session.

### Providing a session

Set one of:

- `TRADINGVIEW_COOKIE="sessionid=...; sessionid_sign=..."` plus
  `TRADINGVIEW_USERNAME` and `TRADINGVIEW_USER_ID`, or
- `TRADINGVIEW_SESSIONID` + `TRADINGVIEW_SESSIONID_SIGN` + `TRADINGVIEW_USERNAME` + `TRADINGVIEW_USER_ID`, or
- `--cookie "<cookie string>"` on the command.

Grab `sessionid` / `sessionid_sign` from your browser's TradingView cookies
(DevTools → Application → Cookies → tradingview.com).

## Protocol notes

See `.claude/plans/2026-06-09-TradingViewTool.md` for the full reverse-engineered
protocol reference (frame framing, heartbeat, quote session lifecycle, alert
REST endpoints, and the push-feed event shapes).
```

- [ ] **Step 5: Commit**

```bash
git add src/tradingview/README.md
git commit -m "docs(tradingview): usage README"
```

---

## Self-Review Notes

- **Spec coverage:** User asked for `src/tradingview/` with, as the first feature, "a feed of the websocket and alerts in a nicely formatted way." Task 6 + Task 8 (quotes command) deliver the live websocket feed; Task 7 + Task 8 (alerts command) deliver the alerts feed; Task 4 delivers the formatting. ✅
- **Type consistency:** `QuoteSnapshot`/`QuoteValue`/`Alert`/`AlertFire`/`TvSession` are defined once in `types.ts` (Task 3) and imported everywhere. `genSessionId`, `encodeFrame`, `parseFrames`, `isHeartbeat` names match between `protocol.ts` (Task 1) and `quote-client.ts` (Task 6). `parseProSymbol`/`normalizeTicker`/`toProSymbol` match between `symbols.ts` (Task 2) and `format.ts`/commands. `resolveSession`/`fetchAuthToken` match between `auth.ts` (Task 5) and the commands (Task 8).
- **No placeholders:** every code step is complete and runnable.
- **Known follow-ups (out of scope for v1, do NOT implement now):** `tools tradingview login` interactive cookie capture; `create`/`delete` alert subcommands (REST functions exist but no command); reconnect/backoff on socket close; `--json` machine output via `out.result`; the `public` pushstream channel.
```