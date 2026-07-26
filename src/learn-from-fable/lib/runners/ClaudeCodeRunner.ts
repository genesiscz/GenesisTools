import { extractJsonValue } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Runner, RunnerCall, RunnerResult } from "./types";

/**
 * Clean-room headless Claude Code call: `tools cc run <profile> -- -p` with
 * empty tools/settings/MCP (~0 token context floor, verified 2026-07-22 in the
 * SkillOpt cc_clean work). The auth profile is REQUIRED input — never defaulted.
 */
export class ClaudeCodeRunner implements Runner {
    readonly id: string;

    constructor(
        private readonly profile: string,
        private readonly model: string
    ) {
        if (!profile) {
            throw new Error("ClaudeCodeRunner requires an explicit cc profile (tools cc run <profile>)");
        }

        this.id = `claude-code:${profile}:${model}`;
    }

    async call(input: RunnerCall): Promise<RunnerResult> {
        const started = performance.now();
        let user = input.user;

        if (input.jsonSchema) {
            user +=
                `\n\nRespond ONLY with a JSON value valid against this JSON Schema (no prose, no code fences):\n` +
                SafeJSON.stringify(input.jsonSchema.schema, { strict: true });
        }

        const proc = Bun.spawn(
            [
                "tools",
                "cc",
                "run",
                this.profile,
                "--",
                "--strict-mcp-config",
                "--setting-sources",
                "",
                "--tools",
                "",
                "-p",
                "--output-format",
                "json",
                "--model",
                this.model,
                "--max-turns",
                "1",
                "--system-prompt",
                input.system,
                user,
            ],
            { stdout: "pipe", stderr: "pipe" }
        );

        const timeoutMs = input.timeoutMs ?? 240_000;
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        // Drain both pipes at once: reading stdout to completion first lets a chatty
        // stderr fill its buffer and block the child, which deadlocks the read.
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        clearTimeout(timer);

        if (code !== 0 || !stdout.trim()) {
            throw new Error(`claude-code runner failed (exit ${code}): ${stderr.slice(-300)}`);
        }

        // Tolerate a stray banner line: start at the last top-level object, not the
        // first brace (a banner containing "{" would otherwise poison the slice).
        // Subprocess stdout is not config, so it parses strictly.
        const lastTopLevel = stdout.lastIndexOf("\n{");
        const from = lastTopLevel === -1 ? Math.max(stdout.indexOf("{"), 0) : lastTopLevel + 1;
        const payload: { is_error?: boolean; result?: string } = SafeJSON.parse(stdout.slice(from), { strict: true });
        if (payload.is_error || typeof payload.result !== "string") {
            throw new Error(`claude-code runner error payload: ${stdout.slice(0, 300)}`);
        }

        const result: RunnerResult = {
            text: payload.result,
            elapsedMs: Math.round(performance.now() - started),
        };

        if (input.jsonSchema) {
            const { value, error } = extractJsonValue(payload.result);
            result.parsed = value;
            result.parseError = error;
        }

        logger.debug({ id: this.id, elapsedMs: result.elapsedMs }, "claude-code runner call done");
        return result;
    }
}
