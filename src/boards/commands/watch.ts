import { hostname } from "node:os";
import type { ListenerDto, WaitResultDto } from "@app/dev-dashboard/contract/dto";
import { paths, type WorkListRes } from "@app/dev-dashboard/contract/endpoints";
import { printLn } from "@app/utils/cli";
import { writeStderr } from "@app/utils/cli/stderr";
import { wakefulSleep } from "@app/utils/wakeful";
import type { Command } from "commander";
import { computeAnnouncements, type SeenMap } from "../lib/announce";
import { getJson, postJson, rawRequest, resolveBaseUrl } from "../lib/client";
import { currentBranch, defaultProject } from "../lib/config";

export type Scope =
    | { kind: "all" }
    | { kind: "board"; board: string }
    | { kind: "project"; project: string; branch: string };

interface ConflictBody {
    error: string;
    live: true;
    holder: ListenerDto;
}

function scopeToWaitQuery(scope: Scope, extra: Record<string, string | undefined>): Record<string, string | undefined> {
    if (scope.kind === "all") {
        return { ...extra, all: "1" };
    }
    if (scope.kind === "board") {
        return { ...extra, board: scope.board };
    }
    return { ...extra, project: scope.project, branch: scope.branch };
}

function scopeToWorkQuery(scope: Scope): { status: string; board?: string; project?: string; branch?: string } {
    if (scope.kind === "board") {
        return { status: "open", board: scope.board };
    }
    if (scope.kind === "project") {
        return { status: "open", project: scope.project, branch: scope.branch };
    }
    return { status: "open" };
}

export function resolveScope(
    opts: { board?: string; project?: string; branch?: string; all?: boolean },
    cwd: string
): Scope {
    if (opts.all) {
        return { kind: "all" };
    }
    if (opts.board) {
        return { kind: "board", board: opts.board };
    }
    if (opts.project) {
        return { kind: "project", project: opts.project, branch: opts.branch ?? currentBranch(cwd) };
    }
    return { kind: "project", project: defaultProject(cwd), branch: currentBranch(cwd) };
}

interface AttemptDeps {
    base: string;
    scope: Scope;
    session: string;
    actor: string;
    takeover: boolean;
    timeoutSec: number;
    seen: SeenMap;
    signal: AbortSignal;
}

type AttemptResult =
    | { kind: "idle"; leaseId?: number; seen: SeenMap }
    | { kind: "announced"; leaseId?: number; seen: SeenMap; lines: string[] }
    | { kind: "conflict"; holder: ListenerDto };

async function watchAttempt(deps: AttemptDeps): Promise<AttemptResult> {
    const query = scopeToWaitQuery(deps.scope, {
        timeout: String(deps.timeoutSec),
        session: deps.session,
        actor: deps.actor,
        ...(deps.takeover ? { takeover: "1" } : {}),
    });
    const { status, body } = await rawRequest<WaitResultDto | ConflictBody>(deps.base, paths.workWait(query), {
        signal: deps.signal,
    });

    if (status === 409) {
        return { kind: "conflict", holder: (body as ConflictBody).holder };
    }
    if (status < 200 || status >= 300) {
        throw new Error(`work/wait -> ${status}`);
    }

    const wait = body as WaitResultDto;
    if (wait.idle) {
        // vitrinka semantics: idle resets the seen map, so a later reopen re-announces.
        return { kind: "idle", leaseId: wait.listener, seen: new Map() };
    }

    const workList = await getJson<WorkListRes>(deps.base, paths.work(scopeToWorkQuery(deps.scope)), deps.signal);
    const { lines, next } = computeAnnouncements(deps.seen, workList.work);
    return { kind: "announced", leaseId: wait.listener, seen: next, lines };
}

export interface RunWatchOptions {
    base: string;
    scope: Scope;
    session: string;
    actor: string;
    once: boolean;
    takeover: boolean;
    print?: (line: string) => Promise<void>;
    /** Injectable for tests — defaults to `wakefulSleep` (real, sleep-resistant delay). */
    sleep?: (ms: number, options: { shouldAbort: () => boolean }) => Promise<void>;
}

const DEGRADED_THRESHOLD_MS = 120_000;
const DEGRADED_REEMIT_MS = 600_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// /work/wait returns IMMEDIATELY (no blocking) whenever the scope already has open work —
// the long-poll only blocks while the queue is empty. Without this pace, a single standing
// open annotation turns the continuous loop into a zero-delay busy-spin against the server.
export const ANNOUNCED_POLL_PACE_MS = 3_000;

/** The watch loop's stdout is a contract — Monitor consumes it. Every line printed here
 *  (via `print`) is part of that protocol; everything else goes to stderr. Returns the
 *  process exit code rather than calling `process.exit` itself, so it stays testable. */
export async function runWatch(opts: RunWatchOptions): Promise<number> {
    const print = opts.print ?? printLn;
    const sleep = opts.sleep ?? wakefulSleep;
    let seen: SeenMap = new Map();
    let leaseId: number | undefined;
    let backoffMs = BACKOFF_START_MS;
    let downSince: number | null = null;
    let wasDegraded = false;
    let lastDegradedEmitAt: number | null = null;
    let stopping = false;

    const controller = new AbortController();
    const onSignal = (): void => {
        stopping = true;
        controller.abort();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    const release = async (): Promise<void> => {
        if (leaseId === undefined) {
            return;
        }
        try {
            await postJson(opts.base, paths.workListener(leaseId), undefined, "DELETE");
        } catch {
            // Best-effort — the process is exiting either way.
        }
    };

    try {
        for (;;) {
            if (stopping) {
                await release();
                return 0;
            }

            try {
                const result = await watchAttempt({
                    base: opts.base,
                    scope: opts.scope,
                    session: opts.session,
                    actor: opts.actor,
                    takeover: opts.takeover,
                    timeoutSec: opts.once ? 1 : 55,
                    seen,
                    signal: controller.signal,
                });

                if (wasDegraded) {
                    await print("✓ boards reachable again");
                    wasDegraded = false;
                }
                downSince = null;
                lastDegradedEmitAt = null;
                backoffMs = BACKOFF_START_MS;

                if (result.kind === "conflict") {
                    await writeStderr(
                        `boards watch: scope held by ${result.holder.session} (actor=${result.holder.actor})\n`
                    );
                    await print(`⚠ boards scope held by live listener ${result.holder.session}`);
                    await release();
                    return 2;
                }

                leaseId = result.leaseId ?? leaseId;
                seen = result.seen;

                if (result.kind === "idle") {
                    if (opts.once) {
                        await release();
                        return 3;
                    }
                    continue;
                }

                for (const line of result.lines) {
                    await print(line);
                }

                if (opts.once) {
                    await release();
                    return 0;
                }

                // Pace the next check: an immediate re-poll would just echo the same still-open
                // items right back (0 new lines) in a tight loop until they're claimed/resolved.
                await sleep(ANNOUNCED_POLL_PACE_MS, { shouldAbort: () => stopping });
            } catch (err) {
                if (stopping) {
                    continue;
                }

                if (opts.once) {
                    await writeStderr(`boards watch: ${err instanceof Error ? err.message : String(err)}\n`);
                    return 1;
                }

                downSince ??= Date.now();
                const downMs = Date.now() - downSince;
                const shouldEmitDegraded =
                    downMs >= DEGRADED_THRESHOLD_MS &&
                    (lastDegradedEmitAt === null || Date.now() - lastDegradedEmitAt >= DEGRADED_REEMIT_MS);
                if (shouldEmitDegraded) {
                    await print(`⚠ boards unreachable for ${Math.floor(downMs / 1000)}s — listener degraded`);
                    lastDegradedEmitAt = Date.now();
                    wasDegraded = true;
                }

                await writeStderr(
                    `boards watch: transport error: ${err instanceof Error ? err.message : String(err)}\n`
                );
                await sleep(backoffMs, { shouldAbort: () => stopping });
                backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
            }
        }
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
}

export function registerWatchCommand(program: Command): void {
    program
        .command("watch")
        .description("Listen for open annotation work and print zero-token-idle announcements")
        .option("--board <slug>", "scope to one board")
        .option("--project <name>", "scope to a project (matches the card's set_ref prefix)")
        .option("--branch <name>", "branch within --project (defaults to the current git branch)")
        .option("--all", "scope to every board/project")
        .option("--once", "single wait cycle then exit (0=work announced, 3=idle, 2=conflict)")
        .option("--base <url>", "dev-dashboard base URL")
        .option("--takeover", "accepted for CLI parity — expired leases are reaped automatically")
        .action(
            async (opts: {
                board?: string;
                project?: string;
                branch?: string;
                all?: boolean;
                once?: boolean;
                base?: string;
                takeover?: boolean;
            }) => {
                const cwd = process.cwd();
                const base = resolveBaseUrl(opts.base);
                const scope = resolveScope(opts, cwd);
                const session = `${hostname()}:${process.pid}`;

                let actor = "operator";
                try {
                    const op = await getJson<{ operator: string }>(base, paths.boardsOperator());
                    actor = op.operator || "operator";
                } catch {
                    // Keep the default actor; the loop's own error handling covers connectivity issues.
                }

                const exitCode = await runWatch({
                    base,
                    scope,
                    session,
                    actor,
                    once: opts.once === true,
                    takeover: opts.takeover === true,
                });
                process.exit(exitCode);
            }
        );
}
