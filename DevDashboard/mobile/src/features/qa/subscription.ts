import type { DashboardClient, QaRow } from "@dd/contract";

/**
 * A small, renderer-free controller around the contract's `client.qa.subscribe` (which wires the
 * injected `eventSourceFactory` — `expo/fetch` SSE on a real device, an 800ms fixture emit under the
 * mock). It dedupes by `entry.id` across the live session, reports a coarse liveness signal, and
 * exposes a single `close()` for teardown. The `useQaStream` hook (hooks.ts) owns the React lifecycle
 * (mount/unmount + AppState) and delegates the actual subscribe to this controller so the dedupe +
 * teardown logic is unit-testable by injecting a fake `subscribe` (see subscription.test.ts).
 *
 * Why not the transport's `streamQa()` directly: we consume only `useDashboardClient()` (D32) so the
 * mock↔real swap stays invisible. `client.qa.subscribe` is that single seam. The contract's
 * subscribe forwards open/error from the active EventSource adapter, so status reflects the stream
 * itself and reconnects can trigger an authoritative log resync.
 */

/**
 * Stream liveness:
 * - `"connecting"` — the subscription has not been created yet.
 * - `"open"` — the subscription is established (the agent is connected) but no row has streamed.
 * - `"live"` — at least one row has streamed.
 *
 * The header dot treats both `"open"` and `"live"` as connected. `"down"` means the stream ended or
 * errored and its bounded reconnect adapter is recovering or exhausted.
 */
export type QaLiveStatus = "connecting" | "open" | "live" | "down";

export interface QaSubscriptionCallbacks {
    /** Fired once per NEW entry id (deduped across the controller's lifetime). */
    onRow: (entry: QaRow) => void;
    /** Fired when liveness changes ("connecting" → "open" on subscribe → "live" after the first row). */
    onStatus?: (status: QaLiveStatus) => void;
    /** Fired after a disconnected stream opens again so persisted rows can be reconciled. */
    onReconnect?: () => void;
}

export interface QaSubscriptionHandle {
    close(): void;
}

/**
 * Opens a deduped QA subscription over the active client. Returns a handle whose `close()` tears the
 * underlying subscription down (and is idempotent). The contract's `subscribe` emits an
 * `EnrichedQaEntry` per the narrowed types, but the runtime payload is a full `QaRow` (see
 * queries.ts header) — we accept it as `QaRow` here.
 */
export function openQaSubscription(
    client: DashboardClient,
    callbacks: QaSubscriptionCallbacks,
): QaSubscriptionHandle {
    const seen = new Set<string>();
    let closed = false;
    let live = false;
    let opened = false;

    callbacks.onStatus?.("connecting");

    const sub = client.qa.subscribe(
        (entry) => {
            if (closed) {
                return;
            }

            const row = entry as QaRow;
            const id = row.id;

            if (id != null && seen.has(id)) {
                return;
            }

            if (id != null) {
                seen.add(id);
            }

            if (!live) {
                live = true;
                callbacks.onStatus?.("live");
            }

            callbacks.onRow(row);
        },
        {
            onOpen: () => {
                if (closed) {
                    return;
                }

                live = false;
                callbacks.onStatus?.("open");

                if (opened) {
                    callbacks.onReconnect?.();
                }

                opened = true;
            },
            onError: () => {
                if (!closed) {
                    callbacks.onStatus?.("down");
                }
            },
        }
    );

    return {
        close() {
            if (closed) {
                return;
            }

            closed = true;
            sub.close();
        },
    };
}
