import { SafeJSON } from "@app/utils/json";
import logger from "@app/logger";

export interface CmuxRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export async function runCmux(args: string[], opts: { json?: boolean } = {}): Promise<CmuxRunResult> {
    const finalArgs = opts.json ? ["--json", ...args] : args;
    logger.debug({ args: finalArgs }, "[cmux] spawn");
    const proc = Bun.spawn(["cmux", ...finalArgs], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
        return SafeJSON.parse(result.stdout) as T;
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
