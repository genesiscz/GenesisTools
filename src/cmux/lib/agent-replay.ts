import { homedir } from "node:os";
import { loadPins } from "@app/claude/lib/cmux/pins";
import { getSessionListing } from "@app/claude/lib/history/search";
import {
    agentKindFromLauncher,
    deriveReplayCommand,
    isAgentLauncher,
    resumeTargetFromCommand,
} from "@app/cmux/lib/command-capture";
import type { Profile, Surface, TerminalSurface } from "@app/cmux/lib/types";
import { grokSessionsRoot } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { createNativeHistoryAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import { resumeCommandLine } from "@genesiscz/utils/agent-sessions/resume-argv";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";

export type { AgentKind };

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

const SPINNER_PREFIX = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳⠐●○◐◑◒◓]\s*/u;

export function inferLauncherFromTitle(title: string): AgentKind | undefined {
    if (/\s-\s+grok\b/i.test(title) || /\bgrok\s*$/i.test(title.trim())) {
        return "grok";
    }

    if (/\s-\s+codex\b/i.test(title) || /\bcodex\s*$/i.test(title.trim())) {
        return "codex";
    }

    if (/^[✳⠐◐◑◒◓]/.test(title.trim())) {
        return "claude";
    }

    return undefined;
}

function stripGrokSuffix(title: string): string {
    return title.replace(/\s+-\s+grok(?:\s+·\s+[0-9a-f]{7,8})?\s*$/i, "").trim();
}

function stripCodexSuffix(title: string): string {
    return title.replace(/\s+-\s+codex(?:\s+·\s+[0-9a-f]{7,8})?\s*$/i, "").trim();
}

function stripClaudeGlyph(title: string): string {
    return title
        .replace(SPINNER_PREFIX, "")
        .replace(/\s+·\s+[0-9a-f]{7,8}\s*$/i, "")
        .trim();
}

function stripEllipsis(value: string): string {
    return value.replace(/(\u2026|\.{2,}|…)+$/u, "").trim();
}

/** Keys to try against a generated session title, most specific first. */
export function titleMatchKeys(title: string, kind: AgentKind): string[] {
    const base =
        kind === "grok" ? stripGrokSuffix(title) : kind === "codex" ? stripCodexSuffix(title) : stripClaudeGlyph(title);
    const stripped = stripEllipsis(base.replace(SPINNER_PREFIX, "").trim());
    const parts = stripped
        .split(/\s+-\s+/)
        .map((part) => stripEllipsis(part).toLowerCase())
        .filter((part) => part.length >= 4);
    const full = stripped.toLowerCase();
    const keys = [...parts].reverse();

    if (full.length >= 4) {
        keys.push(full);
    }

    return [...new Set(keys)];
}

function sessionMatchesKey(session: ReplayCatalogSession, key: string): boolean {
    const title = session.title.trim().toLowerCase();
    if (!key) {
        return false;
    }

    if (title === key) {
        return true;
    }

    if (key.length >= 12 && title.startsWith(key)) {
        return true;
    }

    const prompt = session.prompt?.toLowerCase() ?? "";
    if (!prompt) {
        return false;
    }

    const words = key.split(/\s+/).filter((word) => word.length >= 4);
    if (words.length < 2) {
        return false;
    }

    return prompt.includes(words.slice(0, 2).join(" "));
}

function pickUnique(hits: ReplayCatalogSession[]): ReplayCatalogSession | undefined {
    if (hits.length === 1) {
        return hits[0];
    }

    if (hits.length === 0) {
        return undefined;
    }

    const ids = new Set(hits.map((hit) => hit.sessionId));
    if (ids.size === 1) {
        return hits[0];
    }

    return undefined;
}

export function matchGrokSession(
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[]
): ReplayCatalogSession | undefined {
    return matchAgentSession("grok", title, cwd, sessions);
}

export function matchClaudeSession(
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[]
): ReplayCatalogSession | undefined {
    return matchAgentSession("claude", title, cwd, sessions);
}

export function matchCodexSession(
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[]
): ReplayCatalogSession | undefined {
    return matchAgentSession("codex", title, cwd, sessions);
}

function matchAgentSession(
    kind: AgentKind,
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[]
): ReplayCatalogSession | undefined {
    if (inferLauncherFromTitle(title) !== kind) {
        return undefined;
    }

    const keys = titleMatchKeys(title, kind);
    const pool = sessions.filter((session) => session.kind === kind);
    const inCwd = cwd ? pool.filter((session) => session.cwd === cwd) : pool;

    for (const key of keys) {
        const local = pickUnique(inCwd.filter((session) => sessionMatchesKey(session, key)));
        if (local) {
            return local;
        }
    }

    if (cwd) {
        for (const key of keys) {
            const global = pickUnique(pool.filter((session) => sessionMatchesKey(session, key)));
            if (global) {
                return global;
            }
        }
    }

    return undefined;
}

function inferredResumeCommand(hit: ReplayCatalogSession): string {
    return resumeCommandLine(hit.kind, hit.sessionId, hit.account);
}

/**
 * The session the saved command already resumes, as a catalog entry.
 *
 * Snapshot resolves each pane's session from the cmux surface journal and pins
 * it into the command. Restore reads a profile file, which stores no surface
 * uuid, so that pinned id is the only journal evidence left for the pane.
 * Without it every restore fell back to fuzzy title/prompt matching and could
 * splice a different session's id into the terminal.
 */
function pinnedSessionForSurface(
    surface: Pick<TerminalSurface, "title" | "cwd" | "command">
): ReplayCatalogSession | undefined {
    const command = surface.command?.trim();

    if (!command) {
        return undefined;
    }

    const kind = agentKindFromLauncher(command);
    const sessionId = resumeTargetFromCommand(command);

    if (!kind || !sessionId) {
        return undefined;
    }

    return { kind, sessionId, cwd: surface.cwd ?? "", title: surface.title };
}

export function replayCommandForSurface(
    surface: Pick<TerminalSurface, "title" | "cwd" | "command" | "command_source">,
    catalog: ReplayCatalog,
    preferred?: ReplayCatalogSession
): { command?: string; drift: string[] } {
    const captured = surface.command?.trim();
    const titleLauncher = inferLauncherFromTitle(surface.title);
    const capturedKind = captured ? agentKindFromLauncher(captured) : undefined;
    const trusted = surface.command_source === "shell-journal";
    const launcher = trusted ? capturedKind : titleLauncher;
    if (trusted && captured && !isAgentLauncher(captured)) {
        return { command: surface.command, drift: [] };
    }
    // A crash capture often attributes the surviving grok tty to a Claude tab.
    // The tab title is the identity; a mismatched launcher is discarded.
    const original = captured && capturedKind && launcher && capturedKind !== launcher ? undefined : captured;

    if (original && !isAgentLauncher(original)) {
        return { command: original, drift: [] };
    }

    // What kind of agent this pane actually shows. With neither an agent title
    // nor an agent launcher on the tty there is no evidence any agent runs here,
    // and `preferred` (a journal entry that can be a week old) must not
    // synthesise a resume command for what is now a plain shell.
    const kind = launcher ?? capturedKind;

    // The journal knows THIS surface's own session id, so it beats a fuzzy
    // title/prompt match against every session on the machine. It is trusted
    // only for the kind of agent the pane shows: a claude journal id typed into
    // `grok -r` names a session grok has never seen.
    const journal = kind && preferred?.kind === kind ? preferred : undefined;
    const hit =
        journal ??
        (kind === "grok" ? matchGrokSession(surface.title, surface.cwd, catalog.sessions) : undefined) ??
        (kind === "claude" ? matchClaudeSession(surface.title, surface.cwd, catalog.sessions) : undefined) ??
        (kind === "codex" ? matchCodexSession(surface.title, surface.cwd, catalog.sessions) : undefined);

    if (!hit) {
        if (original && kind) {
            // Say it, do not hide it: replaying a bare launcher opens a NEW
            // session and paints the old screen over it.
            return {
                command: original,
                drift: [`no ${kind} session id resolved for this pane; restore starts a NEW ${kind} session`],
            };
        }

        if (original) {
            return { command: original, drift: [] };
        }

        return { command: undefined, drift: [] };
    }

    if (original && isAgentLauncher(original)) {
        return deriveReplayCommand({ original, sessionId: hit.sessionId, account: hit.account ?? undefined });
    }

    if (hit.kind === "grok" || hit.kind === "codex") {
        return deriveReplayCommand({ original: hit.kind, sessionId: hit.sessionId });
    }

    const source = hit === journal ? "the session journal for this pane" : `tab title "${hit.title}"`;

    return {
        command: inferredResumeCommand(hit),
        drift: [`inferred ${hit.kind} resume ${hit.sessionId} from ${source}`],
    };
}

export function withInferredReplayCommands(profile: Profile, catalog: ReplayCatalog): Profile {
    return {
        ...profile,
        windows: profile.windows.map((window) => ({
            ...window,
            workspaces: window.workspaces.map((workspace) => ({
                ...workspace,
                panes: workspace.panes.map((pane) => ({
                    ...pane,
                    surfaces: pane.surfaces.map((surface) => {
                        if (surface.type !== "terminal") {
                            return surface;
                        }

                        if (
                            (surface.resume ||
                                (surface.command_source === "shell-journal" &&
                                    (!isAgentLauncher(surface.command ?? "") ||
                                        resumeTargetFromCommand(surface.command ?? "")))) &&
                            surface.command
                        ) {
                            return surface;
                        }

                        const resolved = replayCommandForSurface(surface, catalog, pinnedSessionForSurface(surface));
                        if (!resolved.command) {
                            const launcher = inferLauncherFromTitle(surface.title);
                            const saved = surface.command?.trim();
                            if (launcher && saved && isAgentLauncher(saved)) {
                                const savedKind = agentKindFromLauncher(saved);
                                if (savedKind !== launcher) {
                                    return {
                                        ...surface,
                                        command: undefined,
                                        command_original: saved,
                                        command_source: undefined,
                                        drift: [`discarded stale ${savedKind} capture on a ${launcher} tab`],
                                    };
                                }
                            }

                            return surface;
                        }

                        if (resolved.command === surface.command) {
                            return resolved.drift.length > 0 ? { ...surface, drift: resolved.drift } : surface;
                        }

                        return {
                            ...surface,
                            command: resolved.command,
                            command_source: surface.command ? surface.command_source : "inferred",
                            command_original: surface.command,
                            drift: resolved.drift.length > 0 ? resolved.drift : surface.drift,
                        };
                    }),
                })),
            })),
        })),
    };
}

function mapTerminalSurfaces(profile: Profile, map: (surface: TerminalSurface, path: string) => Surface): Profile {
    return {
        ...profile,
        windows: profile.windows.map((window, w) => ({
            ...window,
            workspaces: window.workspaces.map((workspace, ws) => ({
                ...workspace,
                panes: workspace.panes.map((pane, p) => ({
                    ...pane,
                    surfaces: pane.surfaces.map((surface, s) =>
                        surface.type === "terminal" ? map(surface, `${w}/${ws}/${p}/${s}`) : surface
                    ),
                })),
            })),
        })),
    };
}

interface ResumeClaim {
    path: string;
    surface: TerminalSurface;
}

function titleNamesSession(surface: TerminalSurface, session: ReplayCatalogSession): boolean {
    return titleMatchKeys(surface.title, session.kind).some((key) => sessionMatchesKey(session, key));
}

/**
 * One session, one pane. A second `--resume <id>` of a running Claude session
 * is refused or forked by claude itself, so it is always wrong. Two panes
 * claimed one id on 2026-09-08 because `--resume 292767` and `--resume log`
 * both fuzzy-matched the same session. The pane whose tab title names the
 * session keeps the command; every other claimant gets no command and a drift
 * line naming the winner.
 */
export function dedupeResumeTargets(profile: Profile, catalog: ReplayCatalog): Profile {
    const claims = new Map<string, ResumeClaim[]>();

    mapTerminalSurfaces(profile, (surface, path) => {
        const command = surface.command?.trim();
        const kind = command ? agentKindFromLauncher(command) : undefined;
        const sessionId = command ? resumeTargetFromCommand(command) : undefined;

        if (kind && sessionId) {
            const key = `${kind}:${sessionId}`;
            claims.set(key, [...(claims.get(key) ?? []), { path, surface }]);
        }

        return surface;
    });

    const losers = new Map<string, { kind: AgentKind; sessionId: string; winner: string }>();

    for (const [key, claimants] of claims) {
        if (claimants.length < 2) {
            continue;
        }

        const [kind, sessionId] = key.split(":") as [AgentKind, string];
        const session = catalog.sessions.find((entry) => entry.kind === kind && entry.sessionId === sessionId);
        const winner =
            (session ? claimants.find((claim) => titleNamesSession(claim.surface, session)) : undefined) ??
            claimants[0];

        for (const claim of claimants) {
            if (claim !== winner) {
                losers.set(claim.path, { kind, sessionId, winner: winner.surface.title });
            }
        }
    }

    if (losers.size === 0) {
        return profile;
    }

    return mapTerminalSurfaces(profile, (surface, path) => {
        const loser = losers.get(path);

        if (!loser) {
            return surface;
        }

        return {
            ...surface,
            command: undefined,
            command_source: undefined,
            command_original: surface.command,
            drift: [
                `duplicate resume of ${loser.kind} ${loser.sessionId} dropped: pane "${loser.winner}" keeps it, this pane gets no command`,
            ],
        };
    });
}

export function grokSessionsDir(): string {
    return grokSessionsRoot();
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
    sessionsRoot: string = grokSessionsDir(),
    options: { cached?: boolean } = {}
): Promise<ReplayCatalogSession[]> {
    return loadNativeCatalog({ kind: "grok", cwds, roots: [sessionsRoot], cached: options.cached });
}

export function loadCodexCatalog(
    cwds: string[],
    roots: string[] = nativeSessionRoots("codex", homedir())
): Promise<ReplayCatalogSession[]> {
    return loadNativeCatalog({ kind: "codex", cwds, roots });
}

export async function loadClaudeCatalog(): Promise<ReplayCatalogSession[]> {
    const listing = await getSessionListing({ excludeSubagents: true });
    const pins = await loadPins({ readOnly: true });
    const out: ReplayCatalogSession[] = [];

    for (const record of listing.sessions) {
        if (!record.sessionId || !record.cwd) {
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

export async function loadReplayCatalog(profile: Profile): Promise<ReplayCatalog> {
    const cwds = collectProfileCwds(profile);
    const [grok, claude, codex] = await Promise.all([
        loadGrokCatalog(cwds),
        loadClaudeCatalog(),
        loadCodexCatalog(cwds),
    ]);

    return { sessions: [...grok, ...claude, ...codex] };
}

export async function prepareProfileForRestore(profile: Profile): Promise<Profile> {
    const catalog = await loadReplayCatalog(profile);
    return dedupeResumeTargets(withInferredReplayCommands(profile, catalog), catalog);
}
