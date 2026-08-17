import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { createKit, text } from "../lib/kit.ts";
import { parseSelector } from "../lib/match.ts";
import { enabledServers, loadRegistry } from "../lib/registry.ts";

/**
 * MCP tool arguments are always a JSON object; catch `[1,2]` / `"x"` / `5` at
 * the CLI boundary with a message naming the input, not deep inside the
 * transport. Exported for tests.
 */
export function asArgsObject(parsed: unknown, source: string): Record<string, unknown> {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(
            `Arguments from ${source} must be a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`
        );
    }

    return parsed as Record<string, unknown>;
}

async function resolveArgs(
    argsJson: string | undefined,
    argsFile: string | undefined
): Promise<Record<string, unknown> | undefined> {
    if (argsFile) {
        const raw = argsFile === "-" ? await Bun.stdin.text() : await Bun.file(argsFile).text();
        return asArgsObject(SafeJSON.parse(raw), argsFile === "-" ? "stdin" : argsFile);
    }

    if (argsJson) {
        // SafeJSON (comment-json) so trailing commas and comments survive shell quoting experiments.
        return asArgsObject(SafeJSON.parse(argsJson), "the args argument");
    }

    return undefined;
}

export function registerCall(program: Command): void {
    program
        .command("call <ref> [args]")
        .description("One-shot call. ref is '<server>.<tool>', args is a JSON object.")
        .option("--args-file <path>", "Read the JSON arguments from a file, or '-' for stdin")
        .option("--json", "Print the raw MCP result envelope instead of just text")
        .option("--timeout <ms>", "Per-call timeout", "120000")
        .action(
            async (
                ref: string,
                argsJson: string | undefined,
                opts: { argsFile?: string; json?: boolean; timeout: string }
            ) => {
                const registry = await loadRegistry();
                const available = enabledServers(registry).map((s) => s.name);
                const selector = parseSelector(ref, available);

                if (selector.tool === "*" || selector.tool.includes("*")) {
                    throw new Error(`'${ref}' must name exactly one tool, not a pattern`);
                }

                const timeoutMs = Number(opts.timeout);

                if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                    throw new Error(`--timeout must be a positive number of milliseconds, got '${opts.timeout}'.`);
                }

                const args = await resolveArgs(argsJson, opts.argsFile);
                const kit = await createKit({ servers: [selector.server], timeoutMs });

                try {
                    const result = await kit.call(selector.server, selector.tool, args);

                    if (opts.json) {
                        out.result(result);
                    } else {
                        out.print(text(result));
                    }
                } finally {
                    await kit.close();
                }
            }
        );
}
