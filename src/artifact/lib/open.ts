import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "@genesiscz/utils/browser";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage";
import { resolveTarget } from "./registry";
import { findRunning } from "./running";

const ARTIFACT_ENTRY = join(import.meta.dir, "..", "index.ts");

export interface OpenArtifactDeps {
    findPort(target: string): number | undefined;
    startServer(target: string): void;
    /** True once anything answers on the URL (a 404 page still means the server is up). */
    answers(url: string): Promise<boolean>;
    open(url: string): Promise<void>;
    sleep(ms: number): Promise<void>;
    now(): number;
    /** Runs `run` while no other open of the same artifact runs its own. Default: a per-folder file lock. */
    singleFlight?<T>(options: { target: string; waitMs: number; run: () => Promise<T> }): Promise<T>;
}

export interface OpenArtifactOptions {
    target: string;
    /** Page inside the artifact (`report`, `data/view`); empty opens the catalog. */
    path?: string;
    timeoutMs?: number;
    deps?: OpenArtifactDeps;
}

export interface OpenArtifactResult {
    url: string;
    started: boolean;
}

/**
 * Open an artifact in the browser, starting its server first when none is running.
 * This is what a `https://genesis.tools/artifact/<name>/<page>` click runs.
 */
export async function openArtifact(options: OpenArtifactOptions): Promise<OpenArtifactResult> {
    const timeoutMs = options.timeoutMs ?? 20_000;

    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(`timeout must be a finite, non-negative number of seconds (got ${timeoutMs / 1000})`);
    }

    const deps = options.deps ?? defaultDeps();
    const deadline = deps.now() + timeoutMs;
    const singleFlight = deps.singleFlight ?? runDirectly;
    // The check and the start share one lock, held until the new server has registered: a second
    // click waits, then finds that server instead of starting another on the next free port.
    const { port, started } = await singleFlight({
        target: options.target,
        waitMs: timeoutMs,
        run: async () => {
            const running = deps.findPort(options.target);

            if (running !== undefined) {
                return { port: running, started: false };
            }

            deps.startServer(options.target);

            return { port: await waitForPort({ deps, target: options.target, deadline, timeoutMs }), started: true };
        },
    });
    const url = pageUrl(port, options.path);

    while (!(await deps.answers(url))) {
        await sleepUntil({ deps, target: options.target, deadline, timeoutMs });
    }

    await deps.open(url);
    logger.info({ target: options.target, url, started }, "artifact opened");

    return { url, started };
}

function runDirectly<T>({ run }: { run: () => Promise<T> }): Promise<T> {
    return run();
}

interface Deadline {
    deps: OpenArtifactDeps;
    target: string;
    deadline: number;
    timeoutMs: number;
}

async function waitForPort(wait: Deadline): Promise<number> {
    while (true) {
        const port = wait.deps.findPort(wait.target);

        if (port !== undefined) {
            return port;
        }

        await sleepUntil(wait);
    }
}

/** One poll step toward the deadline; past it, the open fails with the log to read. */
async function sleepUntil({ deps, target, deadline, timeoutMs }: Deadline): Promise<void> {
    const remaining = deadline - deps.now();

    if (remaining <= 0) {
        throw new Error(
            `artifact "${target}" did not answer within ${Math.round(timeoutMs / 1000)} s (see tools artifact ps and ${serveLog(target)})`
        );
    }

    await deps.sleep(Math.min(250, remaining));
}

export function pageUrl(port: number, path?: string): string {
    const page = (path ?? "").replace(/^\/+/, "");

    return `http://127.0.0.1:${port}/${page}`;
}

/**
 * The port of the server already serving `target`. `serve` records the canonical directory, so a
 * name, file or relative path is resolved first; the raw text is never port-matched (`3100-report`).
 */
export function runningArtifactPort(target: string): number | undefined {
    return findRunning(resolveTarget(target).dir)?.server.port;
}

function serveLog(target: string): string {
    return join(tmpdir(), `artifact-open-${target.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
}

function defaultDeps(): OpenArtifactDeps {
    return {
        findPort: runningArtifactPort,
        startServer: (target) => {
            resolveTarget(target);
            const log = serveLog(target);
            // Detached (setsid): the click that started it exits right after the page opens.
            const child = Bun.spawn([process.execPath, ARTIFACT_ENTRY, "serve", target, "--no-open", "--no-register"], {
                stdin: "ignore",
                stdout: Bun.file(log),
                stderr: Bun.file(log),
                detached: true,
                env: env.getProcessEnv(),
            });
            child.unref();
            logger.info({ target, pid: child.pid, log }, "artifact server started for open");
        },
        answers: async (url) => {
            try {
                await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1500) });

                return true;
            } catch (error) {
                logger.debug({ url, error }, "artifact server not answering yet");

                return false;
            }
        },
        open: async (url) => {
            const result = await Browser.open(url, { browser: (await Browser.getPreferred()) ?? "brave" });

            if (!result.success) {
                throw new Error(result.error ?? `could not open ${url}`);
            }
        },
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
        singleFlight: ({ target, waitMs, run }) => withFileLock(startLockPath(target), run, waitMs),
    };
}

/** One lock per served folder, so a name and a path to the same folder share it. */
function startLockPath(target: string): string {
    return join(tmpdir(), `artifact-open-${Bun.hash(resolveTarget(target).dir).toString(36)}.lock`);
}
