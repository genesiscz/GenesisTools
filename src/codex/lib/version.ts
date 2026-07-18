import { env } from "@app/utils/env";

export async function detectCodexVersion(): Promise<string> {
    const proc = Bun.spawn({
        cmd: ["codex", "--version"],
        env: env.getProcessEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`Unable to run codex --version: ${stderr.trim() || `exit ${exitCode}`}`);
    }

    const match = stdout.match(/codex-cli\s+([^\s]+)/);
    if (!match?.[1]) {
        throw new Error(`Unexpected codex --version output: ${stdout.trim()}`);
    }

    return match[1];
}
