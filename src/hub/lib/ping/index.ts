import { titleMatchKeys } from "@app/cmux/lib/title-match";
import { registerTask } from "@app/daemon/lib/register";
import { type FleetEntry, readFleetView } from "@genesiscz/utils/ai/live-sessions/fleet";
import { FLEET_PHASES } from "@genesiscz/utils/ai/live-sessions/phase";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { isObject } from "@genesiscz/utils/object";
import { type JsonDocument, jsonDocument } from "@genesiscz/utils/storage/locked-document";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { boardKey } from "../board/phases";

const log = logger.child({ component: "hub/ping" });

/** The daemon task that checks the watches once a minute. */
export const PING_TASK_NAME = "hub-ping-when-done";

/** Lines of the agent's last text the push carries. */
const PUSH_LINES = 3;

/** One "ping me when done" on an agent session, by its board key (`provider:sessionId`). */
export interface PingWatch {
    key: string;
    /** What the push names: the board title or the project, when the phone sent one. */
    label: string | null;
    /** ISO time the watch was set. */
    since: string;
}

export interface PingWatches {
    watches: PingWatch[];
}

function isWatch(value: unknown): value is PingWatch {
    return (
        isObject(value) &&
        typeof value.key === "string" &&
        typeof value.since === "string" &&
        (value.label === null || typeof value.label === "string")
    );
}

export function pingDocument(path = toolDataDir("hub", "ping-watches.json")): JsonDocument<PingWatches> {
    return jsonDocument<PingWatches>({
        path,
        empty: () => ({ watches: [] }),
        decode: (raw) => ({ watches: isObject(raw) && Array.isArray(raw.watches) ? raw.watches.filter(isWatch) : [] }),
        strictJson: true,
        onUnreadable: "discard",
    });
}

/** What a check decided for one watch: still running, or done with the push it sent. */
export interface PingOutcome {
    key: string;
    state: "running" | "done" | "gone";
    pushed: boolean;
    detail: string;
}

export interface PingDeps {
    document: JsonDocument<PingWatches>;
    fleet(): Promise<Pick<FleetEntry, "provider" | "sessionId" | "process" | "surface" | "label" | "lastText">[]>;
    push(input: { title: string; message: string; id: string }): Promise<boolean>;
    /** Registers the minute task on the first watch; tests pass a no-op. */
    schedule(): Promise<void>;
    now(): Date;
}

export function livePingDeps(): PingDeps {
    return {
        document: pingDocument(),
        fleet: () => readFleetView({ titleKeys: titleMatchKeys }),
        push: ({ title, message, id }) =>
            dispatchNotification({ app: "hub", title, message, id, group: "hub-ping", only: ["phone"] }),
        schedule: async () => {
            await registerTask({
                name: PING_TASK_NAME,
                command: toolCommand("hub ping check", "--json"),
                every: "every 1 minute",
                overwrite: false,
                notify: "failure",
                retries: 0,
                timeoutMs: 60_000,
                description: `Pushes to the phone when a watched agent turn ends (${toolCommand("hub ping")})`,
            });
        },
        now: () => new Date(),
    };
}

/** Watch one live session; a second watch on the same key keeps the first. */
export async function addPing(
    input: { key: string; label?: string | null },
    deps: PingDeps = livePingDeps()
): Promise<PingWatches> {
    const watches = await deps.document.mutate((doc) => {
        if (!doc.watches.some((watch) => watch.key === input.key)) {
            doc.watches.push({ key: input.key, label: input.label ?? null, since: deps.now().toISOString() });
        }

        return { watches: [...doc.watches] };
    });
    await deps.schedule();
    log.info({ key: input.key }, "ping watch set");
    return watches;
}

export async function removePing(key: string, deps: PingDeps = livePingDeps()): Promise<PingWatches> {
    return deps.document.mutate((doc) => {
        doc.watches = doc.watches.filter((watch) => watch.key !== key);
        return { watches: [...doc.watches] };
    });
}

export function listPings(deps: Pick<PingDeps, "document"> = livePingDeps()): PingWatches {
    return deps.document.read();
}

function lastLines(text: string | null): string {
    return (text ?? "").trim().split("\n").filter(Boolean).slice(-PUSH_LINES).join("\n");
}

/**
 * Checks every watch once: a session whose turn no longer runs (it waits, idles or was interrupted) or whose process is
 * gone gets one push to the phone with the agent's last lines, and its watch is removed. A stalled turn still counts as
 * running: it has not ended. Run by the `hub-ping-when-done` daemon task, because the phone's own streams die in the
 * background.
 */
export async function checkPings(deps: PingDeps = livePingDeps()): Promise<PingOutcome[]> {
    const { watches } = deps.document.read();

    if (watches.length === 0) {
        return [];
    }

    const fleet = await deps.fleet();
    const byKey = new Map(fleet.map((entry) => [boardKey(entry), entry]));
    const outcomes: PingOutcome[] = [];

    for (const watch of watches) {
        const entry = byKey.get(watch.key);
        const name = watch.label ?? watch.key;

        if (entry && (entry.label === "stalled" || (entry.label !== "unknown" && FLEET_PHASES[entry.label].running))) {
            outcomes.push({ key: watch.key, state: "running", pushed: false, detail: entry.label });
            continue;
        }

        const state = entry ? "done" : "gone";
        const title = state === "done" ? `Done: ${name}` : `Ended: ${name}`;
        const message =
            state === "done"
                ? lastLines(entry?.lastText ?? null) || `The turn ended (${entry?.label ?? "idle"}).`
                : "The session is no longer running.";
        const pushed = await deps.push({ title, message, id: `ping-${watch.key}-${watch.since}` });
        outcomes.push({ key: watch.key, state, pushed, detail: title });
    }

    const finished = new Set(outcomes.filter((outcome) => outcome.state !== "running").map((outcome) => outcome.key));

    if (finished.size > 0) {
        await deps.document.mutate((doc) => {
            doc.watches = doc.watches.filter((watch) => !finished.has(watch.key));
        });
        log.info({ finished: [...finished] }, "ping watches finished");
    }

    return outcomes;
}
