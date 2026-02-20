import { resolve } from "node:path";
import type { ExecResult } from "./executor";

const TOOLS_PATH = resolve(import.meta.dir, "../../../tools");

export interface RunToolOptions {
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
}

/**
 * Spawn a GenesisTools tool and capture its output.
 * Usage: `runTool(["claude", "usage"])` runs `tools claude usage`
 */
export async function runTool(args: string[], options?: RunToolOptions): Promise<ExecResult> {
    const proc = Bun.spawn(["bun", "run", TOOLS_PATH, ...args], {
        cwd: options?.cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...options?.env },
        ...(options?.timeout ? { timeout: options.timeout } : {}),
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return {
        success: exitCode === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
    };
}

/**
 * Spawn a GenesisTools tool with inherited stdio (interactive).
 * Usage: `runToolInteractive(["telegram-bot", "configure"])`
 */
export async function runToolInteractive(
    args: string[],
    options?: Omit<RunToolOptions, "timeout">
): Promise<ExecResult> {
    const proc = Bun.spawn(["bun", "run", TOOLS_PATH, ...args], {
        cwd: options?.cwd ?? process.cwd(),
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env, ...options?.env },
    });

    const exitCode = await proc.exited;

    return {
        success: exitCode === 0,
        stdout: "",
        stderr: "",
        exitCode,
    };
}
