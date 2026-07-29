import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { findClaudeCommand } from "@genesiscz/utils/claude";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import { shellSingleQuote } from "../shell-quote";
import type { TeamMemberView, TeamView } from "./types";

export type LaunchMode = "focus" | "attach" | "split";

export interface LaunchTeammateOptions {
    team: TeamView;
    teammate: TeamMemberView;
    /** AIConfig account name for OAuth (tools cc run). */
    account: string;
    mode: LaunchMode;
    /**
     * When true (default), if the transcript has no lead assignment and config
     * has a prompt, inject it after launch so the teammate does not wait for a
     * re-nudge that may never come.
     */
    injectAssignment?: boolean;
}

export interface LaunchResult {
    action: "focused" | "launched" | "split" | "noop";
    detail: string;
    command?: string;
}

/**
 * Build the argv Claude needs to rejoin an agent-team as this teammate.
 * Prefer --resume when a transcript exists (keeps history + first assignment).
 */
export function buildTeammateClaudeArgs(team: TeamView, teammate: TeamMemberView): string[] {
    const m = teammate.member;
    const teamName = team.config.name || team.teamName;
    const args = [
        "--agent-id",
        m.agentId,
        "--agent-name",
        m.name,
        "--team-name",
        teamName,
        "--agent-color",
        m.color || "blue",
        "--parent-session-id",
        team.leadSessionId || teamName.replace(/^session-/, ""),
        "--agent-type",
        m.agentType || "general-purpose",
        "--dangerously-skip-permissions",
        "--effort",
        "xhigh",
    ];

    if (m.model) {
        args.push("--model", m.model);
    }

    // Resume a prior transcript only when it already has the lead assignment
    // (or any real messages). Empty/auth-fail sessions are better restarted.
    if (teammate.transcript?.hasLeadAssignment && teammate.transcript.sessionId) {
        args.push("--resume", teammate.transcript.sessionId);
    }

    return args;
}

/**
 * Full shell command: tools cc run <account> -- <claude teammate flags>
 * Uses tools binary from PATH / GenesisTools so OAuth is injected.
 */
export function buildToolsCcTeammateCommand(account: string, team: TeamView, teammate: TeamMemberView): string {
    const args = buildTeammateClaudeArgs(team, teammate);
    const quoted = args.map(shellSingleQuote).join(" ");
    const cwd = teammate.member.cwd || team.cwd || process.cwd();
    return `cd ${shellSingleQuote(cwd)} && tools cc run ${shellSingleQuote(account)} -- ${quoted}`;
}

async function resolveAccount(preferred?: string): Promise<string> {
    if (preferred) {
        return preferred;
    }

    const ai = await AIConfig.load();
    const withToken = ai.getAccountsByProvider("anthropic-sub").filter((a) => Boolean(a.tokens.longLivedToken));
    if (withToken.length === 0) {
        throw new Error("No accounts with a long-lived token. Run: tools claude login-long");
    }

    // Last resort only: preferring an account already live on the team happens one
    // level up, in pickDefaultAccount, which calls this after those lookups miss.
    return withToken[0]!.name;
}

function tmuxSendCommand(target: string, command: string): void {
    const tmux = resolveTmuxBin();
    // Clear any half-typed input, paste command, Enter
    Bun.spawnSync([tmux, "send-keys", "-t", target, "C-c"], { stdout: "ignore", stderr: "ignore" });
    // Small delay not needed for send-keys -l
    const r = Bun.spawnSync([tmux, "send-keys", "-t", target, "-l", "--", command], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (r.exitCode !== 0) {
        throw new Error(`tmux send-keys failed: ${r.stderr.toString() || r.stdout.toString()}`);
    }

    Bun.spawnSync([tmux, "send-keys", "-t", target, "Enter"], { stdout: "ignore", stderr: "ignore" });
}

function tmuxSplitAndRun(session: string, leadPaneId: string | undefined, cwd: string, command: string): string {
    const tmux = resolveTmuxBin();
    // Prefer -h split of the lead pane when we know it; else split the session's active window.
    // leadPaneId is tmux's `#{pane_id}` (`%3`), already an absolute target — prefixing it
    // with the session name yields `sess:%3`, which is not a valid session:window.pane target.
    // -P -F prints the new pane target (session:window.pane or %id depending on version).
    const splitTarget = leadPaneId || session;
    const split = Bun.spawnSync(
        [
            tmux,
            "split-window",
            "-h",
            "-t",
            splitTarget,
            "-c",
            cwd,
            "-P",
            "-F",
            "#{session_name}:#{window_index}.#{pane_index}",
        ],
        { stdout: "pipe", stderr: "pipe" }
    );

    let newTarget = split.stdout.toString().trim();
    if (split.exitCode !== 0 || !newTarget) {
        const split2 = Bun.spawnSync(
            [
                tmux,
                "split-window",
                "-h",
                "-t",
                session,
                "-c",
                cwd,
                "-P",
                "-F",
                "#{session_name}:#{window_index}.#{pane_index}",
            ],
            { stdout: "pipe", stderr: "pipe" }
        );
        newTarget = split2.stdout.toString().trim();
        if (split2.exitCode !== 0 || !newTarget) {
            throw new Error(`tmux split-window failed: ${split2.stderr.toString() || split.stderr.toString()}`);
        }
    }

    tmuxSendCommand(newTarget, command);
    return newTarget;
}

/**
 * Inject the lead assignment into a freshly launched teammate that has no
 * transcript assignment. Uses tmux send-keys once the pane shows a prompt.
 *
 * Why: CC's native spawn writes the first user message as
 * `<teammate-message teammate_id="team-lead">…prompt…`. Our OAuth re-attach
 * path launches with --agent-id flags only, so without this the teammate sits
 * idle until a SendMessage nudge — and even then may not get the original
 * assignment text. See TeammateTmuxNotRespectingOauthTokens + idle-monitor notes.
 */
export async function injectLeadAssignment(opts: {
    tmuxTarget: string;
    prompt: string;
    waitMs?: number;
}): Promise<void> {
    const tmux = resolveTmuxBin();
    const waitMs = opts.waitMs ?? 4000;
    const deadline = Date.now() + waitMs;

    // Wait for TUI ready-ish
    while (Date.now() < deadline) {
        const cap = Bun.spawnSync([tmux, "capture-pane", "-t", opts.tmuxTarget, "-p"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const text = cap.stdout.toString();
        if (/bypass permissions|for agents|❯|Not logged in|Claude Code/.test(text)) {
            break;
        }

        Bun.sleepSync(250);
    }

    const body = opts.prompt.trim();
    if (!body) {
        return;
    }

    // Don't re-inject if the pane already shows substantial activity beyond login banner
    const cap2 = Bun.spawnSync([tmux, "capture-pane", "-t", opts.tmuxTarget, "-p", "-S", "-40"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const screen = cap2.stdout.toString();
    if (/teammate-message|Research |PROBLEM \(reproduce/.test(screen) && !/Not logged in/.test(screen)) {
        logger.debug({ target: opts.tmuxTarget }, "[teams] skip inject — pane already has assignment");
        return;
    }

    // Type the assignment. Large prompts: use load-buffer for reliability.
    // The prompt is task text, so it goes in a private 0700 dir under a random
    // name (never a predictable shared-/tmp path) and is unlinked right after.
    const dir = mkdtempSync(join(tmpdir(), "gt-team-assign-"));
    const tmp = join(dir, "assignment.txt");

    try {
        await Bun.write(tmp, body);
        const load = Bun.spawnSync([tmux, "load-buffer", "-b", "gt-team-assign", tmp], {
            stdout: "ignore",
            stderr: "pipe",
        });

        if (load.exitCode !== 0) {
            throw new Error(`tmux load-buffer failed: ${load.stderr.toString().trim()}`);
        }

        const paste = Bun.spawnSync([tmux, "paste-buffer", "-b", "gt-team-assign", "-t", opts.tmuxTarget], {
            stdout: "ignore",
            stderr: "pipe",
        });

        if (paste.exitCode !== 0) {
            throw new Error(`tmux paste-buffer failed: ${paste.stderr.toString().trim()}`);
        }

        Bun.spawnSync([tmux, "send-keys", "-t", opts.tmuxTarget, "Enter"], { stdout: "ignore", stderr: "ignore" });
        logger.debug({ target: opts.tmuxTarget, chars: body.length }, "[teams] injected lead assignment");
    } finally {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch (error) {
            logger.debug({ error, dir }, "[teams] could not remove assignment tempdir");
        }
    }
}

export async function launchTeammate(opts: LaunchTeammateOptions): Promise<LaunchResult> {
    const account = await resolveAccount(opts.account || opts.teammate.live?.account || opts.team.lead?.live?.account);
    const command = buildToolsCcTeammateCommand(account, opts.team, opts.teammate);
    const cwd = opts.teammate.member.cwd || opts.team.cwd || process.cwd();
    const inject = opts.injectAssignment !== false;
    const needsInject = inject && Boolean(opts.teammate.member.prompt) && !opts.teammate.transcript?.hasLeadAssignment;

    // Already running → focus pane
    if (opts.mode === "focus" || (opts.mode === "attach" && opts.teammate.live?.tmuxPaneId)) {
        const live = opts.teammate.live;
        if (live?.tmuxSession && live.tmuxPaneId) {
            const tmux = resolveTmuxBin();
            // tmuxPaneId is `#{pane_id}` (`%3`) — an absolute target on its own.
            const selected = Bun.spawnSync([tmux, "select-pane", "-t", live.tmuxPaneId], {
                stdout: "ignore",
                stderr: "pipe",
            });

            if (selected.exitCode !== 0) {
                throw new Error(
                    `tmux select-pane ${live.tmuxPaneId} failed: ${selected.stderr.toString().trim() || "unknown error"}`
                );
            }

            // If we are inside tmux, also select the window; attach is for outside
            if (!process.env.TMUX) {
                Bun.spawnSync([tmux, "attach-session", "-t", live.tmuxSession], {
                    stdout: "inherit",
                    stderr: "inherit",
                    stdin: "inherit",
                });
            }

            return {
                action: "focused",
                detail: `Focused ${live.tmuxSession}:${live.tmuxPaneId} (pid ${live.pid})`,
                command,
            };
        }

        if (opts.mode === "focus") {
            // fall through to launch
        }
    }

    if (opts.mode === "split") {
        const session = opts.team.tmuxSession || opts.team.lead?.live?.tmuxSession;
        if (!session) {
            throw new Error(
                `No tmux session found for team ${opts.team.teamName}. Start the lead inside tmux, or use attach mode.`
            );
        }

        const leadPane = opts.team.leadPaneId || opts.team.lead?.live?.tmuxPaneId;
        const newTarget = tmuxSplitAndRun(session, leadPane || undefined, cwd, command);

        if (needsInject && opts.teammate.member.prompt) {
            try {
                await injectLeadAssignment({
                    tmuxTarget: newTarget,
                    prompt: opts.teammate.member.prompt,
                    waitMs: 10_000,
                });
            } catch (error) {
                logger.warn({ error }, "[teams] assignment inject failed");
            }
        }

        return {
            action: "split",
            detail: `Split ${newTarget} and launched ${opts.teammate.member.name} as ${account}`,
            command,
        };
    }

    // attach / launch in current context
    if (process.env.TMUX) {
        // Launch in a new window of the current session so we don't clobber the caller
        const tmux = resolveTmuxBin();
        const name = opts.teammate.member.name.slice(0, 20);
        const shell = env.paths.getShell("/bin/zsh") || "/bin/zsh";
        const created = Bun.spawnSync(
            [
                tmux,
                "new-window",
                "-n",
                name,
                "-c",
                cwd,
                "-P",
                "-F",
                "#{session_name}:#{window_index}.#{pane_index}",
                shell,
            ],
            {
                stdout: "pipe",
                stderr: "pipe",
            }
        );
        const target = created.stdout.toString().trim();
        if (created.exitCode !== 0 || !target) {
            throw new Error(`tmux new-window failed: ${created.stderr.toString() || "no target"}`);
        }

        tmuxSendCommand(target, command);

        if (needsInject && opts.teammate.member.prompt) {
            try {
                await injectLeadAssignment({
                    tmuxTarget: target,
                    prompt: opts.teammate.member.prompt,
                    waitMs: 10_000,
                });
            } catch (error) {
                logger.warn({ error }, "[teams] assignment inject failed");
            }
        }

        return {
            action: "launched",
            detail: `Opened ${target} for ${opts.teammate.member.name}`,
            command,
        };
    }

    // Outside tmux: exec tools cc run in foreground (user gets the TUI)
    const shell = env.paths.getShell("/bin/zsh") || "/bin/zsh";
    logger.info({ command, account }, "[teams] launching teammate in foreground");
    const proc = Bun.spawn({
        cmd: [shell, "-ic", command],
        cwd,
        stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    return {
        action: "launched",
        detail: `Teammate process exited with code ${code}`,
        command,
    };
}

export async function pickDefaultAccount(team?: TeamView): Promise<string> {
    const fromLive = team?.teammates.find((t) => t.live?.account)?.live?.account;
    if (fromLive) {
        return fromLive;
    }

    if (team?.lead?.live?.account) {
        return team.lead.live.account;
    }

    return resolveAccount();
}

/** Resolve real claude path (for diagnostics). */
export async function resolveClaudeBin(): Promise<string> {
    try {
        if (existsSync(`${env.paths.getHome()}/.bun/bin/claude`)) {
            return `${env.paths.getHome()}/.bun/bin/claude`;
        }
    } catch (error) {
        logger.debug({ error }, "[teams] bun-bin claude probe failed; falling back to findClaudeCommand");
    }

    return findClaudeCommand();
}
