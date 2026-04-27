import { spawn } from "node:child_process";
import logger from "@app/logger";

export interface CmuxRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export async function runCmux(args: string[], opts: { json?: boolean } = {}): Promise<CmuxRunResult> {
    const finalArgs = opts.json ? ["--json", ...args] : args;
    logger.debug({ args: finalArgs }, "[cmux] spawn");
    return await new Promise<CmuxRunResult>((resolve, reject) => {
        const child = spawn("cmux", finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({ code: code ?? 0, stdout, stderr });
        });
    });
}

export async function runCmuxJSON<T = unknown>(args: string[]): Promise<T> {
    const result = await runCmux(args, { json: true });
    if (result.code !== 0) {
        const message = `cmux ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`;
        logger.error({ args, code: result.code, stderr: result.stderr }, "[cmux] command failed");
        throw new Error(message);
    }
    try {
        return JSON.parse(result.stdout) as T;
    } catch (error) {
        logger.error(
            { args, stdout: result.stdout.slice(0, 500), error },
            "[cmux] non-JSON response on --json call",
        );
        throw new Error(
            `cmux ${args.join(" ")} returned non-JSON output:\n${result.stdout.slice(0, 500)}\n(${error})`,
        );
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
