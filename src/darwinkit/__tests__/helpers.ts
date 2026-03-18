import { resolve } from "node:path";
import { SafeJSON } from "@app/utils/json";

const DARWINKIT_PATH = resolve(import.meta.dir, "../index.ts");

/**
 * Run a darwinkit CLI command and parse the JSON output.
 * Throws on non-zero exit or unparseable output.
 */
// biome-ignore lint/suspicious/noExplicitAny: CLI output can be any JSON type (object, array, string, number, boolean)
export async function runDarwinKit(...args: string[]): Promise<any> {
    const proc = Bun.spawn(["bun", "run", DARWINKIT_PATH, ...args, "--format", "json"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
    });

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`darwinkit ${args.join(" ")} exited with ${exitCode}: ${stderr || stdout}`);
    }

    const trimmed = stdout.trim();

    if (!trimmed) {
        throw new Error(`darwinkit ${args.join(" ")} produced no output`);
    }

    return SafeJSON.parse(trimmed, { unbox: true });
}

/**
 * Run a darwinkit CLI command and return raw stdout string.
 */
export async function runDarwinKitRaw(
    ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", DARWINKIT_PATH, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
    });

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

    const exitCode = await proc.exited;

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
