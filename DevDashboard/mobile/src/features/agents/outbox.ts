import type { AgentSendReceiptDto, AgentSendTiming } from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";
import Storage from "expo-sqlite/kv-store";

/**
 * The steer composer's offline drafts (F10). A message the phone could not hand to the Mac (no network, the Mac
 * unreachable) is kept here with its idempotency key and sent again on reconnect. The key travels with every retry,
 * and the Mac keys both its replay cache and the durable session queue on it, so a draft sent twice is one delivery.
 */
export interface SteerDraft {
    /** Missing on legacy drafts whose destination is unknown; never replay those automatically. */
    connectionId?: string;
    /** A refusal or uncertain delivery needs explicit user action, never automatic replay. */
    blocked?: boolean;
    /** The idempotency key of every attempt. */
    id: string;
    /** The board key of the session. */
    key: string;
    text: string;
    timing: AgentSendTiming;
    createdAt: number;
    attempts: number;
    /** Why the last attempt did not reach the Mac. */
    lastError: string | null;
}

export interface DraftStore {
    read(): Promise<SteerDraft[]>;
    write(drafts: SteerDraft[]): Promise<void>;
}

const STORE_KEY = "dd.steerOutbox";

function isDraft(value: unknown): value is SteerDraft {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const field = (name: string): unknown => Reflect.get(value, name);
    const timing = field("timing");
    return (
        typeof field("id") === "string" &&
        typeof field("key") === "string" &&
        typeof field("text") === "string" &&
        (timing === "now" || timing === "next-turn" || timing === "later")
    );
}

/** The drafts in the phone's key-value store; an unreadable value reads as no drafts. */
export const kvDraftStore: DraftStore = {
    async read() {
        const raw = await Storage.getItem(STORE_KEY);

        if (raw === null) {
            return [];
        }

        try {
            const parsed: unknown = SafeJSON.parse(raw, { strict: true });
            return Array.isArray(parsed) ? parsed.filter(isDraft) : [];
        } catch {
            return [];
        }
    },
    async write(drafts) {
        await Storage.setItem(STORE_KEY, SafeJSON.stringify(drafts));
    },
};

/**
 * Whether a failed send never reached the Mac's answer: a network failure, a timeout, or a gateway that is down
 * (502, 503, 504). Any other HTTP answer is the Mac's verdict on the message, and sending it again changes nothing.
 */
export function isOfflineError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const status = /-> (\d{3}):/.exec(message)?.[1];

    if (!status) {
        return true;
    }

    return status === "502" || status === "503" || status === "504";
}

export interface FlushResult {
    /** Drafts the Mac answered, with its receipt; they leave the outbox. */
    sent: { draft: SteerDraft; receipt: AgentSendReceiptDto }[];
    /** Drafts the Mac refused at the HTTP level; they leave the outbox with the error. */
    failed: { draft: SteerDraft; error: string }[];
    /** Drafts still waiting for the Mac. */
    waiting: SteerDraft[];
}

/**
 * Sends every waiting draft once, oldest first, and stores what is still waiting. A draft is never sent while
 * another flush runs (`flushing` guard in the hook), and each attempt reuses the draft's key.
 */
export async function flushDrafts({
    store,
    send,
    connectionId,
}: {
    store: DraftStore;
    connectionId: string;
    send: (draft: SteerDraft) => Promise<AgentSendReceiptDto>;
}): Promise<FlushResult> {
    const drafts = (await store.read()).filter((draft) => draft.connectionId === connectionId && !draft.blocked)
        .sort((a, b) => a.createdAt - b.createdAt);
    const result: FlushResult = { sent: [], failed: [], waiting: [] };

    for (const draft of drafts) {
        try {
            const receipt = await send(draft);
            if (receipt.outcome === "refused" || receipt.outcome === "unknown") {
                const error = receipt.outcome === "unknown"
                    ? `Check the session before retrying: ${receipt.detail}`
                    : receipt.detail;
                result.failed.push({ draft, error });
                result.waiting.push({ ...draft, blocked: true, lastError: error, attempts: draft.attempts + 1 });
                continue;
            }

            result.sent.push({ draft, receipt });
        } catch (error) {
            if (isOfflineError(error)) {
                result.waiting.push({ ...draft, attempts: draft.attempts + 1, lastError: String(error) });
                continue;
            }

            result.failed.push({ draft, error: error instanceof Error ? error.message : String(error) });
            result.waiting.push({ ...draft, blocked: true, lastError: String(error), attempts: draft.attempts + 1 });
        }
    }

    // Drafts added while this flush ran are kept as they are.
    const handled = new Set(drafts.map((draft) => draft.id));
    await updateDrafts(store, (current) => [
        ...result.waiting.filter((draft) => current.some((entry) => entry.id === draft.id)),
        ...current.filter((draft) => !handled.has(draft.id)),
    ]);
    return result;
}

const writes = new WeakMap<DraftStore, Promise<void>>();

/** Serialize each store's read/modify/write so concurrent composers cannot overwrite one another. */
export function updateDrafts(store: DraftStore, update: (current: SteerDraft[]) => SteerDraft[]): Promise<void> {
    const run = async () => { await store.write(update(await store.read())); };
    const pending = (writes.get(store) ?? Promise.resolve()).then(run, run);
    writes.set(store, pending);
    return pending;
}

export async function addDraft(store: DraftStore, draft: SteerDraft): Promise<void> {
    await updateDrafts(store, (drafts) => [...drafts.filter((entry) => entry.id !== draft.id), draft]);
}

export async function removeDraft(store: DraftStore, id: string): Promise<void> {
    await updateDrafts(store, (drafts) => drafts.filter((draft) => draft.id !== id));
}

/** A memory store, for tests and the fixture app. */
export function memoryDraftStore(initial: SteerDraft[] = []): DraftStore {
    let drafts = [...initial];
    return {
        read: async () => [...drafts],
        write: async (next) => {
            drafts = [...next];
        },
    };
}
