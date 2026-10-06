import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";

export async function showTrace(options: { directory: string; signal: AbortSignal }): Promise<void> {
    const directory = await realpath(options.directory);
    const result = SafeJSON.parse(await readFile(join(directory, "verification.json"), "utf8"), { strict: true }) as {
        trace?: string;
    };
    if (!result.trace) {
        throw new Error("This execution has no Playwright trace.");
    }
    const trace = await realpath(result.trace);
    if (!trace.startsWith(`${directory}/`)) {
        throw new Error("Trace must belong to the generated workspace.");
    }
    const node = Bun.which("node");
    if (!node) {
        throw new Error("The Playwright trace viewer requires Node.js.");
    }
    const cli = fileURLToPath(new URL("../../../node_modules/playwright/cli.js", import.meta.url));
    const child = spawn(node, [cli, "show-trace", trace, "--port", "0", "--host", "127.0.0.1"], {
        cwd: directory,
        env: { ...env.getProcessEnv(), COPILOT_CLI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => out.print(chunk.toString()));
    child.stderr.on("data", (chunk) => logger.debug({ output: String(chunk) }, "trace viewer"));
    const terminate = () => {
        child.kill("SIGTERM");
    };
    options.signal.addEventListener("abort", terminate, { once: true });
    process.stdin.resume();
    process.stdin.once("end", terminate);
    const timer = setTimeout(terminate, 120_000);
    if (options.signal.aborted) {
        terminate();
    }
    await new Promise<void>((accept, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
            code === 0 || code === null ? accept() : reject(new Error(`Trace viewer exited ${code}`))
        );
    }).finally(() => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", terminate);
        process.stdin.off("end", terminate);
        process.stdin.pause();
    });
}
