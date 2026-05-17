# Event System (Real-Time Sync)

> Two complementary layers: a **server→client SSE domain bus** (cross-device,
> cross-process push) and **BroadcastChannel** (same-device, tab-to-tab).
> Both just tell TanStack Query to refetch — the server stays source of truth.

The old generic `broadcastToUser`/`broadcastToScope` SSE API and
`lib/events/server.ts` / `client.ts` no longer exist. This is the current
(generalized, plan-08) implementation — verified against the code.

## Find It Fast

| Looking for...        | Go to                                          |
| --------------------- | ---------------------------------------------- |
| Server event bus      | `src/lib/events/event-bus.server.ts`           |
| Client SSE hook       | `src/lib/events/useServerEvents.ts`            |
| Generic SSE endpoint  | `src/routes/api.events.ts`                      |
| Timer SSE endpoint    | `src/routes/api.timer-events.ts`                |
| Timer compat shim     | `src/lib/timer/timer-events.server.ts`          |
| Cross-tab (same device)| `src/lib/sync/useBroadcastInvalidation.ts`     |

## Layer 1 — SSE Domain Bus (server → client)

### Server (`lib/events/event-bus.server.ts`)

One `EventEmitter` **per user**, events tagged with a `domain` so a single SSE
connection can be server-filtered. **In-memory only** — events are lost on
server restart; that's fine because EventSource auto-reconnects and clients
re-fetch on reconnect.

```ts
export interface DomainEvent { domain: string; type: string; [k: string]: unknown }

emitDomainEvent(userId, "notes", { type: "sync", noteId });   // from a server mutation
const unsub = subscribeEvents(userId, (e) => { /* … */ });    // from the SSE route
```

Emit a domain event from a `.server.ts` mutation **after** the DB write.
Domains in use today: `timer`, `notes`, `bookmarks`, `ai`.

### Timer compat shim (`lib/timer/timer-events.server.ts`)

A thin wrapper so timer call sites need zero changes — `emitTimerEvent` /
`subscribeTimerEvents` just delegate to the bus with `domain="timer"`. Don't
add per-domain shims for new domains; call `emitDomainEvent` directly.

### Endpoints

| Route | Purpose |
| ----- | ------- |
| `GET /api/events?userId=<id>&domain=<d>` | Generic. `domain` optional — omit to receive every domain. |
| `GET /api/timer-events`                  | Timer-only compat stream (same lifecycle). |

Both routes are identical in shape: auth via `getUserIdFromRequest` (401 if
absent), a `ReadableStream` emitting `data: <SafeJSON>\n\n`, a `: ping\n\n`
**keep-alive every 30s** (defeats proxy idle timeouts), and `request.signal`
`abort` → clear keepalive + unsubscribe + close. Headers:
`text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no` (critical behind the front-proxy/tunnel).

### Client (`lib/events/useServerEvents.ts`)

```tsx
useServerEvents({
    userId,                       // null until known; "dev-user" in no-auth dev
    domain: "notes",
    onEvent: (e) => {
        if (e.type === "sync") queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
});
```

- Opens one `EventSource` to `/api/events?userId&domain`; closes on unmount.
- `onEvent` is held in a **ref** — an inline callback won't churn the
  connection every render.
- SSR-guarded (`typeof EventSource === "undefined"`); browser auto-reconnects
  on drop (handled — don't add manual retry).
- Payload parsed with `SafeJSON.parse` (never bare `JSON`).

## Layer 2 — BroadcastChannel (same device, tab→tab)

`lib/sync/useBroadcastInvalidation.ts` — instant same-origin tab sync without a
round-trip. Channels: `CHRONO_SYNC_CHANNEL`, `ASSISTANT_SYNC_CHANNEL`.

```ts
// feature root: receive invalidations from sibling tabs
useBroadcastInvalidation(ASSISTANT_SYNC_CHANNEL);

// mutation onSuccess: invalidate locally AND notify sibling tabs
const invalidate = useInvalidateAndBroadcast(ASSISTANT_SYNC_CHANNEL);
invalidate(["assistant-tasks"]);
```

`broadcastInvalidate()` notifies other tabs **only** (no local invalidation) —
prefer `useInvalidateAndBroadcast()` which does both. SSR-safe (silently skips
when `BroadcastChannel` is undefined).

## Which layer do I use?

| Need | Use |
| ---- | --- |
| Other tabs in the **same browser** react instantly to a mutation | BroadcastChannel (`useInvalidateAndBroadcast`) |
| Another **device / process** (background tab, phone, server-side change) must see it | SSE bus (`emitDomainEvent` + `useServerEvents`) |
| Robust real-time for a domain | Both — they're complementary, not exclusive |

## Full Example (server mutation → both layers)

```ts
// notes.server.ts
export const deleteNote = createServerFn({ method: "POST" })
    .inputValidator((d: { noteId: string; userId: string }) => d)
    .handler(({ data }) => {                       // sync — better-sqlite3
        db.delete(notes).where(eq(notes.id, data.noteId)).run();
        emitDomainEvent(data.userId, "notes", { type: "sync", noteId: data.noteId });
        return { success: true };
    });
```

```tsx
// notes route component
useBroadcastInvalidation(ASSISTANT_SYNC_CHANNEL);
useServerEvents({ userId, domain: "notes",
    onEvent: () => queryClient.invalidateQueries({ queryKey: ["notes"] }) });
const invalidate = useInvalidateAndBroadcast(ASSISTANT_SYNC_CHANNEL);
useMutation({ mutationFn: deleteNote, onSuccess: () => invalidate(["notes"]) });
```

## Gotchas

- **Bus is in-memory.** No persistence/replay. Don't treat events as a
  durable log — they're "something changed, refetch" nudges.
- **Always emit *after* the DB write succeeds**, never before.
- **`X-Accel-Buffering: no` is load-bearing** behind the front-proxy/tunnel —
  without it SSE buffers and updates arrive in bursts or never.
- **One EventSource per `{userId,domain}`** via the hook; don't hand-roll a
  second connection.

## Related Docs

- [Database](./database.md) — Drizzle + better-sqlite3 (emit events after writes)
