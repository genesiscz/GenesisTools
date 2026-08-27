import { aliasesForSession, type FocusTarget, findFocusTargets, matchingSession } from "@app/claude/lib/cmux/focus";
import { lookupSessionCmuxRefs, type SessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import {
    type CmuxLiveSnapshot,
    fetchCmuxLiveSnapshot,
    type SnapshotPreviewMode,
} from "@genesiscz/utils/cmux/lib/live-snapshot";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("claude-cmux-resolve");

export interface CmuxIdentity {
    bundle_identifier?: string;
    caller?: { window_ref?: string; pane_ref?: string; surface_ref?: string };
}

/** Where a resolution came from, cheapest first. */
export type SessionTargetSource = "recorded" | "titles" | "deep" | "deep-all" | "cwd" | "screen" | "none";

/** Sources that do not prove the pane IS the session. Callers that type must not trust these blindly. */
export const SOFT_SOURCES: ReadonlySet<SessionTargetSource> = new Set<SessionTargetSource>(["cwd", "screen"]);

export interface SessionTargetsResult {
    targets: FocusTarget[];
    source: SessionTargetSource;
    identity?: CmuxIdentity;
    /** Last snapshot fetched, when a matcher stage ran. */
    snapshot?: CmuxLiveSnapshot;
    /** cmux unreachable: the error text, or false when it was reachable. */
    unavailable: string | false;
}

export interface ResolveDeps {
    fetchSnapshot?: (previews: SnapshotPreviewMode) => Promise<CmuxLiveSnapshot>;
    identify?: () => Promise<CmuxIdentity | undefined>;
    lookupSession?: (query: string) => Promise<{ aliases: string[]; sessionId: string | null; cwd?: string | null }>;
    lookupRefs?: (query: string) => SessionCmuxRefs | null;
}

export interface FindSessionTargetsOpts {
    includeSelf?: boolean;
    /** Skip the hook-recorded shortcut — the retry path after stale refs failed. */
    skipRecorded?: boolean;
    deps?: ResolveDeps;
}

/** A session id (or prefix) as `focus`/`send` accept it. */
export const SESSION_ID_QUERY = /^[0-9a-f-]{8,}$/i;

/**
 * Match kinds that actually prove "this pane IS the session" for a UUID query.
 *
 * `screen` in particular is ambiguous: it fires when the id merely appears
 * somewhere in a pane's text, which is also true of any agent pane that has
 * discussed that session. It is still often the ONLY signal a pre-hook session
 * leaves, so it is kept as a labelled last resort rather than dropped, and
 * `send` refuses to type into it when more than one pane matches.
 */
const ID_EVIDENCE_KINDS = new Set([
    "recorded",
    "resume-command",
    "resume-prefix",
    "title-id",
    "session-id",
    "id-prefix",
    "session-name",
    "pane-title",
]);

function recordedTarget(refs: SessionCmuxRefs): FocusTarget | null {
    // UUIDs from the launch env survive cmux ref renumbering, so prefer them;
    // a dead UUID makes the action fail fast and the caller retries the matcher.
    const workspaceId = refs.workspaceId ?? refs.workspaceRef;
    const surfaceId = refs.surfaceId ?? refs.surfaceRef;

    if (!workspaceId || !surfaceId) {
        return null;
    }

    return {
        workspaceId,
        workspaceName: refs.workspaceRef ?? workspaceId,
        paneId: refs.paneRef ?? "",
        paneTitle: refs.paneRef ?? "",
        cwd: refs.cwd ?? undefined,
        windowRef: refs.windowRef ?? undefined,
        surfaceId,
        sessionIds: [refs.sessionId.toLowerCase()],
        matchedOn: "recorded",
        score: 100,
        active: false,
    };
}

/**
 * Panes for a session query, staged cheapest-first:
 *
 * 1. `recorded` — the genesis-tools hook journals each session's cmux surface
 *    (SessionStart + UserPromptSubmit), so a fresh untitled session resolves
 *    instantly and without any text matching. Never excludes the caller: the
 *    journal is ground truth and self-sends (keepalive) are legitimate.
 * 2. `titles` — tab-title pass with no pane captures (~0.4 s).
 * 3. `deep` — selected-surface captures (~0.6 s), catches `--resume <id>`
 *    still in a visible viewport.
 * 4. `deep-all` — every surface captured, catches background tabs (~1-3 s).
 *
 * Non-id queries keep the single selected-previews pass `focus` always used.
 */
export async function findSessionTargets(
    query: string,
    opts: FindSessionTargetsOpts = {}
): Promise<SessionTargetsResult> {
    const deps = opts.deps ?? {};
    const queryTrim = query.trim();
    const sessionQuery = SESSION_ID_QUERY.test(queryTrim);

    const fetchSnapshot =
        deps.fetchSnapshot ?? ((previews: SnapshotPreviewMode) => fetchCmuxLiveSnapshot({ previews }));
    const identify =
        deps.identify ??
        (async (): Promise<CmuxIdentity | undefined> => {
            try {
                return await runCmuxJSON<CmuxIdentity>(["identify"]);
            } catch (err) {
                log.debug({ err }, "could not identify the calling pane; searching every pane");
                return undefined;
            }
        });
    const lookupSession =
        deps.lookupSession ??
        (async (q: string) => {
            const { getSessionListing } = await import("@app/claude/lib/history/search");
            const listing = await getSessionListing({ excludeSubagents: true });
            const record = matchingSession(q, listing.sessions);
            // `matchingSession` narrows to the title fields, so read the cwd off
            // the listing record it came from.
            const full = record?.sessionId
                ? listing.sessions.find((session) => session.sessionId === record.sessionId)
                : undefined;
            return {
                aliases: aliasesForSession(q, listing.sessions),
                sessionId: record?.sessionId ?? null,
                cwd: full?.cwd ?? null,
            };
        });
    const lookupRefs = deps.lookupRefs ?? lookupSessionCmuxRefs;

    const identityPromise = identify();

    if (sessionQuery && !opts.skipRecorded) {
        const refs = lookupRefs(queryTrim);
        const target = refs ? recordedTarget(refs) : null;

        if (target) {
            return { targets: [target], source: "recorded", identity: await identityPromise, unavailable: false };
        }
    }

    const [identity, resolved] = await Promise.all([
        identityPromise,
        sessionQuery
            ? lookupSession(queryTrim)
            : Promise.resolve({ aliases: [], sessionId: null, cwd: null as string | null }),
    ]);
    // Exclude the caller's own TAB, not its whole pane: sibling tabs in the
    // same pane are legitimate targets, and the query is only echoed on this
    // one surface. Falls back to the pane when cmux reports no surface ref.
    const callerSurface = identity?.caller?.surface_ref;
    const excludeSurfaceId = opts.includeSelf ? undefined : callerSurface;
    const excludePaneId = opts.includeSelf || callerSurface ? undefined : identity?.caller?.pane_ref;
    const stages: { previews: SnapshotPreviewMode; source: SessionTargetSource }[] = sessionQuery
        ? [
              { previews: "none", source: "titles" },
              { previews: "selected", source: "deep" },
              { previews: "all", source: "deep-all" },
          ]
        : [{ previews: "selected", source: "titles" }];

    let snapshot: CmuxLiveSnapshot | undefined;
    /** Weak hits from the deepest stage that produced any, used only if nothing stronger appears. */
    let soft: FocusTarget[] = [];

    for (const stage of stages) {
        snapshot = await fetchSnapshot(stage.previews);

        if (!snapshot.available) {
            return {
                targets: [],
                source: "none",
                identity,
                snapshot,
                unavailable: snapshot.error ?? "cmux is not reachable",
            };
        }

        const found = findFocusTargets(snapshot, queryTrim, {
            excludePaneId,
            excludeSurfaceId,
            aliases: resolved.aliases,
            resolvedSessionId: resolved.sessionId ?? undefined,
        });
        const targets = sessionQuery ? found.filter((target) => ID_EVIDENCE_KINDS.has(target.matchedOn)) : found;

        if (sessionQuery && targets.length === 0 && found.length > 0) {
            soft = found;
        }

        if (targets.length > 0) {
            return { targets, source: stage.source, identity, snapshot, unavailable: false };
        }
    }

    // Last resort for a session that predates the hook and shows its id
    // nowhere: the panes sitting in that session's working directory. Weak by
    // construction — several panes can share one repo — so callers that TYPE
    // into the result must refuse an ambiguous cwd match (see `send`).
    if (sessionQuery && snapshot && resolved.cwd) {
        // Only genuine directory hits: searching a path string would otherwise
        // also match any pane that merely printed that path.
        const targets = findFocusTargets(snapshot, resolved.cwd, { excludePaneId, excludeSurfaceId }).filter(
            (target) => target.matchedOn === "cwd"
        );

        if (targets.length > 0) {
            return { targets, source: "cwd", identity, snapshot, unavailable: false };
        }
    }

    if (soft.length > 0) {
        return { targets: soft, source: "screen", identity, snapshot, unavailable: false };
    }

    return { targets: [], source: "none", identity, snapshot, unavailable: false };
}

/**
 * The outcome of a stale-ref retry.
 *
 * `stopped` means the caller's ambiguity gate already reported and set an exit
 * code, so the command must return without printing anything else.
 */
export type StaleRefRetry =
    | { status: "empty"; result: SessionTargetsResult }
    | { status: "stopped"; result: SessionTargetsResult }
    | { status: "ok"; result: SessionTargetsResult; target: FocusTarget };

/**
 * Re-resolve a session's panes after its recorded refs turned out to be stale.
 *
 * The recorded shortcut is skipped on this pass, so the matcher can return
 * several panes exactly like a first pass can. `chooseTarget` is therefore a
 * required argument and not an option: both commands used to read `targets[0]`
 * straight off the retry, `send` grew its own guard afterwards and `focus` did
 * not, so a cmux restart made `focus` raise an arbitrary pane. Owning the retry
 * here is what keeps the two contracts from drifting apart again.
 */
export async function retryAfterStaleRefs(
    query: string,
    opts: FindSessionTargetsOpts,
    chooseTarget: (result: SessionTargetsResult) => Promise<FocusTarget | null>
): Promise<StaleRefRetry> {
    const result = await findSessionTargets(query, { ...opts, skipRecorded: true });

    if (result.targets.length === 0) {
        return { status: "empty", result };
    }

    const target = await chooseTarget(result);

    return target ? { status: "ok", result, target } : { status: "stopped", result };
}
