import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { runCmux, runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";

import { windowList } from "@genesiscz/utils/cmux/lib/socket";
import { focusedPlace } from "@genesiscz/utils/cmux/open-command";
import {
    buildWorkspaceCreateArgs,
    ensureWorkspaceTitle,
    type WorkspaceTitleOutcome,
} from "@genesiscz/utils/cmux/workspace";
import { env } from "@genesiscz/utils/env";
import { levenshteinDistance } from "@genesiscz/utils/fuzzy-match";
import { logger } from "@genesiscz/utils/logger";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import { createTmuxSession, killTmuxSession } from "@genesiscz/utils/tmux/sessions";
import { parseCmuxTree } from "./session-adopt";
import { agentRunCommand, type SessionAgentId, withPidNote } from "./session-agents";

const { log } = logger.scoped("cmux-session");

/** Gap between literal text and Enter, so the shell sees the whole line. */
const TMUX_ENTER_DELAY_MS = 100;

export interface SessionNewResult {
    agent: SessionAgentId;
    workspace: string;
    surface: string;
    window: string;
    workspaceId: string | null;
    surfaceId: string | null;
    tmuxSession: string | null;
    cwd: string;
    command: string;
}

export interface SessionNewRequest {
    agent: SessionAgentId;
    repo: string;
    account: string;
    model?: string;
    /** The shell that runs the agent writes its pid here, for `close`. */
    pidFile?: string;
    prompt?: string;
    promptFile?: string;
    /** Claude: accept cross-session messages without approval (on by default from `agents new`). */
    crossMessages?: boolean;
    name?: string;
    viaTmux?: boolean;
    focus?: boolean;
    home: string;
    cwd: string;
}

export interface RepoFs {
    isDirectory(path: string): boolean;
    /** Directory names, or null when the path is not a directory. */
    list(path: string): string[] | null;
}

export interface SessionNewIO {
    focusedWindow(): Promise<string | undefined>;
    listWindows(): Promise<{ ref: string; id: string; visible: boolean }[]>;
    runJSON<T>(args: string[]): Promise<T>;
    runOk(args: string[]): Promise<void>;
    shell(): string;
    createTmuxShell(session: string, cwd: string, shell: string): Promise<void>;
    sendTmuxKeys(session: string, command: string): Promise<void>;
    killTmuxSession(session: string): Promise<void>;
    repoFs: RepoFs;
    nonce(): string;
    ensureTitle(input: { workspace: string; window: string; title: string }): Promise<WorkspaceTitleOutcome>;
    /** The UUIDs behind a surface ref and its workspace, from the live tree; null when cmux lists no such surface. */
    surfaceIds(surface: string): Promise<SessionCmuxIds | null>;
}

interface WorkspaceCreated {
    workspace_ref?: string;
    surface_ref?: string;
    window_ref?: string;
    workspace_id?: string;
    surface_id?: string;
}

/** The cmux UUIDs of a workspace and surface; null where cmux named none. */
export interface SessionCmuxIds {
    workspaceId: string | null;
    surfaceId: string | null;
}

/**
 * The UUIDs of the workspace and surface just created: from the create answer, else from the live tree, read
 * at once while the fresh refs still name them. A failed lookup never fails the session that is already open;
 * `close` then refuses its refs until `--force`.
 */
async function createdIds(input: {
    created: WorkspaceCreated;
    surface: string;
    io: Pick<SessionNewIO, "surfaceIds">;
}): Promise<SessionCmuxIds> {
    let workspaceId = input.created.workspace_id?.trim() || null;
    let surfaceId = input.created.surface_id?.trim() || null;

    if (!workspaceId || !surfaceId) {
        try {
            const live = await input.io.surfaceIds(input.surface);
            workspaceId = workspaceId ?? live?.workspaceId ?? null;
            surfaceId = surfaceId ?? live?.surfaceId ?? null;
        } catch (error) {
            log.warn({ error, surface: input.surface }, "could not read the new session's cmux UUIDs");
        }
    }

    if (!workspaceId || !surfaceId) {
        log.warn(
            { surface: input.surface, workspaceId, surfaceId },
            "the session has no cmux UUIDs; close will need --force"
        );
    }

    return { workspaceId, surfaceId };
}

/**
 * `--focus` is `true` or `false`. Omitted means false. A bare flag or any other value is rejected.
 */
export function parseFocusFlag(
    raw: string | boolean | undefined
): { ok: true; focus: boolean } | { ok: false; given?: string } {
    if (raw === undefined || raw === "") {
        return { ok: true, focus: false };
    }

    if (typeof raw === "boolean") {
        return { ok: false };
    }

    const given = raw.trim().toLowerCase();

    if (given === "true") {
        return { ok: true, focus: true };
    }

    if (given === "false") {
        return { ok: true, focus: false };
    }

    return { ok: false, given: raw.trim() };
}

export function suggestProjectNames(query: string, names: readonly string[]): string[] {
    const needle = query.toLowerCase();
    const ranked = names
        .map((name) => {
            const folded = name.toLowerCase();

            if (folded === needle) {
                return { name, score: 0 };
            }

            if (folded.startsWith(needle) || (needle.startsWith(folded) && folded.length >= 3)) {
                return { name, score: 1 };
            }

            if (needle.length >= 3 && folded.includes(needle)) {
                return { name, score: 2 };
            }

            const distance = levenshteinDistance(needle, folded);

            if (distance <= 3 && Math.abs(folded.length - needle.length) <= 3) {
                return { name, score: 10 + distance };
            }

            return { name, score: 1000 };
        })
        .filter((entry) => entry.score < 1000)
        .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

    return ranked.slice(0, 5).map((entry) => entry.name);
}

function isProjectName(value: string): boolean {
    return !value.startsWith("~") && !value.includes("/") && !value.includes("\\") && !isAbsolute(value);
}

function expandHome(value: string, home: string): string {
    if (value === "~") {
        return home;
    }

    if (value.startsWith("~/")) {
        return join(home, value.slice(2));
    }

    return value;
}

/** Absolute directory, or `<home>/Tresors/Projects/<name>`. */
export function resolveSessionRepo(repo: string, home: string, cwd: string, fs: RepoFs): string {
    const trimmed = repo.trim();

    if (!trimmed) {
        throw new Error("--repo is required");
    }

    const projects = join(home, "Tresors", "Projects");

    if (isProjectName(trimmed)) {
        if (!fs.isDirectory(projects)) {
            throw new Error(`Projects directory does not exist: ${projects}`);
        }

        const direct = join(projects, trimmed);

        if (fs.isDirectory(direct)) {
            return direct;
        }

        const names = fs.list(projects) ?? [];
        const folded = names.find((name) => name.toLowerCase() === trimmed.toLowerCase());

        if (folded && fs.isDirectory(join(projects, folded))) {
            return join(projects, folded);
        }

        const suggestions = suggestProjectNames(trimmed, names);
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
        throw new Error(`No project named "${trimmed}" under ${projects}.${hint}`);
    }

    const expanded = expandHome(trimmed, home);
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

    if (!fs.isDirectory(absolute)) {
        throw new Error(`No such directory: ${absolute}`);
    }

    return absolute;
}

export function tmuxAttachCommand(session: string): string {
    return `tmux attach -t ${shellQuote(session)}`;
}

/**
 * The third argument of `createTmuxSession` is the pane executable. A command line is exec'd as
 * one word and the session dies immediately (`tools tmux create --command`).
 */
export function assertShellExecutable(shell: string): string {
    const trimmed = shell.trim();

    if (!trimmed || /[\s=]/.test(trimmed) || trimmed.includes("\n")) {
        throw new Error("tmux session shell must be an executable path, not a command line");
    }

    return trimmed;
}

export function devTmuxSessionName(cwd: string, name: string | undefined, nonce: string): string {
    const raw = (name?.trim() || cwd.split("/").filter(Boolean).at(-1) || "repo").toLowerCase();
    const slug = raw
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
    const id = nonce
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 8);

    return `cmux-${slug || "repo"}-${id || "x"}`;
}

export function tmuxLiteralSendArgv(tmuxBin: string, session: string, command: string): string[] {
    return [tmuxBin, "send-keys", "-t", session, "-l", "--", command];
}

export function tmuxEnterArgv(tmuxBin: string, session: string): string[] {
    return [tmuxBin, "send-keys", "-t", session, "Enter"];
}

/**
 * The window the new workspace belongs to.
 *
 * Prefer the focused window. When cmux has no window at all, create one and use it. When windows
 * exist but none is focused, use a visible window instead of creating another.
 */
export async function resolveSessionWindow(
    io: Pick<SessionNewIO, "focusedWindow" | "listWindows" | "runOk">
): Promise<string> {
    const focused = (await io.focusedWindow())?.trim();

    if (focused) {
        return focused;
    }

    let windows = await io.listWindows();

    if (windows.length === 0) {
        await io.runOk(["new-window"]);
        windows = await io.listWindows();
    }

    const chosen = windows.find((window) => window.visible && window.ref) ?? windows.find((window) => window.ref);

    if (!chosen) {
        throw new Error("cmux has no window to open a workspace in");
    }

    return chosen.ref;
}

export async function startDevSession(input: SessionNewRequest, io: SessionNewIO): Promise<SessionNewResult> {
    const cwd = resolveSessionRepo(input.repo, input.home, input.cwd, io.repoFs);
    const run = agentRunCommand({
        agent: input.agent,
        account: input.account,
        model: input.model,
        prompt: input.prompt,
        promptFile: input.promptFile,
        crossMessages: input.crossMessages,
    });
    const agentLine = input.pidFile ? withPidNote(run, input.pidFile) : run;
    const windowRef = await resolveSessionWindow(io);
    let tmuxSession: string | null = null;
    let command = agentLine;
    const name = input.name?.trim() || undefined;
    let workspace: string;
    let surface: string;
    let window: string;
    let created: WorkspaceCreated;

    try {
        if (input.viaTmux) {
            const session = devTmuxSessionName(cwd, input.name, io.nonce());
            const shell = assertShellExecutable(io.shell());
            await io.createTmuxShell(session, cwd, shell);
            // Owned from here on: any later failure must kill it.
            tmuxSession = session;
            await io.sendTmuxKeys(session, agentLine);
            command = tmuxAttachCommand(session);
        }

        created = await io.runJSON<WorkspaceCreated>(
            buildWorkspaceCreateArgs({
                window: windowRef,
                cwd,
                command,
                focus: input.focus === true,
                name,
            })
        );
        workspace = created.workspace_ref?.trim() ?? "";
        surface = created.surface_ref?.trim() ?? "";
        window = created.window_ref?.trim() || windowRef;

        if (!workspace || !surface) {
            throw new Error("cmux created a workspace but returned no workspace or surface ref");
        }
    } catch (error) {
        // The detached tmux session may already run the agent on the prompt; nobody would ever attach to it.
        if (tmuxSession) {
            await io.killTmuxSession(tmuxSession).catch((killError: unknown) => {
                log.warn({ error: killError, tmuxSession }, "could not kill the tmux session after cmux failed");
            });
        }

        throw error;
    }

    const ids = await createdIds({ created, surface, io });

    if (name) {
        await io.ensureTitle({ workspace, window, title: name });
    }

    return { agent: input.agent, workspace, surface, window, ...ids, tmuxSession, cwd, command };
}

async function spawnTmux(argv: string[]): Promise<void> {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    if (code !== 0) {
        throw new Error(`tmux ${argv[1] ?? "command"} failed: ${stderr.trim() || `exit ${code}`}`);
    }
}

export function liveRepoFs(): RepoFs {
    return {
        isDirectory(path) {
            try {
                return statSync(path).isDirectory();
            } catch (error) {
                log.debug({ error, path }, "repo path is not a directory");
                return false;
            }
        },
        list(path) {
            if (!existsSync(path)) {
                return null;
            }

            try {
                return readdirSync(path, { withFileTypes: true })
                    .filter((entry) => {
                        if (entry.name.startsWith(".")) {
                            return false;
                        }

                        if (entry.isDirectory()) {
                            return true;
                        }

                        if (!entry.isSymbolicLink()) {
                            return false;
                        }

                        try {
                            return statSync(join(path, entry.name)).isDirectory();
                        } catch (error) {
                            log.debug({ error, path, name: entry.name }, "project symlink is not a directory");
                            return false;
                        }
                    })
                    .map((entry) => entry.name);
            } catch (error) {
                log.debug({ error, path }, "could not list project directory");
                return null;
            }
        },
    };
}

export function liveSessionIO(): SessionNewIO {
    return {
        focusedWindow: async () => (await focusedPlace()).window_ref,
        listWindows: async () => {
            const windows = await windowList();
            return windows.map((window) => ({ ref: window.ref, id: window.id, visible: window.visible }));
        },
        runJSON: (args) => runCmuxJSON(args),
        runOk: async (args) => {
            await runCmuxOk(args);
        },
        shell: () => env.paths.getShell(),
        createTmuxShell: async (session, cwd, shell) => {
            await createTmuxSession(session, cwd, assertShellExecutable(shell));
        },
        sendTmuxKeys: async (session, command) => {
            const tmux = resolveTmuxBin();
            await spawnTmux(tmuxLiteralSendArgv(tmux, session, command));
            await Bun.sleep(TMUX_ENTER_DELAY_MS);
            await spawnTmux(tmuxEnterArgv(tmux, session));
        },
        killTmuxSession: (session) => killTmuxSession(session),
        repoFs: liveRepoFs(),
        nonce: () => randomBytes(3).toString("hex"),
        ensureTitle: (input) => ensureWorkspaceTitle(input),
        surfaceIds: async (surface) => {
            const result = await runCmux(["--id-format", "both", "tree"], { json: true });

            if (result.code !== 0) {
                throw new Error(`cmux tree failed (${result.code}): ${result.stderr.trim()}`);
            }

            const live = parseCmuxTree(result.stdout).surfaces.get(surface);
            return live ? { workspaceId: live.workspaceId, surfaceId: live.id } : null;
        },
    };
}
