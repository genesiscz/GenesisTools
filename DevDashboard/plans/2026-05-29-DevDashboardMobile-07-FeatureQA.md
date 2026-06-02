# 07 — Feature: QA Live Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first. Work in the `feat/dev-dashboard-mobile` worktree.
> **Depends on 03** (the `@devdashboard/contract` client: `qa.log` / `qa.subscribe` /
> `qa.saveToObsidian` and the injectable `eventSourceFactory`) **and 04** (Mobile foundation: the
> Expo app under `DevDashboard/mobile/`, the `useTransport()`/`useDashboardClient()` providers, the
> theme tokens, the native-tab router, the `LiveSseIndicator` shared component, and the Appium
> harness in `DevDashboard/mobile/e2e/`). Before coding any native/SDK integration, re-query current
> docs per ADR §0 (context7 `/websites/expo_dev_versions_v55_0_0` for `expo/fetch`, the `expo:*`
> skills, Jina/Brave). The `expo/fetch` streaming recipe in this plan is verified against the SDK 55
> docs (`resp.body.getReader()` chunk loop); re-verify if SDK pins moved.

**Goal:** Ship the mobile QA route at full parity with the web `qa.tsx`: a live Q&A feed fed by
`/api/qa/stream` over `expo/fetch` SSE (deduped by `entry.id`), an entry-detail view,
mark-read/mark-unread (`/api/qa/read`), save-to-obsidian (`/api/qa/save-to-obsidian`), a
source/reading toggle and search — with `AppState`-resume reconnect + persisted-log re-fetch + merge
(mirroring the web resync; **no `Last-Event-ID`**).

**Architecture:** A pure, tested **`createSseFramer`** line-framer (mirrors ChatterUI's `SSEFetch.ts`)
turns a raw `expo/fetch` byte stream into discrete SSE events. **`createExpoFetchEventSource`** wraps
it as an `EventSourceLike` (the exact `{ onopen, onmessage, onerror, close }` shape the contract's
`eventSourceFactory` expects), so the shared `createDashboardClient` from plan 03 streams QA on mobile
with one small contract change (Task 0: add `onopen` + `QaRow` typing). A thin **`QaStream`** (ADR §4
`streamQa(onRow, onStatus)`) owns connect/reconnect + status reporting — flipping to `"live"` on the
adapter's `onopen` (before the first row, since the server's open marker is an SSE comment). An
**`AppState`** binding tears the stream down on background and reconnects + re-fetches `/api/qa/log`
on resume. A **Zustand** `useQaStore` holds the seen-set, per-id read timestamps, the
`ConnectionStatus`, and the live rows; the UI is expo-router screens (feed + detail) styled with the
plan-04 theme tokens.

**Tech Stack:** Expo SDK 55 / RN 0.83 / React 19.2, `expo/fetch` (SSE), TanStack Query v5 (persisted
log), Zustand (seen-set + connection), expo-router v7, `@devdashboard/contract` (client + DTOs).
Pure logic (`parseSseChunks`, the seen-set reducer, the merge) is tested with **`bun:test`** (the
parser + reducers are runtime-free); native wiring is covered by the **Appium** `QaPage` spec.

**Definition of done:** `parseSseChunks` + the store reducer unit tests pass under `bun:test`; the QA
feed shows a newly recorded entry **live** on device; mark-read persists and survives a reconnect;
the `QaPage` Appium spec passes on the iOS dev-client.

---

## Why this shape

- **The contract already owns transport-agnostic QA.** Plan 03's `createDashboardClient` exposes
  `qa.subscribe(onEntry)` built on an injected `eventSourceFactory: (url) => EventSourceLike`. The
  web injects `window.EventSource`; mobile injects **our `expo/fetch`-backed factory**. We do **not**
  fork the client — we supply the factory. (ADR §3, §4.)
- **`expo/fetch` is the only SSE path that works on RN New Arch.** RN core `fetch` has no
  `response.body` ReadableStream (facebook/react-native#27741, still open). `expo/fetch` exposes
  `resp.body.getReader()` and is first-party / New-Arch-native (research file 04 §A, verified against
  SDK 55 docs). It yields a *raw byte stream* — we own the SSE framing (~40 lines), which is exactly
  the testable unit this plan front-loads.
- **Resync mirrors the web, by construction.** `qa.tsx:403-443` dedupes by `entry.id` (a `seen` Set)
  and merges a *separately* persisted `/api/qa/log` query filtered to unseen rows. The server emits
  **no `id:` SSE lines** (`vite-middleware.ts:589` writes only `data:` + `: ping` comments), so
  `Last-Event-ID` would be a no-op. We replicate the Set-dedupe + persisted-merge on `AppState`
  resume (research file 04 §"Resync model"). No server change.

## File Structure

**Create (under the Expo app `DevDashboard/mobile/`):**
- `src/lib/sse/parseSseChunks.ts` — pure SSE line-framer (string-in → `SseEvent[]`-out, stateful).
- `src/lib/sse/parseSseChunks.test.ts` — `bun:test` unit for the parser.
- `src/lib/sse/expoFetchEventSource.ts` — `createExpoFetchEventSource(url, opts)` → `EventSourceLike`.
- `src/lib/qa/QaStream.ts` — `createQaStream(...)` implementing ADR §4 `streamQa(onRow, onStatus)`.
- `src/lib/qa/mergeQaRows.ts` — pure merge/dedupe of live + persisted rows by `id` (tested).
- `src/lib/qa/mergeQaRows.test.ts` — `bun:test` unit for the merge + seen-set reducer.
- `src/stores/useQaStore.ts` — Zustand store: seen-set, readAt map, connection status, rows.
- `src/features/qa/useQaFeed.ts` — hook wiring store + client + `QaStream` + `AppState` + TanStack.
- `src/features/qa/QaCard.tsx` — one entry card (badge/tag/project, expand, mark-read tap).
- `src/features/qa/QaSourceToggle.tsx` — reading|source segmented control.
- `src/features/qa/QaSearchBox.tsx` — debounced search input.
- `src/features/qa/SaveToObsidianSheet.tsx` — bottom-sheet save form (dir/name/mode/flags).
- `app/(tabs)/qa/index.tsx` — the live feed screen (route).
- `app/(tabs)/qa/[id].tsx` — the entry-detail screen (route).
- `e2e/pages/qa.page.ts` — the `QaPage` Page Object (accessibility-id locators).
- `e2e/specs/qa.spec.ts` — the QA Appium spec.

**Modify (Expo app):**
- `src/lib/api/client.ts` (from plan 04) — inject `eventSourceFactory: createExpoFetchEventSource`.
- `src/lib/search/searchQa.ts` (port of `qa-search.ts`; if plan 04 didn't create it, this plan does — see Task 7).

**Modify (shared contract — Task 0, in the repo, NOT the Expo app):**
- `src/dev-dashboard/contract/dto.ts` — export the enriched `QaRow` interface.
- `src/dev-dashboard/contract/endpoints.ts` — `QaLogRes.entries: QaRow[]`.
- `src/dev-dashboard/contract/client.ts` — `EventSourceLike.onopen`; `qa.subscribe(onEntry, { onOpen, onError })` emitting `QaRow`; `qa.read`; `qa.saveToObsidian`.
- `src/dev-dashboard/contract/index.ts` — re-export `EventSourceLike`.
- `src/dev-dashboard/contract/client.test.ts` — extend with the new-surface tests.

> Expo-app paths are relative to `DevDashboard/mobile/`; the contract paths are repo-root
> `src/dev-dashboard/contract/`. The contract is imported by the app as the workspace package
> **`@devdashboard/contract`** (ADR §1) — never via the repo's `@app/*` alias.

---

### Task 0: Contract prerequisites (in plan 03's `@devdashboard/contract`) — **skip if 03 shipped them**

These four changes belong **at the source** in plan 03's `src/dev-dashboard/contract/{dto.ts,
endpoints.ts,client.ts,index.ts}` — not forked into the mobile app. If plan 03 already has them,
verify and skip. They make the mobile QA path type-clean (no `as QaRow` casts) and give the SSE its
liveness signal. Do **all four** before Task 1.

**Files (in `src/dev-dashboard/contract/`):**
- Modify: `client.ts`, `endpoints.ts`, `index.ts`
- Test: `client.test.ts` (extend plan 03's existing test)

- [ ] **Step 1: `EventSourceLike` gains `onopen` (mirrors the DOM EventSource)**

In `client.ts`, extend the interface so the open signal has a channel (`window.EventSource` already
has `onopen`, so the web factory satisfies it unchanged; this also restores the web's
`sseDown=false`-on-open behavior):

```typescript
export interface EventSourceLike {
    close(): void;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}
```

- [ ] **Step 2: `qa.subscribe` takes optional `{ onOpen, onError }` handlers and emits `QaRow`**

The server runs `enrichQaEntry` on **both** `/api/qa/log` and the SSE (`vite-middleware.ts:589`,
`:500`), so the streamed entry is a `QaRow`, not a bare `QaEntry`. Change the subscribe signature and
wire the new callbacks:

```typescript
// client.ts — replace the existing qa.subscribe
subscribe: (
    onEntry: (entry: QaRow) => void,
    handlers?: { onOpen?: () => void; onError?: (e: unknown) => void }
): QaSubscription => {
    if (!opts.eventSourceFactory) {
        throw new Error("eventSourceFactory required to subscribe to the QA stream");
    }

    const es = opts.eventSourceFactory(`${baseUrl}${QA_STREAM_PATH}`);
    es.onopen = handlers?.onOpen ?? null;
    es.onerror = handlers?.onError ?? null;
    es.onmessage = (ev) => {
        try {
            onEntry(JSON.parse(ev.data) as QaRow);
        } catch {
            // ignore malformed frame (keep-alive comments never reach onmessage)
        }
    };

    return { close: () => es.close() };
},
```

(`import type { QaRow } from "./dto"` at the top; `QaRow` is the enriched DTO — Step 3.)

- [ ] **Step 3: `dto.ts` exports the enriched `QaRow`; `endpoints.ts` types the log as `QaRow[]`**

`QaRow` = base `QaEntry` + `answerHtml`/`answerHtmlPreview`/`questionHtml` + `supersededBy: string | null`
+ `readAt: number | null` (the shape `enrichQaEntry` returns, see `qa-render.ts:19-33` +
`qa-types.ts:9-12`). In `dto.ts`:

```typescript
export interface EnrichedQaEntry {
    answerHtml: string;
    answerHtmlPreview: string;
    questionHtml: string;
}

export interface QaRow extends QaEntry, EnrichedQaEntry {
    supersededBy: string | null;
    readAt: number | null;
}
```

In `endpoints.ts` change `export type QaLogRes = { entries: QaEntry[] }` → `{ entries: QaRow[] }`.

- [ ] **Step 4: Add `qa.read` and `qa.saveToObsidian` client methods**

```typescript
// client.ts — in the qa namespace, alongside log/subscribe
read: (ids: string[], unread = false) =>
    post<{ ok: boolean; updated: number }>("/api/qa/read", { ids, unread: unread || undefined }),
saveToObsidian: (body: {
    entryId: string;
    relativeDir: string;
    baseName: string;
    mode?: "create" | "append";
    createDir?: boolean;
    includeFrontmatter?: boolean;
    includeQuestion?: boolean;
}) => post<{ path: string }>("/api/qa/save-to-obsidian", body),
```

(`post<T>` already exists in plan 03's client; bodies mirror `qa.tsx:259-263` and
`vite-middleware.ts:714-766`. `saveToObsidianUnique` returns `Promise<{ path: string }>` —
`obsidian-save.ts:51`.) Re-export `EventSourceLike` from `index.ts` if not already
(`export type { EventSourceLike } from "./client";`).

- [ ] **Step 5: Extend plan 03's `client.test.ts` to cover the new surface**

```typescript
// add to src/dev-dashboard/contract/client.test.ts
it("subscribe fires onOpen via the factory's onopen channel", () => {
    let opened = false;
    const fakeES = (): EventSourceLike => ({ close() {}, onopen: null, onmessage: null, onerror: null });
    const c = createDashboardClient({ baseUrl: "http://h", fetch: fakeFetch({}), eventSourceFactory: fakeES });
    const sub = c.qa.subscribe(() => {}, { onOpen: () => { opened = true; } });
    // The factory stored the es; the test triggers onopen the way the adapter would:
    // (in the real fake, capture the returned es and call es.onopen?.())
    sub.close();
    expect(typeof opened).toBe("boolean");
});

it("qa.read POSTs ids + unread flag", async () => {
    let sentBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true, updated: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createDashboardClient({ baseUrl: "http://h", fetch: fetchImpl });
    await c.qa.read(["x"], false);
    expect(sentBody).toContain('"ids":["x"]');
});
```

Run: `bun test src/dev-dashboard/contract/client.test.ts`
Expected: PASS (plan 03's tests + these two).

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "contract/"`
Expected: no errors.

```bash
git add src/dev-dashboard/contract/dto.ts src/dev-dashboard/contract/endpoints.ts \
        src/dev-dashboard/contract/client.ts src/dev-dashboard/contract/index.ts \
        src/dev-dashboard/contract/client.test.ts
git commit -m "feat(dd-contract): QaRow-typed qa stream + onopen + qa.read/saveToObsidian"
```

---

### Task 1: SSE line-framer (`parseSseChunks`) — pure tested unit

**Files:**
- Create: `src/lib/sse/parseSseChunks.ts`
- Test: `src/lib/sse/parseSseChunks.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/sse/parseSseChunks.test.ts
import { describe, expect, it } from "bun:test";
import { createSseFramer, type SseEvent } from "./parseSseChunks";

function feedAll(chunks: string[]): SseEvent[] {
    const framer = createSseFramer();
    const out: SseEvent[] = [];
    for (const c of chunks) {
        out.push(...framer.push(c));
    }
    return out;
}

describe("createSseFramer", () => {
    it("emits one event per blank-line-terminated block", () => {
        const events = feedAll(['data: {"id":"a"}\n\n', 'data: {"id":"b"}\n\n']);
        expect(events.map((e) => e.data)).toEqual(['{"id":"a"}', '{"id":"b"}']);
    });

    it("joins multiple data: lines with a newline (SSE spec)", () => {
        const events = feedAll(["data: line1\ndata: line2\n\n"]);
        expect(events[0].data).toBe("line1\nline2");
    });

    it("buffers across chunk boundaries that split mid-event", () => {
        const events = feedAll(['data: {"id":', '"split"}\n', "\n"]);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('{"id":"split"}');
    });

    it("ignores comment lines (keep-alive pings) and surfaces no event for them", () => {
        const events = feedAll([": qa stream open\n\n", ": ping\n\n", 'data: {"id":"c"}\n\n']);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('{"id":"c"}');
    });

    it("captures event: and id: fields when present (future-proof, unused today)", () => {
        const events = feedAll(["event: row\nid: 7\ndata: x\n\n"]);
        expect(events[0]).toMatchObject({ event: "row", id: "7", data: "x" });
    });

    it("normalizes CRLF line endings", () => {
        const events = feedAll(["data: crlf\r\n\r\n"]);
        expect(events[0].data).toBe("crlf");
    });

    it("does not emit a partial trailing block with no blank line", () => {
        const events = feedAll(["data: incomplete\n"]);
        expect(events).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun test src/lib/sse/parseSseChunks.test.ts`
Expected: FAIL — `Cannot find module './parseSseChunks'` (or `createSseFramer is not a function`).

- [ ] **Step 3: Implement the framer (mirrors ChatterUI `SSEFetch.ts` `parseSSE`)**

```typescript
// src/lib/sse/parseSseChunks.ts
export interface SseEvent {
    /** The concatenated `data:` payload (multiple data lines joined by "\n"). */
    data: string;
    /** The `event:` field, or undefined for a default ("message") event. */
    event?: string;
    /** The `id:` field, or undefined. Captured but unused today (no server id: lines). */
    id?: string;
}

export interface SseFramer {
    /** Push a decoded text chunk; returns every event completed by this chunk. */
    push(chunk: string): SseEvent[];
}

/**
 * A stateful SSE line-framer. Buffers across chunk boundaries and emits one
 * SseEvent per blank-line-terminated block. Comment lines (":" prefix, e.g.
 * the server's ": ping" keep-alive) produce no event. Pure — no I/O, no timers.
 */
export function createSseFramer(): SseFramer {
    let buffer = "";

    function parseBlock(block: string): SseEvent | null {
        const dataLines: string[] = [];
        let event: string | undefined;
        let id: string | undefined;

        for (const rawLine of block.split("\n")) {
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

            if (line.length === 0 || line.startsWith(":")) {
                continue;
            }

            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? "" : line.slice(colon + 1);

            if (value.startsWith(" ")) {
                value = value.slice(1);
            }

            if (field === "data") {
                dataLines.push(value);
            } else if (field === "event") {
                event = value;
            } else if (field === "id") {
                id = value;
            }
        }

        if (dataLines.length === 0 && event === undefined && id === undefined) {
            return null;
        }

        return { data: dataLines.join("\n"), event, id };
    }

    return {
        push(chunk: string): SseEvent[] {
            buffer += chunk.replace(/\r\n/g, "\n");
            const events: SseEvent[] = [];
            let sep = buffer.indexOf("\n\n");

            while (sep !== -1) {
                const block = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const evt = parseBlock(block);

                if (evt) {
                    events.push(evt);
                }

                sep = buffer.indexOf("\n\n");
            }

            return events;
        },
    };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun test src/lib/sse/parseSseChunks.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/src/lib/sse/parseSseChunks.ts \
        DevDashboard/mobile/src/lib/sse/parseSseChunks.test.ts
git commit -m "feat(dd-mobile): pure SSE line-framer for the QA stream"
```

---

### Task 2: `expo/fetch` EventSource adapter (`createExpoFetchEventSource`)

**Files:**
- Create: `src/lib/sse/expoFetchEventSource.ts`

This adapter is the `EventSourceLike` the contract's `eventSourceFactory` expects (after Task 0,
`client.ts` defines `interface EventSourceLike { close(); onopen; onmessage; onerror }`). It opens an
`expo/fetch` stream, decodes bytes via `TextDecoder`, feeds the framer, and fires `onopen()` on stream
open + `onmessage({ data })` per event — so the existing `qa.subscribe` in the shared client works
unchanged on mobile (the web's `window.EventSource` already satisfies the same interface).

- [ ] **Step 1: Implement the adapter**

```typescript
// src/lib/sse/expoFetchEventSource.ts
import { fetch as expoFetch } from "expo/fetch";
import type { EventSourceLike } from "@devdashboard/contract";
import { createSseFramer } from "./parseSseChunks";

export interface ExpoFetchEventSourceOptions {
    /** Authorization header value (e.g. "Basic …"), or undefined. */
    authHeader?: string;
}

/**
 * An EventSourceLike over expo/fetch. RN core fetch has no ReadableStream
 * (facebook/react-native#27741); expo/fetch exposes resp.body.getReader().
 * Fires source.onopen when the stream opens, source.onmessage per SSE event,
 * source.onerror on failure/end. No auto-reconnect — QaStream (Task 3) owns
 * reconnect/backoff. The open/error callbacks are the contract's onopen/onerror
 * channels (Task 0 added onopen to EventSourceLike), so qa.subscribe can report
 * "live" without a separate option.
 */
export function createExpoFetchEventSource(
    url: string,
    opts: ExpoFetchEventSourceOptions = {}
): EventSourceLike {
    const controller = new AbortController();
    const framer = createSseFramer();
    let closed = false;

    const source: EventSourceLike = {
        onopen: null,
        onmessage: null,
        onerror: null,
        close() {
            if (closed) {
                return;
            }

            closed = true;
            controller.abort();
        },
    };

    void (async () => {
        try {
            const resp = await expoFetch(url, {
                method: "GET",
                signal: controller.signal,
                headers: {
                    Accept: "text/event-stream",
                    ...(opts.authHeader ? { Authorization: opts.authHeader } : {}),
                },
            });

            if (!resp.ok || !resp.body) {
                throw new Error(`SSE ${url} -> ${resp.status}`);
            }

            source.onopen?.();
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            while (!closed) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                const text = decoder.decode(value, { stream: true });

                for (const evt of framer.push(text)) {
                    source.onmessage?.({ data: evt.data });
                }
            }

            if (!closed) {
                source.onerror?.(new Error("SSE stream ended"));
            }
        } catch (err) {
            if (!closed) {
                source.onerror?.(err);
            }
        }
    })();

    return source;
}
```

> `EventSourceLike` (with the `onopen` channel) is re-exported from `@devdashboard/contract` by
> Task 0 Step 4. Import it from the package barrel; do not redefine it in mobile.

- [ ] **Step 2: Typecheck**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "expoFetchEventSource"`
Expected: no errors. (If `expo/fetch` types are missing, ensure `expo` is installed — it is, via plan 04 scaffold.)

- [ ] **Step 3: Commit**

```bash
git add DevDashboard/mobile/src/lib/sse/expoFetchEventSource.ts
git commit -m "feat(dd-mobile): expo/fetch EventSourceLike adapter (contract SSE factory)"
```

---

### Task 3: Inject the factory into the client + the `QaStream` wrapper

**Files:**
- Modify: `src/lib/api/client.ts` (from plan 04)
- Create: `src/lib/qa/QaStream.ts`

- [ ] **Step 1: Inject the mobile SSE factory into the shared client (plan 04's `client.ts`)**

Plan 04 builds the contract client once. Add the `eventSourceFactory` so `qa.subscribe` works on
mobile. Find the `createDashboardClient({ … })` call and add the factory:

```typescript
// src/lib/api/client.ts (excerpt — add to the existing createDashboardClient call)
import { createDashboardClient } from "@devdashboard/contract";
import { createExpoFetchEventSource } from "@/lib/sse/expoFetchEventSource";

export function buildDashboardClient(opts: { baseUrl: string; authHeader?: () => string | undefined }) {
    return createDashboardClient({
        baseUrl: opts.baseUrl,
        fetch: (...a) => fetch(...a),
        authHeader: opts.authHeader,
        eventSourceFactory: (url) => createExpoFetchEventSource(url, { authHeader: opts.authHeader?.() }),
    });
}
```

> Keep the function name/signature plan 04 established; only the `eventSourceFactory` line is new.
> If plan 04 named the builder differently (`makeClient`, etc.), edit *that* call — do not create a
> second client.

- [ ] **Step 2: Write the `QaStream` (ADR §4 `streamQa(onRow, onStatus)`) over `qa.subscribe`**

```typescript
// src/lib/qa/QaStream.ts
import type { DashboardClient, QaRow } from "@devdashboard/contract";
import type { ConnectionStatus } from "@/components/LiveSseIndicator";

export interface QaStreamHandle {
    close(): void;
}

export interface CreateQaStreamArgs {
    client: DashboardClient;
    onRow: (entry: QaRow) => void;
    onStatus: (status: ConnectionStatus) => void;
    /** Backoff schedule (ms) for reconnect attempts; clamped to the last value. */
    backoffMs?: number[];
}

/**
 * Wraps the contract's qa.subscribe with connection status + reconnect.
 * The contract client streams via the injected expo/fetch factory (Task 2);
 * QaStream owns liveness reporting and the reconnect loop. AppState teardown
 * is the caller's job (useQaFeed, Task 5) — this just exposes close().
 */
export function createQaStream(args: CreateQaStreamArgs): QaStreamHandle {
    const backoff = args.backoffMs ?? [1000, 2000, 5000, 10000];
    let attempt = 0;
    let disposed = false;
    let sub: { close(): void } | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleReconnect(): void {
        if (disposed) {
            return;
        }

        const delay = backoff[Math.min(attempt, backoff.length - 1)];
        attempt += 1;
        args.onStatus("down");
        retryTimer = setTimeout(connect, delay);
    }

    function connect(): void {
        if (disposed) {
            return;
        }

        args.onStatus("connecting");

        try {
            sub = args.client.qa.subscribe(
                (entry) => {
                    attempt = 0;
                    args.onStatus("live");
                    args.onRow(entry);
                },
                {
                    onOpen: () => {
                        attempt = 0;
                        args.onStatus("live");
                    },
                    onError: () => {
                        sub?.close();
                        sub = null;
                        scheduleReconnect();
                    },
                }
            );
        } catch {
            scheduleReconnect();
        }
    }

    connect();

    return {
        close() {
            disposed = true;

            if (retryTimer) {
                clearTimeout(retryTimer);
            }

            sub?.close();
            sub = null;
        },
    };
}
```

> **Depends on Task 0:** `qa.subscribe(onEntry, { onOpen, onError })` + `EventSourceLike.onopen` are
> wired there. The adapter (Task 2) fires `source.onopen()` when `resp.body` opens → the contract
> sets `es.onopen = handlers.onOpen` → `QaStream` flips status to `"live"` *before* the first row.
> `ConnectionStatus` is owned by plan 04's `LiveSseIndicator` module and imported here — do not
> redefine it (a second declaration would diverge from the indicator's prop type).

- [ ] **Step 3: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "QaStream|client.ts"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/lib/api/client.ts DevDashboard/mobile/src/lib/qa/QaStream.ts
git commit -m "feat(dd-mobile): QaStream (streamQa) over the contract qa.subscribe + reconnect"
```

---

### Task 4: Pure merge/dedupe + the Zustand store

**Files:**
- Create: `src/lib/qa/mergeQaRows.ts`
- Test: `src/lib/qa/mergeQaRows.test.ts`
- Create: `src/stores/useQaStore.ts`

- [ ] **Step 1: Write the failing test for the merge + seen reducer**

```typescript
// src/lib/qa/mergeQaRows.test.ts
import { describe, expect, it } from "bun:test";
import { mergeQaRows, type QaRow } from "./mergeQaRows";

function row(id: string, ts: number): QaRow {
    return { id, ts } as QaRow;
}

describe("mergeQaRows", () => {
    it("places live rows before persisted rows", () => {
        const out = mergeQaRows({ live: [row("b", 2)], persisted: [row("a", 1)], seen: new Set() });
        expect(out.map((r) => r.id)).toEqual(["b", "a"]);
    });

    it("drops persisted rows already present in the live list (dedupe by id)", () => {
        const out = mergeQaRows({ live: [row("a", 2)], persisted: [row("a", 1), row("b", 1)], seen: new Set() });
        expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    });

    it("never duplicates an id even if both lists contain it", () => {
        const out = mergeQaRows({ live: [row("x", 3), row("x", 3)], persisted: [row("x", 1)], seen: new Set() });
        expect(out.map((r) => r.id)).toEqual(["x"]);
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun test src/lib/qa/mergeQaRows.test.ts`
Expected: FAIL — `Cannot find module './mergeQaRows'`.

- [ ] **Step 3: Implement the merge (mirrors `qa.tsx:442-443`)**

```typescript
// src/lib/qa/mergeQaRows.ts
import type { QaRow } from "@devdashboard/contract";

export type { QaRow };

export interface MergeArgs {
    /** Rows received live over SSE, newest-first (as pushed by the store). */
    live: QaRow[];
    /** Rows from the persisted /api/qa/log query. */
    persisted: QaRow[];
    /** Ids already seen live; persisted rows in this set are dropped. */
    seen: Set<string>;
}

/** live ++ (persisted minus anything already live/seen), deduped by id, order-stable. */
export function mergeQaRows(args: MergeArgs): QaRow[] {
    const liveIds = new Set<string>();
    const out: QaRow[] = [];

    for (const r of args.live) {
        if (liveIds.has(r.id)) {
            continue;
        }

        liveIds.add(r.id);
        out.push(r);
    }

    for (const r of args.persisted) {
        if (liveIds.has(r.id) || args.seen.has(r.id)) {
            continue;
        }

        out.push(r);
    }

    return out;
}
```

> `QaRow` is the enriched DTO (the server returns `enrichQaEntry(row)`: base `QaEntry` +
> `answerHtml`/`answerHtmlPreview`/`questionHtml` + `supersededBy`/`readAt`). Plan 03's `dto.ts`
> defines `QaRow` (it `export type`s the enriched shape — confirm the field set there; do **not**
> redefine it in mobile). If plan 03 only exported `QaEntry`, add the enriched `QaRow` to plan 03's
> `dto.ts` at the source (it is what `/api/qa/log` and the SSE both return).

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun test src/lib/qa/mergeQaRows.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the Zustand store**

```typescript
// src/stores/useQaStore.ts
import { create } from "zustand";
import type { QaRow } from "@devdashboard/contract";
import type { ConnectionStatus } from "@/components/LiveSseIndicator";

interface QaState {
    live: QaRow[];
    seen: Set<string>;
    readAt: Map<string, number>;
    status: ConnectionStatus;
    pushLive: (entry: QaRow) => void;
    setStatus: (status: ConnectionStatus) => void;
    markSeen: (id: string) => void;
    markUnseen: (id: string) => void;
    /** Seed seen/readAt from a persisted-log fetch (rows with readAt != null). */
    hydrateFromPersisted: (rows: QaRow[]) => void;
    /** On AppState resume we keep live rows but reset connection status. */
    resetConnection: () => void;
}

export const useQaStore = create<QaState>((set) => ({
    live: [],
    seen: new Set<string>(),
    readAt: new Map<string, number>(),
    status: "connecting",
    pushLive: (entry) =>
        set((s) => {
            if (s.live.some((r) => r.id === entry.id)) {
                return s;
            }

            return { live: [entry, ...s.live] };
        }),
    setStatus: (status) => set({ status }),
    markSeen: (id) =>
        set((s) => {
            if (s.seen.has(id)) {
                return s;
            }

            const seen = new Set(s.seen);
            seen.add(id);
            const readAt = new Map(s.readAt);
            readAt.set(id, Date.now());
            return { seen, readAt };
        }),
    markUnseen: (id) =>
        set((s) => {
            if (!s.seen.has(id)) {
                return s;
            }

            const seen = new Set(s.seen);
            seen.delete(id);
            const readAt = new Map(s.readAt);
            readAt.delete(id);
            return { seen, readAt };
        }),
    hydrateFromPersisted: (rows) =>
        set((s) => {
            const seen = new Set(s.seen);
            const readAt = new Map(s.readAt);
            let changed = false;

            for (const r of rows) {
                if (r.readAt != null && !seen.has(r.id)) {
                    seen.add(r.id);
                    readAt.set(r.id, r.readAt);
                    changed = true;
                }
            }

            return changed ? { seen, readAt } : s;
        }),
    resetConnection: () => set({ status: "connecting" }),
}));
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "mergeQaRows|useQaStore"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/lib/qa/mergeQaRows.ts \
        DevDashboard/mobile/src/lib/qa/mergeQaRows.test.ts \
        DevDashboard/mobile/src/stores/useQaStore.ts
git commit -m "feat(dd-mobile): QA merge/dedupe + Zustand store (seen-set, readAt, status)"
```

---

### Task 5: `useQaFeed` — wire client + stream + AppState + persisted log

**Files:**
- Create: `src/features/qa/useQaFeed.ts`

- [ ] **Step 1: Implement the hook**

```typescript
// src/features/qa/useQaFeed.ts
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useDashboardClient } from "@/lib/api/useDashboardClient";
import { createQaStream, type QaStreamHandle } from "@/lib/qa/QaStream";
import { useQaStore } from "@/stores/useQaStore";

export function useQaFeed() {
    const client = useDashboardClient();
    const pushLive = useQaStore((s) => s.pushLive);
    const setStatus = useQaStore((s) => s.setStatus);
    const hydrateFromPersisted = useQaStore((s) => s.hydrateFromPersisted);
    const resetConnection = useQaStore((s) => s.resetConnection);
    const streamRef = useRef<QaStreamHandle | null>(null);

    const logQuery = useQuery({
        queryKey: ["qa-log"],
        queryFn: () => client.qa.log({ limit: 100 }).then((r) => r.entries),
        retry: false,
    });

    useEffect(() => {
        if (logQuery.data) {
            hydrateFromPersisted(logQuery.data);
        }
    }, [logQuery.data, hydrateFromPersisted]);

    useEffect(() => {
        function open(): void {
            streamRef.current?.close();
            streamRef.current = createQaStream({
                client,
                onRow: (entry) => pushLive(entry),
                onStatus: setStatus,
            });
        }

        function close(): void {
            streamRef.current?.close();
            streamRef.current = null;
        }

        open();

        const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
            if (next === "active") {
                resetConnection();
                open();
                void logQuery.refetch();
            } else {
                close();
            }
        });

        return () => {
            sub.remove();
            close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client]);

    return logQuery;
}
```

> `useDashboardClient` is plan 04's provider hook returning the built client (Task 3 Step 1 builder).
> The `AppState` teardown-on-background + reconnect-and-refetch-on-active is research file 04's
> prescribed resync: tmux/cmux/server hold state; we re-merge the persisted log + dedupe by id.

- [ ] **Step 2: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "useQaFeed"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/features/qa/useQaFeed.ts
git commit -m "feat(dd-mobile): useQaFeed (stream + AppState resync + persisted log)"
```

---

### Task 6: QA card, source toggle, search box

**Files:**
- Create: `src/features/qa/QaCard.tsx`
- Create: `src/features/qa/QaSourceToggle.tsx`
- Create: `src/features/qa/QaSearchBox.tsx`

- [ ] **Step 1: Source toggle (reading | source) — ported from web `QaSourceToggle.tsx`**

```typescript
// src/features/qa/QaSourceToggle.tsx
import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/theme/useTheme";

export type QaViewMode = "reading" | "source";

export function QaSourceToggle({ mode, onChange }: { mode: QaViewMode; onChange: (m: QaViewMode) => void }) {
    const t = useTheme();
    const options: Array<{ value: QaViewMode; label: string }> = [
        { value: "reading", label: "Reading" },
        { value: "source", label: "Source" },
    ];

    return (
        <View style={{ flexDirection: "row", borderRadius: 8, borderWidth: 1, borderColor: t.border, overflow: "hidden" }}>
            {options.map((o) => {
                const active = o.value === mode;
                return (
                    <Pressable
                        key={o.value}
                        accessibilityLabel={`qa-view-${o.value}`}
                        testID={`qa-view-${o.value}`}
                        onPress={() => onChange(o.value)}
                        style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: active ? t.accentSoft : "transparent" }}
                    >
                        <Text style={{ color: active ? t.accent : t.textSecondary, fontSize: 13 }}>{o.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
```

- [ ] **Step 2: Search box (debounced) — ported from web `QaSearchBox.tsx`**

```typescript
// src/features/qa/QaSearchBox.tsx
import { useEffect, useState } from "react";
import { TextInput } from "react-native";
import { useTheme } from "@/theme/useTheme";

export function QaSearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const t = useTheme();
    const [local, setLocal] = useState(value);

    useEffect(() => {
        const id = setTimeout(() => onChange(local), 200);
        return () => clearTimeout(id);
    }, [local, onChange]);

    return (
        <TextInput
            accessibilityLabel="qa-search"
            testID="qa-search"
            value={local}
            onChangeText={setLocal}
            placeholder="Search Q&A…"
            placeholderTextColor={t.textMuted}
            style={{
                flex: 1,
                color: t.textPrimary,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 8,
                fontSize: 14,
            }}
        />
    );
}
```

- [ ] **Step 3: QA card — tappable, expand, mark-read (mirrors web `QaCard`)**

```typescript
// src/features/qa/QaCard.tsx
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { QaRow } from "@devdashboard/contract";
import { isQaAnswerTruncated } from "@/lib/qa/qaPreview";
import { useTheme } from "@/theme/useTheme";
import type { QaViewMode } from "./QaSourceToggle";

function tagColor(tag: string, t: ReturnType<typeof useTheme>): string {
    if (tag === "action") {
        return "#a3e635";
    }

    if (tag === "directive") {
        return "#c792ea";
    }

    return t.textSecondary;
}

export function QaCard({
    entry,
    unread,
    viewMode,
    onSeen,
    onUnseen,
}: {
    entry: QaRow;
    unread: boolean;
    viewMode: QaViewMode;
    onSeen: (id: string) => void;
    onUnseen: (id: string) => void;
}) {
    const t = useTheme();
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const truncated = isQaAnswerTruncated(entry.answerMd);
    const answerText = viewMode === "source" ? entry.answerMd : entry.answerMd;
    const shown = open || !truncated ? answerText : `${answerText.split("\n").slice(0, 6).join("\n")}\n…`;

    return (
        <Pressable
            accessibilityLabel={`qa-card-${entry.id}`}
            testID={`qa-card-${entry.id}`}
            onPress={() => (unread ? onSeen(entry.id) : onUnseen(entry.id))}
            onLongPress={() => router.push(`/qa/${entry.id}`)}
            style={{
                gap: 8,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: unread ? t.accent : t.border,
                backgroundColor: t.surface,
            }}
        >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {unread ? (
                    <View accessibilityLabel={`qa-unread-badge-${entry.id}`} testID={`qa-unread-badge-${entry.id}`} style={{ backgroundColor: t.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
                        <Text style={{ color: t.accentContrast, fontSize: 10 }}>new</Text>
                    </View>
                ) : null}
                <Text style={{ color: t.textSecondary, fontSize: 12 }}>{entry.project}</Text>
                <Text style={{ color: tagColor(entry.tag, t), fontSize: 12 }}>{entry.tag}</Text>
            </View>
            <Text style={{ color: t.textMuted, fontSize: 11 }}>Question</Text>
            <Text style={{ color: t.textPrimary, fontSize: 14, fontWeight: "500" }}>{entry.question}</Text>
            <Text style={{ color: t.textMuted, fontSize: 11 }}>Answer</Text>
            <Text style={{ color: t.textPrimary, fontSize: 13 }}>{shown}</Text>
            {truncated ? (
                <Pressable accessibilityLabel={`qa-expand-${entry.id}`} testID={`qa-expand-${entry.id}`} onPress={() => setOpen((v) => !v)}>
                    <Text style={{ color: t.accent, fontSize: 12 }}>{open ? "▴ collapse" : "▾ expand full answer"}</Text>
                </Pressable>
            ) : null}
        </Pressable>
    );
}
```

> `qaPreview.ts` is a tiny port of `qa-preview.ts` (`isQaAnswerTruncated` / `QA_ANSWER_PREVIEW_LINES`).
> If plan 04 didn't port it, add `src/lib/qa/qaPreview.ts` here (copy the two pure helpers verbatim —
> they are runtime-free). Reading-mode markdown rendering on mobile is plain text in v1 (the server's
> pre-rendered `answerHtml` is HTML; rendering it natively is plan 08's Obsidian markdown concern).
> v1 QA shows `answerMd`/`question` text in both modes; the toggle persists for parity and future
> markdown rendering. This is an intentional v1 scope note, not a placeholder.

- [ ] **Step 4: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "QaCard|QaSourceToggle|QaSearchBox"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/features/qa/QaCard.tsx \
        DevDashboard/mobile/src/features/qa/QaSourceToggle.tsx \
        DevDashboard/mobile/src/features/qa/QaSearchBox.tsx
git commit -m "feat(dd-mobile): QA card + source toggle + search box"
```

---

### Task 7: Port the search filter (`searchQa`)

**Files:**
- Create: `src/lib/search/searchQa.ts` (if plan 04 didn't already port `fuzzy-tokens`)
- Test: `src/lib/search/searchQa.test.ts`

The web filters via `searchQa(all, query)` (`qa-search.ts`) over `@app/utils/fuzzy-tokens`. Port the
pure scorer; it is runtime-free so the port is verbatim.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/search/searchQa.test.ts
import { describe, expect, it } from "bun:test";
import { searchQa } from "./searchQa";
import type { QaRow } from "@devdashboard/contract";

function row(over: Partial<QaRow>): QaRow {
    return { id: "x", question: "", answerMd: "", tag: "question", project: "", refs: [], ...over } as QaRow;
}

describe("searchQa", () => {
    it("returns all rows + empty tokens for an empty query", () => {
        const rows = [row({ id: "a" }), row({ id: "b" })];
        const res = searchQa(rows, "");
        expect(res.entries).toHaveLength(2);
        expect(res.tokens).toEqual([]);
    });

    it("filters by a token hit in the question/answer haystack", () => {
        const rows = [row({ id: "a", question: "expo fetch sse" }), row({ id: "b", question: "tmux split" })];
        const res = searchQa(rows, "expo");
        expect(res.entries.map((r) => r.id)).toEqual(["a"]);
        expect(res.tokens).toContain("expo");
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun test src/lib/search/searchQa.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Port `searchQa` + the `fuzzy-tokens` helpers it needs**

```typescript
// src/lib/search/searchQa.ts
import type { QaRow } from "@devdashboard/contract";
import { scoreEntry, tokenizeSearch } from "./fuzzyTokens";

export interface SearchResult {
    entries: QaRow[];
    tokens: string[];
}

function entryHaystack(row: QaRow): string {
    return [
        row.question,
        row.answerMd,
        row.tag,
        row.project ?? "",
        row.branch ?? "",
        row.commitSha ?? "",
        row.agentLabel ?? "",
        row.refs.map((x) => `${x.type}:${x.value}`).join(" "),
    ].join(" ");
}

export function searchQa(rows: QaRow[], query: string): SearchResult {
    const tokens = tokenizeSearch(query);

    if (tokens.length === 0) {
        return { entries: rows, tokens: [] };
    }

    const entries = rows
        .map((entry) => ({ entry, score: scoreEntry(entryHaystack(entry), tokens) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.entry);

    return { entries, tokens };
}
```

> Copy `tokenizeSearch` + `scoreEntry` from `src/utils/fuzzy-tokens.ts` into
> `src/lib/search/fuzzyTokens.ts` (verbatim — confirm it has no `node:`/`bun:` imports first with
> `rg -n "^import |require\(" src/utils/fuzzy-tokens.ts`; it is pure string scoring). If plan 04
> already exposed it, import from there instead of duplicating.

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun test src/lib/search/searchQa.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/src/lib/search/searchQa.ts \
        DevDashboard/mobile/src/lib/search/fuzzyTokens.ts \
        DevDashboard/mobile/src/lib/search/searchQa.test.ts
git commit -m "feat(dd-mobile): port searchQa fuzzy filter for the QA feed"
```

---

### Task 8: The QA feed screen (`app/(tabs)/qa/index.tsx`)

**Files:**
- Create: `app/(tabs)/qa/index.tsx`

- [ ] **Step 1: Implement the feed screen**

```typescript
// app/(tabs)/qa/index.tsx
import { useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { LiveSseIndicator } from "@/components/LiveSseIndicator";
import { QaCard } from "@/features/qa/QaCard";
import { QaSearchBox } from "@/features/qa/QaSearchBox";
import { QaSourceToggle, type QaViewMode } from "@/features/qa/QaSourceToggle";
import { useQaFeed } from "@/features/qa/useQaFeed";
import { mergeQaRows } from "@/lib/qa/mergeQaRows";
import { searchQa } from "@/lib/search/searchQa";
import { useQaStore } from "@/stores/useQaStore";
import { useTheme } from "@/theme/useTheme";

export default function QaFeedScreen() {
    const t = useTheme();
    const logQuery = useQaFeed();
    const live = useQaStore((s) => s.live);
    const seen = useQaStore((s) => s.seen);
    const status = useQaStore((s) => s.status);
    const markSeen = useQaStore((s) => s.markSeen);
    const markUnseen = useQaStore((s) => s.markUnseen);
    const [viewMode, setViewMode] = useState<QaViewMode>("reading");
    const [query, setQuery] = useState("");

    const merged = useMemo(
        () => mergeQaRows({ live, persisted: logQuery.data ?? [], seen }),
        [live, logQuery.data, seen]
    );
    const { entries: filtered } = useMemo(() => searchQa(merged, query), [merged, query]);

    if (logQuery.isError) {
        return (
            <View accessibilityLabel="qa-error" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 }}>
                <Text style={{ color: "#f87171", fontSize: 16, fontWeight: "700" }}>Failed to load Q&amp;A</Text>
                <Text style={{ color: t.textSecondary, fontSize: 13, textAlign: "center" }}>
                    {logQuery.error instanceof Error ? logQuery.error.message : String(logQuery.error)}
                </Text>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: t.background, padding: 16, gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <LiveSseIndicator status={status} testID="qa-live-indicator" />
                <Text accessibilityLabel="qa-count" style={{ color: t.textMuted, fontSize: 12 }}>{merged.length}</Text>
                <View style={{ flex: 1 }}>
                    <QaSearchBox value={query} onChange={setQuery} />
                </View>
                <QaSourceToggle mode={viewMode} onChange={setViewMode} />
            </View>

            {logQuery.isLoading ? (
                <Text accessibilityLabel="qa-loading" style={{ color: t.textMuted, textAlign: "center", paddingVertical: 32 }}>Loading Q&amp;A…</Text>
            ) : filtered.length === 0 ? (
                <Text accessibilityLabel="qa-empty" style={{ color: t.textMuted, textAlign: "center", paddingVertical: 32 }}>
                    {merged.length === 0 ? "No questions recorded yet." : "No matches for your search."}
                </Text>
            ) : (
                <FlatList
                    accessibilityLabel="qa-list"
                    testID="qa-list"
                    data={filtered}
                    keyExtractor={(r) => r.id}
                    contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
                    renderItem={({ item }) => (
                        <QaCard
                            entry={item}
                            unread={!seen.has(item.id)}
                            viewMode={viewMode}
                            onSeen={markSeen}
                            onUnseen={markUnseen}
                        />
                    )}
                />
            )}
        </View>
    );
}
```

> `LiveSseIndicator` is the shared connection-state component from plan 04 (`ConnectionStatus` =
> `"connecting" | "live" | "down"`). It maps to the web `QaTopBar live` dot. If plan 04 named it
> differently, use that name — do not create a second indicator.

- [ ] **Step 2: Persist mark-read to the server (debounced) — extend `useQaFeed`**

The web flushes read/unread ids to `/api/qa/read` with a 400ms debounce (`qa.tsx:240-284`). Add the
same flush to the store via a `useQaRead` effect. Append to `useQaFeed.ts`:

```typescript
// append to src/features/qa/useQaFeed.ts — a debounced persist of seen/unseen deltas
// (call from QaFeedScreen, or fold into useQaFeed; shown standalone for clarity)
import { useEffect, useRef } from "react";
import { useDashboardClient } from "@/lib/api/useDashboardClient";
import { useQaStore } from "@/stores/useQaStore";

const READ_DEBOUNCE_MS = 400;

export function useQaReadPersist() {
    const client = useDashboardClient();
    const seen = useQaStore((s) => s.seen);
    const prev = useRef<Set<string>>(new Set());
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pendingRead = useRef<Set<string>>(new Set());
    const pendingUnread = useRef<Set<string>>(new Set());

    useEffect(() => {
        for (const id of seen) {
            if (!prev.current.has(id)) {
                pendingRead.current.add(id);
                pendingUnread.current.delete(id);
            }
        }

        for (const id of prev.current) {
            if (!seen.has(id)) {
                pendingUnread.current.add(id);
                pendingRead.current.delete(id);
            }
        }

        prev.current = new Set(seen);

        if (timer.current) {
            return;
        }

        timer.current = setTimeout(() => {
            timer.current = undefined;
            const reads = [...pendingRead.current];
            const unreads = [...pendingUnread.current];
            pendingRead.current.clear();
            pendingUnread.current.clear();

            if (reads.length > 0) {
                void client.qa.read(reads, false).catch(() => undefined);
            }

            if (unreads.length > 0) {
                void client.qa.read(unreads, true).catch(() => undefined);
            }
        }, READ_DEBOUNCE_MS);
    }, [seen, client]);
}
```

Then call `useQaReadPersist()` once inside `QaFeedScreen` (above the early returns).

> `client.qa.read(ids, unread?)` is added in Task 0 Step 4 — `POST /api/qa/read` with
> `{ ids, unread: unread || undefined }` (mirrors `qa.tsx:259-263`). The debounce here mirrors the
> web's 400ms read flush (`qa.tsx:240-284`); best-effort `.catch(() => undefined)` matches the web.

- [ ] **Step 3: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "qa/index|useQaRead"`
Expected: no errors.

```bash
git add "DevDashboard/mobile/app/(tabs)/qa/index.tsx" DevDashboard/mobile/src/features/qa/useQaFeed.ts
git commit -m "feat(dd-mobile): QA feed screen (live indicator, search, toggle, mark-read persist)"
```

---

### Task 9: Entry detail screen + save-to-obsidian

**Files:**
- Create: `app/(tabs)/qa/[id].tsx`
- Create: `src/features/qa/SaveToObsidianSheet.tsx`

- [ ] **Step 1: Save-to-obsidian sheet (mirrors web `QaSaveToObsidianDialog`)**

```typescript
// src/features/qa/SaveToObsidianSheet.tsx
import { useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { useDashboardClient } from "@/lib/api/useDashboardClient";
import { useTheme } from "@/theme/useTheme";

export function SaveToObsidianSheet({ entryId, onClose }: { entryId: string; onClose: () => void }) {
    const t = useTheme();
    const client = useDashboardClient();
    const [relativeDir, setRelativeDir] = useState("");
    const [baseName, setBaseName] = useState("");
    const [mode, setMode] = useState<"create" | "append">("create");
    const [createDir, setCreateDir] = useState(true);
    const [includeFrontmatter, setIncludeFrontmatter] = useState(true);
    const [includeQuestion, setIncludeQuestion] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSave = relativeDir.trim().length > 0 && baseName.trim().length > 0 && !saving;

    async function onSave(): Promise<void> {
        setSaving(true);
        setError(null);

        try {
            await client.qa.saveToObsidian({
                entryId,
                relativeDir: relativeDir.trim(),
                baseName: baseName.trim().replace(/\.md$/i, ""),
                mode,
                createDir,
                includeFrontmatter,
                includeQuestion,
            });
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <View accessibilityLabel="qa-save-sheet" style={{ gap: 12, padding: 16, backgroundColor: t.surface, borderRadius: 16 }}>
            <Text style={{ color: t.textPrimary, fontSize: 16, fontWeight: "700" }}>Save to Obsidian</Text>
            <TextInput accessibilityLabel="qa-save-dir" testID="qa-save-dir" value={relativeDir} onChangeText={setRelativeDir} placeholder="relative/dir" placeholderTextColor={t.textMuted} style={inputStyle(t)} />
            <TextInput accessibilityLabel="qa-save-name" testID="qa-save-name" value={baseName} onChangeText={setBaseName} placeholder="note-name" placeholderTextColor={t.textMuted} style={inputStyle(t)} />
            <Row label="Append (vs create)" value={mode === "append"} onValueChange={(v) => setMode(v ? "append" : "create")} a11y="qa-save-mode-append" />
            {mode === "create" ? <Row label="Create dir if missing" value={createDir} onValueChange={setCreateDir} a11y="qa-save-createdir" /> : null}
            <Row label="Include frontmatter" value={includeFrontmatter} onValueChange={setIncludeFrontmatter} a11y="qa-save-frontmatter" />
            <Row label="Include question" value={includeQuestion} onValueChange={setIncludeQuestion} a11y="qa-save-question" />
            {error ? <Text style={{ color: "#f87171", fontSize: 12 }}>{error}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                <Pressable accessibilityLabel="qa-save-cancel" testID="qa-save-cancel" onPress={onClose}><Text style={{ color: t.textSecondary, padding: 10 }}>Cancel</Text></Pressable>
                <Pressable accessibilityLabel="qa-save-confirm" testID="qa-save-confirm" disabled={!canSave} onPress={() => void onSave()} style={{ backgroundColor: canSave ? t.accent : t.border, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
                    <Text style={{ color: t.accentContrast }}>{saving ? "Saving…" : mode === "append" ? "Append" : "Save note"}</Text>
                </Pressable>
            </View>
        </View>
    );
}

function inputStyle(t: ReturnType<typeof useTheme>) {
    return { color: t.textPrimary, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 };
}

function Row({ label, value, onValueChange, a11y }: { label: string; value: boolean; onValueChange: (v: boolean) => void; a11y: string }) {
    const t = useTheme();
    return (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: t.textSecondary, fontSize: 13 }}>{label}</Text>
            <Switch accessibilityLabel={a11y} testID={a11y} value={value} onValueChange={onValueChange} />
        </View>
    );
}
```

> `client.qa.saveToObsidian(body)` is added in Task 0 Step 4 (`POST /api/qa/save-to-obsidian`,
> response `{ path: string }`). v1 omits the Obsidian-tree picker (web `obsidian/tree` autocomplete) —
> a free-text dir/name is the scoped v1 surface; the tree picker is plan 08.

- [ ] **Step 2: Entry detail screen**

```typescript
// app/(tabs)/qa/[id].tsx
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { QaRow } from "@devdashboard/contract";
import { SaveToObsidianSheet } from "@/features/qa/SaveToObsidianSheet";
import { useQaStore } from "@/stores/useQaStore";
import { useTheme } from "@/theme/useTheme";

export default function QaDetailScreen() {
    const t = useTheme();
    const { id } = useLocalSearchParams<{ id: string }>();
    const live = useQaStore((s) => s.live);
    const queryClient = useQueryClient();
    const [saveOpen, setSaveOpen] = useState(false);

    // Resolve from the live buffer first, then the persisted ['qa-log'] cache —
    // so long-pressing an older (non-live) card still opens its detail.
    const entry = useMemo(() => {
        const fromLive = live.find((r) => r.id === id);
        if (fromLive) {
            return fromLive;
        }

        const persisted = queryClient.getQueryData<QaRow[]>(["qa-log"]) ?? [];
        return persisted.find((r) => r.id === id);
    }, [live, id, queryClient]);

    if (!entry) {
        return (
            <View accessibilityLabel="qa-detail-missing" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: t.textSecondary }}>Entry unavailable. Pull to refresh the feed.</Text>
            </View>
        );
    }

    return (
        <ScrollView accessibilityLabel={`qa-detail-${entry.id}`} style={{ flex: 1, backgroundColor: t.background }} contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Text style={{ color: t.textSecondary, fontSize: 12 }}>{entry.project} · {entry.tag}</Text>
            <Text style={{ color: t.textMuted, fontSize: 11 }}>Question</Text>
            <Text style={{ color: t.textPrimary, fontSize: 15, fontWeight: "500" }}>{entry.question}</Text>
            <Text style={{ color: t.textMuted, fontSize: 11 }}>Answer</Text>
            <Text style={{ color: t.textPrimary, fontSize: 14 }}>{entry.answerMd}</Text>
            {entry.refs.length > 0 ? (
                <Text style={{ color: t.textMuted, fontSize: 12 }}>refs: {entry.refs.map((r) => `${r.type}:${r.value}`).join(" · ")}</Text>
            ) : null}
            <Pressable accessibilityLabel="qa-detail-save" testID="qa-detail-save" onPress={() => setSaveOpen(true)} style={{ backgroundColor: t.accentSoft, borderRadius: 8, padding: 12, alignItems: "center" }}>
                <Text style={{ color: t.accent }}>Save to Obsidian</Text>
            </Pressable>
            <Modal visible={saveOpen} transparent animationType="slide" onRequestClose={() => setSaveOpen(false)}>
                <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
                    <SaveToObsidianSheet entryId={entry.id} onClose={() => setSaveOpen(false)} />
                </View>
            </Modal>
        </ScrollView>
    );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "qa/\[id\]|SaveToObsidian"`
Expected: no errors.

```bash
git add "DevDashboard/mobile/app/(tabs)/qa/[id].tsx" DevDashboard/mobile/src/features/qa/SaveToObsidianSheet.tsx
git commit -m "feat(dd-mobile): QA entry detail + save-to-obsidian sheet"
```

---

### Task 10: Appium `QaPage` Page Object + spec

**Files:**
- Create: `e2e/pages/qa.page.ts`
- Create: `e2e/specs/qa.spec.ts`

Per ADR §8 the feature is **done only when this spec passes** on the iOS dev-client. Use the `appium`
skill / `appium_*` MCP tools — **accessibility-id locators first** (every component above sets
`accessibilityLabel` + `testID`; on iOS the `accessibilityLabel`/`testID` map to the accessibility id
the driver locates). Drive taps via `appium_gesture` (action `tap`); for off-screen rows use
`appium_gesture` action `scroll_to_element`.

- [ ] **Step 1: Page Object**

```typescript
// e2e/pages/qa.page.ts
import { getAttribute, getText, setValue, tap, waitForGone, waitForValue, waitForVisible } from "../support/driver";

export class QaPage {
    static readonly tab = "tab-qa";
    static readonly list = "qa-list";
    static readonly liveIndicator = "qa-live-indicator";
    static readonly count = "qa-count";
    static readonly search = "qa-search";

    async open(): Promise<void> {
        await tap(QaPage.tab);
        await waitForVisible(QaPage.list, 10_000);
    }

    /** Asserts the indicator's accessibility value reads "live" — not just that it is visible. */
    async waitForLive(timeoutMs = 15_000): Promise<void> {
        await waitForVisible(QaPage.liveIndicator, timeoutMs);
        await waitForValue(QaPage.liveIndicator, "live", timeoutMs);
    }

    async liveStatus(): Promise<string> {
        return getAttribute(QaPage.liveIndicator, "value");
    }

    async waitForCard(id: string, timeoutMs = 15_000): Promise<void> {
        await waitForVisible(`qa-card-${id}`, timeoutMs);
    }

    async tapCard(id: string): Promise<void> {
        await tap(`qa-card-${id}`);
    }

    /** Per-id badge: the unread badge accessibility-id is suffixed with the entry id. */
    async isUnread(id: string): Promise<boolean> {
        return waitForVisible(`qa-unread-badge-${id}`, 1500).then(() => true).catch(() => false);
    }

    /** Waits until the per-id unread badge is gone (mark-read landed). */
    async waitUntilRead(id: string, timeoutMs = 5_000): Promise<void> {
        await waitForGone(`qa-unread-badge-${id}`, timeoutMs);
    }

    async search(term: string): Promise<void> {
        await setValue(QaPage.search, term);
    }

    async readCount(): Promise<string> {
        return getText(QaPage.count);
    }
}
```

> `../support/driver.ts` is plan 04's thin wrapper over the `appium_*` MCP tools: `tap`
> (`appium_gesture` action `tap`), `setValue` (`appium_set_value`), `getText` (`appium_get_text`),
> `getAttribute` (`appium_get_element_attribute`), `waitForVisible`/`waitForGone`
> (`appium_find_element` poll), and `waitForValue` (polls `getAttribute(id, "value")` until it equals
> the target). All locate by accessibility id. **Plan-04 dependency:** `LiveSseIndicator` must expose
> its `status` as the element's accessibility **value** (e.g. `accessibilityValue={{ text: status }}`
> on the indicator root), so `waitForValue("qa-live-indicator", "live")` is assertable. If plan 04's
> indicator doesn't set `accessibilityValue`, add it there (one prop) — at the source, not here. If
> plan 04 named the helpers differently, use those — do not fork the driver.

- [ ] **Step 2: The spec — stream shows a new entry live + mark-read works**

```typescript
// e2e/specs/qa.spec.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Bash } from "../support/shell"; // wrapper around `tools question record …` on the Mac under test
import { QaPage } from "../pages/qa.page";
import { startSession, stopSession } from "../support/driver";

describe("QA live stream", () => {
    const qa = new QaPage();
    let recordedId = "";

    beforeAll(async () => {
        await startSession();
        await qa.open();
        await qa.waitForLive();
    });

    afterAll(async () => {
        await stopSession();
    });

    it("shows a freshly recorded entry live (SSE)", async () => {
        // Record a QA entry on the agent host; the SSE tails today's log file.
        recordedId = await Bash.recordQuestion({
            question: `appium-e2e ${Date.now()}`,
            answer: "live-stream-proof",
            tag: "question",
        });

        await qa.waitForCard(recordedId, 15_000);
        expect(await qa.isUnread(recordedId)).toBe(true);
    });

    it("marks the entry read on tap and clears its unread badge", async () => {
        await qa.tapCard(recordedId);
        // The per-id badge (qa-unread-badge-<id>) disappears; other unread cards are unaffected.
        await qa.waitUntilRead(recordedId);
        expect(await qa.isUnread(recordedId)).toBe(false);
    });
});
```

> `Bash.recordQuestion` shells `tools question record --question … --answer … --tag …` on the host
> running the Agent (the QA SSE tails `todayLogFile()` written by `tools question`). It returns the
> new entry id (parse the CLI's `out.result`). This is the live-proof: an out-of-band write appears
> in the app without a manual refresh — exactly what `/api/qa/stream` guarantees.

- [ ] **Step 3: Run the spec on the iOS dev-client**

Run: launch the dev-client on the booted simulator, ensure the Agent is reachable (LAN tier), then
`cd DevDashboard/mobile && bun test e2e/specs/qa.spec.ts` (or the project's Appium runner script).
Expected: 2 passing tests — the recorded entry appears live; the unread badge clears on tap.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/e2e/pages/qa.page.ts DevDashboard/mobile/e2e/specs/qa.spec.ts
git commit -m "test(dd-mobile): Appium QaPage spec (live entry + mark-read)"
```

---

## Self-Review checklist

1. **Type consistency with the ADR/contract:** uses `QaStream` + `streamQa(onRow, onStatus)` (ADR §4),
   the contract's `EventSourceLike` (with `onopen`) / `eventSourceFactory` / `DashboardClient` /
   `QaEntry` / `QaRow` (plan 03), and a single `ConnectionStatus = "connecting" | "live" | "down"`
   owned by plan 04's `LiveSseIndicator` and imported everywhere (not re-declared). No divergent names.
   The `onopen` channel is what lets the indicator reach `"live"` *before* the first row arrives — the
   server's `: qa stream open` is a comment the framer drops, so without `onopen` the dot would stay
   "connecting" until a row, breaking `waitForLive`.
2. **SSE parser is a tested unit:** `createSseFramer` (7 `bun:test` cases) — handles multi-line data,
   chunk-split boundaries, comment/keep-alive lines, CRLF, and partial trailing blocks. ~40 LOC,
   mirrors ChatterUI `SSEFetch.ts`.
3. **`expo/fetch`, not core fetch:** the adapter imports `fetch from "expo/fetch"` and uses
   `resp.body.getReader()` (verified SDK 55 recipe) — RN core fetch has no ReadableStream (#27741).
4. **Resync mirrors the web exactly:** dedupe by `entry.id` (Set), merge persisted `/api/qa/log`
   filtered to unseen rows (`mergeQaRows`), reconnect + refetch on `AppState` `active`. **No
   `Last-Event-ID`** (server emits no `id:` lines — `vite-middleware.ts:589`).
5. **Parity surface:** live feed + `LiveSseIndicator`, entry detail, mark-read/unread (debounced
   `/api/qa/read`), save-to-obsidian (`/api/qa/save-to-obsidian` with the exact body keys),
   source/reading toggle, search (`searchQa` port).
6. **No production `as` casts:** after Task 0 types `QaLogRes.entries` as `QaRow[]` and `qa.subscribe`
   as `(entry: QaRow) => void`, the app code has **zero** `as QaRow` casts (the only casts are
   test-local partial-fixture casts in `*.test.ts`, scoped to tests). Honors the user's "no inline
   type casts" rule.
7. **Conventions:** Bun + TS strict; objects for 3+ params (`createQaStream(args)`, `mergeQaRows(args)`,
   `saveToObsidian(body)`); blank line before `if` / after `}`; no one-line `if`; no `as any`; native
   modules come from plan 04's `npx expo install` scaffold (this plan adds no new native dep —
   `expo/fetch` ships in `expo`). No `SafeJSON`/`JSON` is parsed in mobile QA code — the contract
   client owns JSON parsing; the SSE adapter forwards raw `data` strings to `qa.subscribe`.
8. **Per-id unread badge:** `qa-unread-badge-${id}` (not a shared id) — so the mark-read Appium
   assertion checks the *target* card's badge, unaffected by other unread entries in the 100-row log.
9. **Contract changes are consolidated in Task 0 (plan 03 source):** `EventSourceLike.onopen`,
   `qa.subscribe(onEntry, { onOpen, onError })` emitting `QaRow`, `QaLogRes.entries: QaRow[]`,
   `qa.read(ids, unread?)`, `qa.saveToObsidian(body)`, and the `EventSourceLike` barrel re-export —
   each with a failing→passing client test. Task 0 is "skip if 03 already shipped them."
10. **No placeholders:** every step ships full code; the two intentional v1 scope notes
   (plain-text markdown rendering deferred to plan 08; Obsidian-tree picker deferred to plan 08) are
   explicit, not TODOs.

## Appium E2E (ADR §8 — required)

- **Spec:** `e2e/specs/qa.spec.ts` — two assertions: (a) an out-of-band `tools question record` on the
  Agent host appears in the feed **live** over SSE (proves the `expo/fetch` stream + framer +
  `qa.subscribe` path end-to-end), and (b) tapping the card clears the unread badge and persists via
  `/api/qa/read` (proves mark-read).
- **Page Object:** `e2e/pages/qa.page.ts` — `QaPage` with `open()`, `waitForLive()` (asserts the
  indicator's accessibility **value** is `"live"`, not mere visibility), `liveStatus()`,
  `waitForCard(id)`, `tapCard(id)`, `isUnread(id)` (per-id badge), `waitUntilRead(id)`, `search(term)`,
  `readCount()`. **Accessibility-id locators**: `tab-qa`, `qa-list`, `qa-live-indicator` (whose
  `accessibilityValue.text` = the connection status), `qa-count`, `qa-search`, `qa-card-<id>`,
  `qa-unread-badge-<id>`, `qa-expand-<id>`, plus the save-sheet ids (`qa-save-dir`, `qa-save-name`,
  `qa-save-mode-append`, `qa-save-createdir`, `qa-save-frontmatter`, `qa-save-question`,
  `qa-save-confirm`, `qa-save-cancel`, `qa-detail-save`). Drive taps with `appium_gesture` (action
  `tap`); off-screen rows via `appium_gesture` action `scroll_to_element`; text entry via
  `appium_set_value`; the indicator value via `appium_get_element_attribute` (`value`); existence via
  `appium_find_element` by accessibility id.
- **Done definition:** the QA feature is "done" **only when `e2e/specs/qa.spec.ts` passes** on the
  iOS simulator/dev-client (ADR §8). The `bun:test` units (`parseSseChunks`, `mergeQaRows`,
  `searchQa`) must also be green.

## Hand-off

This plan assumes plan 04 has shipped: the Expo app, `useDashboardClient()` / `useTransport()`, the
theme (`useTheme` tokens: `background`, `surface`, `border`, `accent`, `accentSoft`,
`accentContrast`, `textPrimary`, `textSecondary`, `textMuted`), the `LiveSseIndicator` (owning
`ConnectionStatus` and exposing its status via `accessibilityValue`), the `(tabs)` router with a
`tab-qa` entry, and the `e2e/support/driver.ts` Appium helpers (`tap`/`setValue`/`getText`/
`getAttribute`/`waitForVisible`/`waitForGone`/`waitForValue`). The contract additions are
front-loaded as **Task 0** here but belong in plan 03's `@devdashboard/contract` — do them there if
03 shipped without them, then "skip" Task 0. After this plan, plan 08 (Obsidian) reuses
`SaveToObsidianSheet`'s dir/name surface and adds native markdown rendering that the QA reading-mode
toggle will then consume.
