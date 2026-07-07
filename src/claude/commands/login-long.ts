import { out } from "@app/logger";
import { AIConfig } from "@app/utils/ai/AIConfig";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { copyToClipboard } from "@app/utils/clipboard";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const TOKEN_PREFIX = "sk-ant-oat";
const SETUP_COMMAND = "claude setup-token";

function maskToken(token: string): string {
    if (token.length < 24) {
        return "****";
    }
    return `${token.slice(0, 20)}…${token.slice(-4)}`;
}

export function registerLoginLongCommand(program: Command): void {
    program
        .command("login-long [name]")
        .description("Save a long-lived OAuth token (from `claude setup-token`) to an existing account")
        .action(async (name?: string) => {
            const aiConfig = await AIConfig.load();
            const accounts = aiConfig.getAccountsByProvider("anthropic-sub");

            if (accounts.length === 0) {
                out.error(pc.red("No Claude accounts configured yet."));
                out.println(pc.dim(`Run ${pc.cyan("tools claude login")} first, then rerun this command.`));
                process.exit(1);
            }

            let accountName = name;

            if (accountName) {
                if (!aiConfig.getAccount(accountName)) {
                    out.error(pc.red(`Account "${accountName}" not found.`));
                    out.println(pc.dim(`Known: ${accounts.map((a) => a.name).join(", ")}`));
                    process.exit(1);
                }

                if (!isInteractive()) {
                    out.error(pc.red("Pasting the long-lived token requires an interactive terminal."));
                    process.exit(1);
                }
            } else {
                if (!isInteractive()) {
                    out.error(pc.red("Account name required in non-interactive mode."));
                    out.println(suggestCommand("tools claude login-long", { add: [accounts[0]?.name ?? "<name>"] }));
                    process.exit(1);
                }

                const picked = await p.select({
                    message: "Which account should hold the long-lived token?",
                    options: accounts.map((acc) => {
                        const hasToken = Boolean(acc.tokens.longLivedToken);
                        const suffix = [
                            acc.label ? pc.dim(`(${acc.label})`) : "",
                            hasToken ? pc.yellow("has token — will overwrite") : "",
                        ]
                            .filter(Boolean)
                            .join(" ");
                        return {
                            value: acc.name,
                            label: suffix ? `${acc.name} ${suffix}` : acc.name,
                        };
                    }),
                });

                if (p.isCancel(picked)) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }

                accountName = picked as string;
            }

            const account = aiConfig.getAccount(accountName)!;

            if (account.tokens.longLivedToken) {
                const overwrite = await p.confirm({
                    message: `"${accountName}" already has a long-lived token (${maskToken(account.tokens.longLivedToken)}). Overwrite?`,
                    initialValue: false,
                });
                if (p.isCancel(overwrite) || !overwrite) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }
            }

            const clipboardOk = await copyToClipboard(SETUP_COMMAND, { silent: true })
                .then(() => true)
                .catch(() => false);

            p.note(
                [
                    `1. Open a ${pc.bold("new terminal")} tab/window.`,
                    `   (${SETUP_COMMAND} is a full-screen TUI — running it in this process suspends the paste prompt.)`,
                    `2. Run:  ${pc.cyan(SETUP_COMMAND)}${clipboardOk ? pc.dim("   (copied to clipboard)") : ""}`,
                    `3. Complete the OAuth flow (open the URL, click Authorize, paste the code).`,
                    `4. Claude prints a token starting with ${pc.cyan(TOKEN_PREFIX)}. Copy it.`,
                    `5. Return here and paste the token below.`,
                ].join("\n"),
                `Attach long-lived token to "${accountName}"`
            );

            const token = await p.password({
                message: `Paste the long-lived token (${TOKEN_PREFIX}...):`,
                validate: (val) => {
                    if (!val?.trim()) {
                        return "Token is required";
                    }
                    if (!val.trim().startsWith(TOKEN_PREFIX)) {
                        return `Token must start with "${TOKEN_PREFIX}"`;
                    }
                },
            });

            if (p.isCancel(token)) {
                p.cancel("Cancelled");
                process.exit(0);
            }

            const trimmed = (token as string).trim();

            await aiConfig.updateAccount(accountName, {
                tokens: { ...account.tokens, longLivedToken: trimmed },
            });

            p.log.success(
                `Long-lived token saved to "${accountName}" (${maskToken(trimmed)}). ` +
                    `Launch Claude with: ${pc.cyan(`tools claude start ${accountName}`)}`
            );
        });
}
