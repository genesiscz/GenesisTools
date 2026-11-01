import type { EmbedLauncher } from "@app/ai/lib/embed/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { harnessPluginId } from "@genesiscz/utils/ai/providers/harness-index";

/**
 * The account name `tools claude run` gets for an embed request. `tools t3 providers add` and its doctor accept an
 * account's immutable id, as the Codex and Grok embed launchers do (`pickLaunchAccount` matches an id first), but
 * Claude's start resolves names only. So the id of a Claude account becomes its name here, an id before a name as in
 * the shared resolver, and any other value passes on unchanged for start to resolve or refuse.
 */
export function claudeEmbedAccountName(
    requested: string,
    accounts: readonly Pick<AccountEntry, "id" | "name">[]
): string {
    return accounts.find((account) => account.id === requested)?.name ?? requested;
}

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

        const name =
            request.kind === "account"
                ? claudeEmbedAccountName(
                      request.name,
                      (await AiConfigStore.readOnly()).accounts({ provider: harnessPluginId("claude") })
                  )
                : undefined;
        const { runClaudeStart } = await import("@app/claude/commands/start");
        await runClaudeStart(
            name,
            {
                sdk: true,
                autopick: request.kind === "auto",
            },
            argv
        );
    },
};
