import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";

const { log } = logger.scoped("t3code:thread");

/**
 * The `t3` CLI of the running T3 Code app: the one its parent named (`T3CODE_CLI_PATH`), else the one T3 Code writes
 * into its home (`~/.t3/bin/t3`, a shell script that runs the desktop app's bundled server CLI). Undefined when
 * neither exists, so a caller can tell "no T3 Code" from a failed read.
 */
export function t3CliPath(): string | undefined {
    const named = env.t3.getCliPath();
    if (named && existsSync(named)) {
        return named;
    }

    const own = join(env.t3.getHome(), "bin", "t3");
    return existsSync(own) ? own : undefined;
}

/** What `t3 thread show --json` says of a thread. */
export interface T3ThreadState {
    threadId: string;
    title: string;
    /** `completed`, `running`, … as T3 Code reports it. */
    status: string;
    worktreePath: string | null;
    archived: boolean;
    /** The web link T3 Code prints (`https://app.t3.codes/threads/<environment>/<thread>`). */
    link: string | null;
}

const SHOW_TIMEOUT_MS = 15_000;

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJson(stdout: string): unknown {
    try {
        return SafeJSON.parse(stdout.trim(), { strict: true });
    } catch (error) {
        log.debug({ error, stdout: stdout.slice(0, 200) }, "t3 printed no JSON");
        return undefined;
    }
}

/** A refusal's first line, for the user; T3 Code prints its expected errors as one line on stderr. */
function firstLine(output: string): string {
    return output.trim().split("\n")[0]?.trim() ?? "";
}

/** The thread's state from `t3 thread show --json`, or null with the reason when T3 Code cannot show it. */
export async function showT3Thread(
    threadId: string,
    cli = t3CliPath()
): Promise<{ thread: T3ThreadState } | { reason: string }> {
    if (!cli) {
        return { reason: "T3 Code is not installed here (no t3 CLI)" };
    }

    const result = await boundedCommand({
        command: [cli, "thread", "show", "--json", "--messages", "0", threadId],
        timeoutMs: SHOW_TIMEOUT_MS,
    });
    const parsed = result.status === 0 ? parseJson(result.stdout) : undefined;
    const thread = isObject(parsed) && isObject(parsed.thread) ? parsed.thread : undefined;
    if (!thread || text(thread.threadId) !== threadId) {
        const reason = firstLine(result.stderr) || firstLine(result.stdout) || "T3 Code did not show the thread";
        log.debug({ threadId, status: result.status, reason }, "t3 thread show answered no thread");
        return { reason };
    }

    return {
        thread: {
            threadId,
            title: text(thread.title) ?? "",
            status: text(thread.status) ?? "unknown",
            worktreePath: text(thread.worktreePath),
            archived: thread.archived === true,
            link: text(thread.link),
        },
    };
}

/** How long a send may take: the CLI asks the running T3 Code server once and returns its receipt. */
const SEND_TIMEOUT_MS = 30_000;

/**
 * What one `t3 thread send` came to. `sent` carries T3 Code's receipt (`delivery` is `started`, `queued`, `steered` or
 * `restarted`). `refused` is an exit with an error before T3 Code took the message (no T3 Code, no server, no thread),
 * so nothing reached the thread. `unknown` is a send with no readable receipt: it may have arrived.
 */
export type T3SendOutcome =
    | { kind: "sent"; messageId: string; runId: string | null; delivery: string }
    | { kind: "refused"; reason: string }
    | { kind: "unknown"; reason: string };

/**
 * Sends a message to a T3 Code thread as its user (`t3 thread send --json <thread> <message>`): a busy thread gets it
 * as its next turn, nothing is interrupted. It reaches a session that only T3 Code runs, such as a Codex thread T3 Code
 * started, which has no worker, peer socket or terminal of ours.
 */
export async function sendT3ThreadMessage(
    threadId: string,
    message: string,
    cli = t3CliPath()
): Promise<T3SendOutcome> {
    if (!cli) {
        return { kind: "refused", reason: "T3 Code is not installed here (no t3 CLI)" };
    }

    const result = await boundedCommand({
        command: [cli, "thread", "send", "--json", threadId, message],
        timeoutMs: SEND_TIMEOUT_MS,
    });

    if (result.status === null) {
        log.warn({ threadId, signal: result.signal }, "t3 thread send did not finish in time");
        return { kind: "unknown", reason: "T3 Code did not answer in time; the message may have arrived." };
    }

    if (result.status !== 0) {
        const reason = firstLine(result.stderr) || firstLine(result.stdout) || `t3 exited ${result.status}`;
        log.info({ threadId, status: result.status, reason }, "t3 thread send was refused");
        return { kind: "refused", reason };
    }

    const receipt = parseJson(result.stdout);
    const messageId = isObject(receipt) ? text(receipt.messageId) : null;
    if (!isObject(receipt) || !messageId) {
        return { kind: "unknown", reason: "T3 Code printed no receipt; the message may have arrived." };
    }

    return {
        kind: "sent",
        messageId,
        runId: text(receipt.runId),
        delivery: text(receipt.delivery) ?? "sent",
    };
}

/**
 * The desktop app's link to a thread, from the web link `t3 thread show` prints
 * (`https://app.t3.codes/threads/<environment>/<thread>`): `t3code://threads/<environment>/<thread>`, the thread id
 * left percent-encoded as T3 Code prints it. A browser that is not paired with the environment shows only a pairing
 * page for the web link; the desktop app opens the thread. Undefined for a link of another shape.
 */
export function t3AppLink(webLink: string): string | undefined {
    let url: URL;
    try {
        url = new URL(webLink);
    } catch {
        return undefined;
    }

    const match = /^\/threads\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    return match ? `t3code://threads/${match[1]}/${match[2]}` : undefined;
}
