import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "dev-dashboard:session-focus" });

export interface FocusedPane {
    workspaceId: string;
    workspaceName: string;
    paneId: string;
    surfaceId?: string;
    cwd?: string;
    sessionIds?: string[];
}

export type FocusSessionResult =
    | { ok: true; focused: FocusedPane; activated: boolean }
    | { ok: false; error: string; remedy: string };

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface FocusSessionDeps {
    /** Injected in tests so neither cmux nor the `tools` binary is required. */
    run?: (args: string[]) => Promise<RunResult>;
}

/** What `tools claude cmux focus --json` prints on stdout. */
interface FocusCliPayload {
    focused?: FocusedPane | null;
    activated?: boolean;
}

async function spawnTools(args: string[]): Promise<RunResult> {
    const proc = Bun.spawn(["tools", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { code, stdout, stderr };
}

/**
 * Focus the cmux pane a session already lives in, by delegating to the existing
 * `tools claude cmux focus <id> --first --json` CLI.
 *
 * The CLI is the one resolver: it knows recorded pane refs, the text matcher and the
 * stale-ref retry. Re-implementing any of that here would give the dashboard a second,
 * silently divergent answer to "where is this session?".
 */
export async function focusSessionPane(sessionId: string, deps: FocusSessionDeps = {}): Promise<FocusSessionResult> {
    const id = sessionId.trim();

    if (!id || id === "unknown") {
        return { ok: false, error: "This entry has no session id.", remedy: "Nothing to focus." };
    }

    const run = deps.run ?? spawnTools;
    const result = await run(["claude", "cmux", "focus", id, "--first", "--json"]);
    let payload: FocusCliPayload | null = null;

    try {
        payload = SafeJSON.parse(result.stdout, { strict: true }) as FocusCliPayload;
    } catch (err) {
        // Non-JSON stdout means the CLI died before it could answer (cmux unreachable,
        // `tools` missing). stderr carries the real reason, so surface that rather than
        // reporting "no pane", which would send the user looking in the wrong place.
        log.warn({ err, sessionId: id, code: result.code, stderr: result.stderr }, "cmux focus produced no JSON");

        return {
            ok: false,
            error: result.stderr.trim().split("\n")[0] || `focus exited ${result.code}`,
            remedy: "Check that cmux is running, then try again.",
        };
    }

    if (!payload?.focused) {
        return {
            ok: false,
            error: `No cmux pane is showing session ${id.slice(0, 8)}.`,
            remedy: "Reopen it with `tools claude cmux restore`.",
        };
    }

    log.info({ sessionId: id, paneId: payload.focused.paneId }, "focused a cmux pane for a qa entry");

    return { ok: true, focused: payload.focused, activated: payload.activated === true };
}

/** The exact command Genesis' MonitorModel.resumeCommand builds, so both UIs copy one string. */
export function resumeCommandFor(sessionId: string): string {
    return `tools claude run --resume ${sessionId}`;
}
