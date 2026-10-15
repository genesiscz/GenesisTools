import { homedir } from "node:os";
import { getSessionListing } from "@app/claude/lib/history/search";
import type { Profile } from "@app/cmux/lib/types";
import { grokSessionsRoot } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { createNativeHistoryAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import { loadPins } from "@genesiscz/utils/agent-sessions/pins";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";

/** The Claude, Grok and Codex sessions a restore may resume, read from each agent's history for the tabs' folders. */
export interface ReplayCatalogSession {
    kind: AgentKind;
    sessionId: string;
    cwd: string;
    title: string;
    account?: string | null;
    /** First user prompt; used when Claude Code never stored a customTitle. */
    prompt?: string | null;
}

export interface ReplayCatalog {
    sessions: ReplayCatalogSession[];
}

async function loadNativeCatalog(options: {
    kind: "codex" | "grok";
    cwds: string[];
    roots: string[];
    /** Read only what is already indexed. The rescue path must not sync or write. */
    cached?: boolean;
}): Promise<ReplayCatalogSession[]> {
    const unique = new Set(options.cwds.filter((cwd) => cwd.length > 0));
    if (unique.size === 0) {
        return [];
    }

    const adapter = createNativeHistoryAdapter({ kind: options.kind, roots: options.roots });
    const sessions =
        options.cached && adapter.listCached
            ? await adapter.listCached({ all: true })
            : await adapter.list({ all: true });
    return sessions
        .filter((session) => unique.has(session.cwd))
        .map((session) => ({
            kind: options.kind,
            sessionId: session.sessionId,
            cwd: session.cwd,
            title: session.title,
            prompt: session.prompt,
        }));
}

export function loadGrokCatalog(
    cwds: string[],
    sessionsRoot: string = grokSessionsRoot(),
    options: { cached?: boolean } = {}
): Promise<ReplayCatalogSession[]> {
    return loadNativeCatalog({ kind: "grok", cwds, roots: [sessionsRoot], cached: options.cached });
}

export function loadCodexCatalog(
    cwds: string[],
    roots: string[] = nativeSessionRoots("codex", homedir()),
    options: { cached?: boolean } = {}
): Promise<ReplayCatalogSession[]> {
    return loadNativeCatalog({ kind: "codex", cwds, roots, cached: options.cached });
}

/** Read Claude replay candidates and account pins; cached mode avoids native history discovery and refresh. */
export async function loadClaudeCatalog(options: { cached?: boolean } = {}): Promise<ReplayCatalogSession[]> {
    const pins = await loadPins({ readOnly: true });
    const out: ReplayCatalogSession[] = [];
    const records = options.cached
        ? ((await createNativeHistoryAdapter({ kind: "claude" }).listCached?.({ all: true })) ?? []).map((session) => ({
              sessionId: session.sessionId,
              cwd: session.cwd,
              customTitle: session.title,
              summary: undefined,
              firstPrompt: session.prompt,
          }))
        : (await getSessionListing({ excludeSubagents: true })).sessions;

    for (const record of records) {
        // The cached index also lists subagent transcripts, whose id is a path
        // (`<project>/<parent>/subagents/agent-…`). `claude --resume` cannot open
        // one, and `--list` printed it as a pane's resume target.
        if (!record.sessionId || !record.cwd || record.sessionId.includes("/")) {
            continue;
        }

        const pin = pins.get(record.sessionId);
        const title = record.customTitle || record.summary || "";
        out.push({
            kind: "claude",
            sessionId: record.sessionId,
            cwd: record.cwd,
            title: title || record.sessionId.slice(0, 8),
            account: pin?.account ?? undefined,
            prompt: record.firstPrompt ?? undefined,
        });
    }

    return out;
}

export function collectProfileCwds(profile: Profile): string[] {
    const cwds: string[] = [];

    for (const window of profile.windows) {
        for (const workspace of window.workspaces) {
            if (workspace.current_directory) {
                cwds.push(workspace.current_directory);
            }

            for (const pane of workspace.panes) {
                for (const surface of pane.surfaces) {
                    if (surface.type === "terminal" && surface.cwd) {
                        cwds.push(surface.cwd);
                    }
                }
            }
        }
    }

    return cwds;
}

/**
 * `cached` reads only what is already indexed, for callers that report a plan without carrying it
 * out (`--dry-run`, `--list`). An ordinary restore refreshes the catalog first, which initializes
 * the shared history schema and synchronizes source metadata — durable writes a preview must not
 * make. The cost is that a preview can name fewer resume commands than the run it previews.
 */
export async function loadReplayCatalog(profile: Profile, options: { cached?: boolean } = {}): Promise<ReplayCatalog> {
    const cwds = collectProfileCwds(profile);
    const [grok, claude, codex] = await Promise.all([
        loadGrokCatalog(cwds, grokSessionsRoot(), { cached: options.cached }),
        loadClaudeCatalog({ cached: options.cached }),
        loadCodexCatalog(cwds, nativeSessionRoots("codex", homedir()), { cached: options.cached }),
    ]);

    return { sessions: [...grok, ...claude, ...codex] };
}
