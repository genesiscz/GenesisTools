import type { EmbedLauncher } from "@app/ai/lib/embed/types";

/**
 * Claude for an embedding app: `tools claude run --sdk` as the requested account, or the ai-proxy launch for a
 * `proxy:<account>/<provider>` request. Both run the real binary with no shell, so the app's permission mode applies.
 */
export const claudeEmbed: EmbedLauncher = {
    alias: "claude",
    hostProtocol: "claude-stream-json",
    async run({ request, argv }) {
        if (request.kind === "proxy") {
            const { runProxySession } = await import("@app/claude/commands/run");
            await runProxySession(request.target, { sdk: true }, argv);
            return;
        }

        const { runClaudeStart } = await import("@app/claude/commands/start");
        await runClaudeStart(
            request.kind === "account" ? request.name : undefined,
            {
                sdk: true,
                autopick: request.kind === "auto",
            },
            argv
        );
    },
};
