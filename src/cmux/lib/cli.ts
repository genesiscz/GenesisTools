import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export interface CmuxRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

const CMUX_FALLBACK_DIRS = [".local/bin", ".bun/bin", ".cargo/bin"];
const CMUX_SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

let cachedCmuxPath: string | null = null;

function resolveCmuxPath(): string {
    if (cachedCmuxPath) {
        return cachedCmuxPath;
    }

    const fromPath = Bun.which("cmux");
    if (fromPath) {
        cachedCmuxPath = fromPath;
        return fromPath;
    }

    const home = homedir();
    const candidates = [
        ...CMUX_FALLBACK_DIRS.map((dir) => join(home, dir, "cmux")),
        ...CMUX_SYSTEM_DIRS.map((dir) => join(dir, "cmux")),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            logger.debug({ candidate }, "[cmux] resolved via fallback dir (not on PATH)");
            cachedCmuxPath = candidate;
            return candidate;
        }
    }

    const searched = ["PATH", ...candidates].join(", ");
    throw new Error(`cmux is not installed (or not found in ${searched})`);
}

export async function runCmux(args: string[], opts: { json?: boolean } = {}): Promise<CmuxRunResult> {
    const finalArgs = opts.json ? ["--json", ...args] : args;
    const cmuxPath = resolveCmuxPath();
    logger.debug({ args: finalArgs, cmuxPath }, "[cmux] spawn");
    const proc = Bun.spawn([cmuxPath, ...finalArgs], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode === null) {
        throw new Error(`cmux terminated by signal before exiting`);
    }
    return { code: exitCode, stdout, stderr };
}

export async function runCmuxJSON<T = unknown>(args: string[]): Promise<T> {
    const result = await runCmux(args, { json: true });
    if (result.code !== 0) {
        const message = `cmux ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`;
        logger.error({ args, code: result.code, stderr: result.stderr }, "[cmux] command failed");
        throw new Error(message);
    }
    try {
        return SafeJSON.parse(result.stdout, { strict: true }) as T;
    } catch (error) {
        logger.error({ args, stdout: result.stdout.slice(0, 500), error }, "[cmux] non-JSON response on --json call");
        throw new Error(`cmux ${args.join(" ")} returned non-JSON output:\n${result.stdout.slice(0, 500)}\n(${error})`);
    }
}

export async function runCmuxOk(args: string[]): Promise<CmuxRunResult> {
    const result = await runCmux(args);
    if (result.code !== 0) {
        logger.error({ args, code: result.code, stderr: result.stderr }, "[cmux] command failed");
        throw new Error(`cmux ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result;
}
