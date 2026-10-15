import { agentKindFromLauncher, isAgentLauncher } from "@app/cmux/lib/launchers";
import { mapTerminalSurfaces } from "@app/cmux/lib/profile-walk";
import {
    bareResumeFlag,
    deriveReplayCommand,
    resumeQueryFromCommand,
    resumeTargetFromCommand,
    stripModelFlags,
} from "@app/cmux/lib/render-resume";
import { loadReplayCatalog, type ReplayCatalog, type ReplayCatalogSession } from "@app/cmux/lib/replay-catalog";
import {
    inferLauncherFromTitle,
    matchAgentSession,
    promptMatchesKey,
    titleEqualsKey,
    titleMatchKeys,
    titleStartsWithKey,
} from "@app/cmux/lib/title-match";
import type { Profile, ResumeEvidence, TerminalSurface } from "@app/cmux/lib/types";
import { resumeCommandLine } from "@genesiscz/utils/agent-sessions/resume-argv";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";

export type { AgentKind };

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

/** Resolve a replay command from the surface journal, typed resume or catalog and report its evidence and drift. */
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
    // The command the shell journal saw typed in this tab names its own session (`cr work -- --resume <id>`,
    // cmux's own `cmux restore claude <id>` rewritten): that id beats a title guess, which would replace it. A
    // process-table command is not typed: a crash capture can attribute another tab's process to this one.
    const typedId =
        trusted && !journal && original && capturedKind === kind ? resumeTargetFromCommand(original) : undefined;

    if (typedId && original) {
        return { command: original, drift: [], evidence: "typed" };
    }

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

    return {
        command: inferredResumeCommand(hit),
        drift: [`inferred ${hit.kind} resume ${hit.sessionId} from ${source}`],
        evidence,
    };
}

/** Fill unresolved terminal replay commands while preserving explicit resumes and exact shell-journal commands. */
export function withInferredReplayCommands(profile: Profile, catalog: ReplayCatalog): Profile {
    return mapTerminalSurfaces(profile, (surface) => {
        if (
            (surface.resume ||
                (surface.command_source === "shell-journal" &&
                    (!isAgentLauncher(surface.command ?? "") || resumeTargetFromCommand(surface.command ?? "")))) &&
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
    });
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

/** Resolve replay targets, correct stale native bindings, deduplicate sessions and remove model pins before restore. */
export async function prepareProfileForRestore(profile: Profile, options: { cached?: boolean } = {}): Promise<Profile> {
    const catalog = await loadReplayCatalog(profile, options);
    const corrected = correctNativeResumeBindings(profile, catalog);

    return withoutModelPins(dedupeResumeTargets(withInferredReplayCommands(corrected, catalog), catalog));
}

/** Every agent resume without its model flags (`stripModelFlags`), with a drift line naming what was dropped. */
export function withoutModelPins(profile: Profile): Profile {
    return mapTerminalSurfaces(profile, (surface) => {
        if (!surface.command || !isAgentLauncher(surface.command)) {
            return surface;
        }

        const { command, removed } = stripModelFlags(surface.command);

        if (removed.length === 0) {
            return surface;
        }

        return {
            ...surface,
            command,
            command_original: surface.command_original ?? surface.command,
            drift: [
                ...(surface.drift ?? []),
                `dropped ${removed.join(", ")}: the session may have switched models since it started, so the agent picks its own`,
            ],
        };
    });
}
