import { loadPins, type SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { loadAllSessionCmuxRefs, resolveRefsProvider, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import {
    type CmuxTree,
    type CmuxTreeDeps,
    type CmuxTreeSurface,
    fetchCmuxTree,
    mapCmuxTreeSurfaces,
} from "@genesiscz/utils/cmux/tree";
import { profiler } from "@genesiscz/utils/profile";

/**
 * The ` · 8b6e69bf` marker `paneTitle()` (src/claude/lib/cmux) puts at the end of every restored tab
 * title. Anchored at the end because that function truncates a long name and never the id, so the
 * marker is always the last thing in the title.
 */
export const TITLE_SHORT_ID_RE = /·\s*([0-9a-f]{8})\s*$/i;

/** A surface with the agent session the SessionStart journal places in it. */
export interface AgentCmuxSurface extends CmuxTreeSurface {
    sessionId: string | null;
    /** Which agent wrote the journal line; null for lines older than the tag (any agent). */
    provider: AccountProviderAlias | null;
    /** Short id from the surface title, when the journal has nothing. */
    sessionHint: string | null;
}

export type AgentCmuxTree = CmuxTree<AgentCmuxSurface>;

export interface AgentCmuxTreeOptions extends CmuxTreeDeps {
    /**
     * Keep only these agents' sessions. A journal line's agent is its tag, else its session's pin,
     * else the id shape (`resolveRefsProvider`); a line none of them can place is left out.
     */
    providers?: readonly AccountProviderAlias[];
    loadRefs?: () => Map<string, SessionCmuxRefs>;
    loadPins?: () => Promise<Map<string, SessionPin>>;
}

interface SurfaceSession {
    sessionId: string;
    provider: AccountProviderAlias | null;
}

type ProviderOf = (entry: SessionCmuxRefs) => AccountProviderAlias | undefined;

const prof = profiler.scope("cmux");

function keeps(
    provider: AccountProviderAlias | undefined,
    providers: readonly AccountProviderAlias[] | undefined
): boolean {
    if (!providers) {
        return true;
    }

    return provider !== undefined && providers.includes(provider);
}

/**
 * surfaceId AND surfaceRef both key the session, whichever form the RPC reports. Resuming a new
 * session in a tab that hosted an older one leaves both holding the same surface; map iteration
 * follows journal insertion order, not recency, so the newest line must win explicitly.
 */
function surfaceSessionIndex({
    refs,
    providers,
    providerOf,
}: {
    refs: Map<string, SessionCmuxRefs>;
    providers: readonly AccountProviderAlias[] | undefined;
    providerOf: ProviderOf;
}): Map<string, SurfaceSession> {
    const index = new Map<string, SurfaceSession>();
    const seenAt = new Map<string, number>();

    for (const [sessionId, entry] of refs) {
        const provider = providerOf(entry);

        if (!keeps(provider, providers)) {
            continue;
        }

        const at = entry.at ?? 0;

        for (const key of [entry.surfaceId, entry.surfaceRef]) {
            if (!key) {
                continue;
            }

            if (index.has(key) && (seenAt.get(key) ?? 0) >= at) {
                continue;
            }

            index.set(key, { sessionId, provider: provider ?? null });
            seenAt.set(key, at);
        }
    }

    return index;
}

/** The cmux tree with the agent session of each surface. */
export async function fetchAgentCmuxTree(options: AgentCmuxTreeOptions = {}): Promise<AgentCmuxTree> {
    const started = performance.now();
    const loadRefs = options.loadRefs ?? loadAllSessionCmuxRefs;
    const loadSessionPins = options.loadPins ?? (() => loadPins({ readOnly: true }));
    const [tree, refs, pins] = await Promise.all([
        fetchCmuxTree({ fetchSnapshot: options.fetchSnapshot }),
        Promise.resolve(prof.measure("tree.refs", loadRefs)),
        prof.measureAsync("tree.pins", loadSessionPins),
    ]);
    const bySurface = surfaceSessionIndex({
        refs,
        providers: options.providers,
        providerOf: (entry) => resolveRefsProvider(entry, pins.get(entry.sessionId)),
    });
    const annotated = mapCmuxTreeSurfaces(tree, (surface) => {
        const session = bySurface.get(surface.id);

        return {
            ...surface,
            sessionId: session?.sessionId ?? null,
            provider: session?.provider ?? null,
            sessionHint: surface.title.match(TITLE_SHORT_ID_RE)?.[1]?.toLowerCase() ?? null,
        };
    });

    return { ...annotated, totalMs: performance.now() - started };
}
