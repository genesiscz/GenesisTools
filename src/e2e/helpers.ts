import { resolve } from "node:path";

const TOOLS_PATH = resolve(import.meta.dir, "..", "..", "tools");

// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for stripping ANSI
const ANSI_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]|\x1B\[[0-9;]*[A-Za-z]|\x1B\].*?\x07|\x1B\[[?]?[0-9;]*[a-zA-Z]/g;

export function stripAnsi(str: string): string {
    return str.replace(ANSI_RE, "");
}

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export async function runTool(args: string[], timeoutMs = 15_000): Promise<RunResult> {
    const proc = Bun.spawn(["bun", "run", TOOLS_PATH, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
    });

    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    clearTimeout(timeout);

    return { stdout, stderr, exitCode };
}
