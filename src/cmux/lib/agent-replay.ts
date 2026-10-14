import { homedir } from "node:os";
import { getSessionListing } from "@app/claude/lib/history/search";
import {
    agentKindFromLauncher,
    bareResumeFlag,
    deriveReplayCommand,
    isAgentLauncher,
    resumeQueryFromCommand,
    resumeTargetFromCommand,
} from "@app/cmux/lib/command-capture";
import type { Profile, ResumeEvidence, Surface, TerminalSurface } from "@app/cmux/lib/types";
import { grokSessionsRoot } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { createNativeHistoryAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import { loadPins } from "@genesiscz/utils/agent-sessions/pins";
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

/** Strongest evidence: the tab title IS the session's title. */
function titleEqualsKey(session: ReplayCatalogSession, key: string): boolean {
    return Boolean(key) && session.title.trim().toLowerCase() === key;
}

/**
 * Strong evidence: the tab shows the session's title truncated. It is its own tier below the exact
 * title, because sibling sessions are often named by extending one name (`pr-7210-logs`,
 * `pr-7210-logs-scripts`), and counting those prefix hits beside the exact one made the match
 * ambiguous and resolved nothing.
 */
function titleStartsWithKey(session: ReplayCatalogSession, key: string): boolean {
    return key.length >= 12 && session.title.trim().toLowerCase().startsWith(key);
}

/** Weak evidence: the tab title reads like the opening words of the first prompt. */
function promptMatchesKey(session: ReplayCatalogSession, key: string): boolean {
    const prompt = session.prompt?.toLowerCase() ?? "";

    if (!key || !prompt) {
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
    return matchAgentSession("grok", title, cwd, sessions)?.session;
}

export function matchClaudeSession(
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[]
): ReplayCatalogSession | undefined {
    return matchAgentSession("claude", title, cwd, sessions)?.session;
}

export function matchCodexSession(
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[]
): ReplayCatalogSession | undefined {
    return matchAgentSession("codex", title, cwd, sessions)?.session;
}

/**
 * Title evidence outranks prompt evidence, and the pane's own directory
 * outranks both.
 *
 * Title and prompt used to share one candidate pool, so three sessions whose
 * FIRST PROMPT happened to contain "native oauth" out-voted the one session
 * whose title was exactly the tab's, and `pickUnique` reported "ambiguous" for a
 * session it had already found. Tiering answers from the exact title and never
 * reaches the prompt guess.
 *
 * The cwd fallback stays OUTSIDE that tier loop on purpose. Running it per tier
 * put "a title match in any directory" above "a prompt match in this pane's own
 * directory", and the restored pane then resumed a conversation from another
 * project.
 *
 * `launcherKnown` says the pane's own launch command already names this agent. A
 * tab cmux restored after a restart shows its saved title without the agent's
 * glyph (`nabidky-2.0`, not `✳ nabidky-2.0`), so demanding the glyph refused the
 * exact-title session for every idle tab. Then only a title that names ANOTHER
 * agent disqualifies the match.
 */
function matchAgentSession(
    kind: AgentKind,
    title: string,
    cwd: string | undefined,
    sessions: ReplayCatalogSession[],
    options: { launcherKnown?: boolean } = {}
): { session: ReplayCatalogSession; evidence: Exclude<ResumeEvidence, "journal">; why: string } | undefined {
    const titleKind = inferLauncherFromTitle(title);

    if (options.launcherKnown ? titleKind !== undefined && titleKind !== kind : titleKind !== kind) {
        return undefined;
    }

    const keys = titleMatchKeys(title, kind);
    const pool = sessions.filter((session) => session.kind === kind);
    const inCwd = cwd ? pool.filter((session) => session.cwd === cwd) : pool;

    // `why` names the evidence for the drift line. Only a title match in the tab's own directory counts
    // as "title"; first-prompt words, or any match in another directory, are "weak".
    const tiers = [
        { matches: titleEqualsKey, why: "tab title" },
        { matches: titleStartsWithKey, why: "tab title" },
        { matches: promptMatchesKey, why: "first-prompt words of session" },
    ];

    for (const { matches, why } of tiers) {
        for (const key of keys) {
            const local = pickUnique(inCwd.filter((session) => matches(session, key)));
            if (local) {
                return { session: local, evidence: why === "tab title" ? "title" : "weak", why };
            }
        }
    }

    if (!cwd) {
        return undefined;
    }

    for (const { matches, why } of tiers) {
        for (const key of keys) {
            const global = pickUnique(pool.filter((session) => matches(session, key)));
            if (global) {
                return { session: global, evidence: "weak", why: `${why} in another directory (${global.cwd})` };
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
): { command?: string; drift: string[]; evidence?: ResumeEvidence } {
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
    const matched =
        journal || !kind
            ? undefined
            : matchAgentSession(kind, surface.title, surface.cwd, catalog.sessions, {
                  launcherKnown: capturedKind === kind,
              });
    const hit = journal ?? matched?.session;

    if (!hit) {
        if (original && kind) {
            // Say it, do not hide it: replaying a bare launcher opens a NEW
            // session and paints the old screen over it. Two launchers are not
            // cold starts and must not be described as one: a resume QUERY
            // reopens a session, just not a provably correct one, and a bare
            // resume flag opens the agent's own picker.
            const query = resumeQueryFromCommand(original);
            const picker = bareResumeFlag(original);

            return {
                command: original,
                drift: [
                    query
                        ? `no ${kind} session id resolved; the command resumes the query "${query}", whose top match can be another session`
                        : picker
                          ? `no ${kind} session id resolved; the command's bare ${picker} opens ${kind}'s own session picker`
                          : `no ${kind} session id resolved for this pane; restore starts a NEW ${kind} session`,
                ],
            };
        }

        if (original) {
            return { command: original, drift: [] };
        }

        return { command: undefined, drift: [] };
    }

    // Say which evidence picked the session. A title match is a guess the surface journal could not
    // confirm, and first-prompt words are weaker still; the reader must be able to tell them apart.
    const evidence: ResumeEvidence = matched?.evidence ?? "journal";
    const source = matched ? `${matched.why} "${hit.title.slice(0, 60)}"` : "the session journal for this pane";
    const note = evidence === "journal" ? [] : [`session picked by ${source}; the surface journal has no record here`];

    if (original && isAgentLauncher(original)) {
        const derived = deriveReplayCommand({ original, sessionId: hit.sessionId, account: hit.account ?? undefined });

        return { command: derived.command, drift: [...derived.drift, ...note], evidence };
    }

    if (hit.kind === "grok" || hit.kind === "codex") {
        const derived = deriveReplayCommand({ original: hit.kind, sessionId: hit.sessionId });

        return { command: derived.command, drift: [...derived.drift, ...note], evidence };
    }

    return {
        command: inferredResumeCommand(hit),
        drift: [`inferred ${hit.kind} resume ${hit.sessionId} from ${source}`],
        evidence,
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
                            return resolved.drift.length > 0
                                ? { ...surface, drift: resolved.drift, resume_evidence: resolved.evidence }
                                : surface;
                        }

                        return {
                            ...surface,
                            command: resolved.command,
                            command_source: surface.command ? surface.command_source : "inferred",
                            command_original: surface.command,
                            drift: resolved.drift.length > 0 ? resolved.drift : surface.drift,
                            resume_evidence: resolved.evidence,
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

/**
 * The tab title IS this session's generated title. Strong enough to overrule a
 * binding the app wrote down itself.
 */
function titleNamesSession(surface: TerminalSurface, session: ReplayCatalogSession): boolean {
    return titleMatchKeys(surface.title, session.kind).some(
        (key) => titleEqualsKey(session, key) || titleStartsWithKey(session, key)
    );
}

/**
 * The tab title reads like the opening words of this session's FIRST PROMPT.
 *
 * Weaker, and deliberately kept out of `correctNativeResumeBindings`: a guess must
 * not retarget a recorded id. `dedupeResumeTargets` asks a different question —
 * of N panes already claiming ONE id, which one owns it — and there prompt
 * evidence is often the only evidence there is, because an agent that has not
 * summarised a conversation yet stores the session id as its title.
 */
function promptNamesSession(surface: TerminalSurface, session: ReplayCatalogSession): boolean {
    return titleMatchKeys(surface.title, session.kind).some((key) => promptMatchesKey(session, key));
}

/**
 * cmux's own autosave is not per-pane for grok. In the 2026-09-12 session file
 * FIVE tabs carried the id 01a08678… and four more carried 01a0912b…, although
 * every one of those tab titles named a different conversation in grok's index.
 * Restoring that resumes one thread in five panes and loses the other four.
 *
 * A tab title is the session's own generated summary, so when it names another
 * session the title wins. Only title evidence may override a recorded binding:
 * a prompt match is a guess, and a guess must not retarget an id the app wrote
 * down itself.
 */
export function correctNativeResumeBindings(profile: Profile, catalog: ReplayCatalog): Profile {
    return mapTerminalSurfaces(profile, (surface) => {
        const binding = surface.resume;
        const command = surface.command?.trim();

        if (!binding || !command) {
            return surface;
        }

        const hit = matchAgentSession(binding.kind, surface.title, surface.cwd, catalog.sessions)?.session;

        if (!hit || hit.sessionId === binding.sessionId || !titleNamesSession(surface, hit)) {
            return surface;
        }

        // The account follows the session, not the pane: retargeting to another
        // session under the launcher's old account relaunches it as the wrong
        // identity, and swallowing the earlier drift hid the
        // "no account recorded" warning that says so.
        const derived = deriveReplayCommand({
            original: command,
            sessionId: hit.sessionId,
            account: hit.account ?? undefined,
        });

        return {
            ...surface,
            command: derived.command,
            command_original: surface.command_original ?? command,
            resume: { kind: binding.kind, sessionId: hit.sessionId },
            drift: [
                ...(surface.drift ?? []),
                ...derived.drift,
                `autosave named ${binding.kind} ${binding.sessionId} here, but the tab title is session ${hit.sessionId}; used the title`,
            ],
        };
    });
}

/**
 * One session, one pane. A second `--resume <id>` of a running Claude session
 * is refused or forked by claude itself, so it is always wrong. Two panes
 * claimed one id on 2026-09-08 because `--resume 234567` and `--resume log`
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
        // Title first, prompt second, traversal order last. Title-only would hand
        // the session to an unrelated pane whenever the agent has not summarised
        // the conversation yet, which is exactly the shared-autosave-id case this
        // function exists for.
        const winner =
            (session
                ? (claimants.find((claim) => titleNamesSession(claim.surface, session)) ??
                  claimants.find((claim) => promptNamesSession(claim.surface, session)))
                : undefined) ?? claimants[0];

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
    roots: string[] = nativeSessionRoots("codex", homedir()),
    options: { cached?: boolean } = {}
): Promise<ReplayCatalogSession[]> {
    return loadNativeCatalog({ kind: "codex", cwds, roots, cached: options.cached });
}

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
        loadGrokCatalog(cwds, grokSessionsDir(), { cached: options.cached }),
        loadClaudeCatalog({ cached: options.cached }),
        loadCodexCatalog(cwds, nativeSessionRoots("codex", homedir()), { cached: options.cached }),
    ]);

    return { sessions: [...grok, ...claude, ...codex] };
}

export async function prepareProfileForRestore(profile: Profile, options: { cached?: boolean } = {}): Promise<Profile> {
    const catalog = await loadReplayCatalog(profile, options);
    const corrected = correctNativeResumeBindings(profile, catalog);

    return dedupeResumeTargets(withInferredReplayCommands(corrected, catalog), catalog);
}
