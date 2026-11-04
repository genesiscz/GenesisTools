import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { type ResolvedTranscript, resolveTranscripts } from "@genesiscz/utils/ai/transcripts/resolve";
import { type LiveActivity, liveActivityOf, readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";
import type { TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state-types";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { type LiveSessionRow, type LocateOptions, locateLiveSessions } from "./locate";
import { type FleetPhase, type FleetPhaseLabel, fleetPhaseLabel } from "./phase";

const log = logger.child({ component: "live-sessions" });

/** Why a running turn may need rescue, from the hub's stuck verdict (a call that waits too long, or a loop). */
export interface FleetStuck {
    kind: string;
    detail: string;
}

/**
 * The stuck verdict for one running session. The verdict reads the hub's thresholds and the transcript's turns, so the
 * hub passes it in (`src/hub/lib/insights`); without it, `stalled` comes from transcript silence alone.
 */
export type FleetStuckCheck = (input: {
    row: LiveSessionRow;
    transcript: ResolvedTranscript;
}) => Promise<FleetStuck | null>;

export interface FleetEntry extends LiveSessionRow {
    /** Null when the session has no readable transcript. */
    phase: FleetPhase | null;
    /** A running turn (`thinking` or `tool`) that went silent for `LIVE_STALL_MS`, or that the stuck verdict flags. */
    stalled: boolean;
    /** The word a fleet reader prints, from `FLEET_PHASES`. */
    label: FleetPhaseLabel;
    activity: LiveActivity | null;
    stuck: FleetStuck | null;
    transcript: ResolvedTranscript | null;
    /** The newest turn's last assistant text, and when the transcript was last written (epoch ms). */
    lastText: string | null;
    lastActivityAt: number | null;
}

/** The phase of one session from its transcript: `liveActivityOf` over a snapshot read with no stall limit. */
export function readLivePhase(input: {
    provider: AccountProviderAlias;
    filePath: string;
    now?: number;
}): { snapshot: TurnSnapshot; activity: LiveActivity } | null {
    const snapshot = readTurnState(input.provider, input.filePath, {
        stallTimeoutMs: Number.POSITIVE_INFINITY,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return snapshot ? { snapshot, activity: liveActivityOf(snapshot) } : null;
}

/** Composes one row with its transcript's phase and the stuck verdict. */
export async function fleetEntryOf(input: {
    row: LiveSessionRow;
    transcript: ResolvedTranscript | null;
    now?: number;
    stuck?: FleetStuckCheck;
}): Promise<FleetEntry> {
    const { row, transcript } = input;
    const read = transcript
        ? readLivePhase({ provider: transcript.provider, filePath: transcript.filePath, now: input.now })
        : null;
    const activity = read?.activity ?? null;
    let stuck: FleetStuck | null = null;

    if (activity && transcript && input.stuck && (activity.phase === "thinking" || activity.phase === "tool")) {
        try {
            stuck = await input.stuck({ row, transcript });
        } catch (error) {
            log.debug({ error, sessionId: row.sessionId }, "stuck verdict unavailable");
        }
    }

    const phase = activity?.phase ?? null;
    const stalled = (activity?.stalled ?? false) || stuck !== null;
    return {
        ...row,
        phase,
        stalled,
        label: fleetPhaseLabel({ phase, stalled }),
        activity,
        stuck,
        transcript,
        lastText: read?.snapshot.lastText || null,
        lastActivityAt: read?.snapshot.lastActivityAt ?? null,
    };
}

export interface FleetViewOptions extends LocateOptions {
    now?: number;
    stuck?: FleetStuckCheck;
    /** Rows from a locate the caller already ran this refresh. */
    rows?: LiveSessionRow[];
}

/** The transcript of each row that names a session, resolved per provider in one batch. */
async function transcriptsOf(rows: readonly LiveSessionRow[]): Promise<Map<LiveSessionRow, ResolvedTranscript>> {
    const found = new Map<LiveSessionRow, ResolvedTranscript>();
    const byProvider = new Map<AccountProviderAlias, LiveSessionRow[]>();

    for (const row of rows) {
        if (row.sessionId || row.transcriptPath) {
            byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row]);
        }
    }

    for (const [provider, group] of byProvider) {
        const queries = group.map((row) => row.transcriptPath ?? row.sessionId ?? "");
        const resolved = await resolveTranscripts(queries, {}, provider);

        for (const row of group) {
            const hit = resolved.get(row.transcriptPath ?? row.sessionId ?? "");

            if (hit instanceof Error || hit === undefined) {
                log.debug({ sessionId: row.sessionId, provider, error: hit }, "no transcript for a live session");
                continue;
            }

            found.set(row, hit);
        }
    }

    return found;
}

/**
 * Every live session with what it does now: the locator's rows, each with its phase, stall flag and label. A
 * DIAGNOSTIC: it reads the process table, cmux, the journal, the pins and each transcript's tail, and writes nothing.
 */
export async function readFleetView(options: FleetViewOptions = {}): Promise<FleetEntry[]> {
    const rows = options.rows ?? (await locateLiveSessions(options));
    const transcripts = await transcriptsOf(rows);
    const entries = await concurrentMap({
        items: rows,
        concurrency: 4,
        fn: (row) =>
            fleetEntryOf({ row, transcript: transcripts.get(row) ?? null, now: options.now, stuck: options.stuck }),
    });
    return rows.flatMap((row) => {
        const entry = entries.get(row);
        return entry ? [entry] : [];
    });
}
