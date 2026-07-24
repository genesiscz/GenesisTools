import * as p from "@clack/prompts";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { INFERENCE_SCOPE, ONE_YEAR_SECONDS } from "@genesiscz/utils/claude/auth";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { generateAuthUrl, presentAuthUrl, promptAndExchangeCode } from "./config";

const TOKEN_PREFIX = "sk-ant-oat";
const SETUP_COMMAND = "claude setup-token";

function maskToken(token: string): string {
    if (token.length < 24) {
        return "****";
    }
    return `${token.slice(0, 20)}…${token.slice(-4)}`;
}

/**
 * Mint a 1-year token ourselves instead of shelling out to `claude setup-token`.
 * The server only accepts a custom `expires_in` when the grant carries
 * INFERENCE_SCOPE alone, so this flow deliberately requests nothing else —
 * the resulting token can run inference but cannot read usage or profile.
 */
async function mintLongLivedToken(accountName: string): Promise<{ token: string; expiresAt: number } | null> {
    p.note(
        [
            "This runs the same OAuth flow as `claude setup-token`, in this terminal.",
            `Scope requested: ${pc.cyan(INFERENCE_SCOPE)} only — the one combination the`,
            "server grants a 1-year token for.",
        ].join("\n"),
        `Mint a long-lived token for "${accountName}"`
    );

    const authUrl = await generateAuthUrl(INFERENCE_SCOPE);
    await presentAuthUrl(authUrl);

    // The PKCE session survives a failed exchange, so a fumbled paste costs one
    // retry rather than the whole browser round-trip.
    let tokens = await promptAndExchangeCode({ expiresIn: ONE_YEAR_SECONDS });

    while (!tokens) {
        const again = await p.confirm({ message: "Try pasting the code again?", initialValue: true });

        if (p.isCancel(again) || !again) {
            return null;
        }

        tokens = await promptAndExchangeCode({ expiresIn: ONE_YEAR_SECONDS });
    }

    if (!tokens.accessToken.startsWith(TOKEN_PREFIX)) {
        p.log.warn(`Token does not start with "${TOKEN_PREFIX}" — saving anyway, but check it works.`);
    }

    return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
}

export function registerLoginLongCommand(program: Command): void {
    program
        .command("login-long [name]")
        .description(
            "Attach a long-lived OAuth token to an existing account — minted here via the " +
                "setup-token OAuth flow, or pasted from `claude setup-token`"
        )
        .option("--setup-token", "Skip the prompt and mint the token via the OAuth flow")
        .action(async (name: string | undefined, opts: { setupToken?: boolean }) => {
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
                    out.error(pc.red("Attaching a long-lived token requires an interactive terminal."));
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

            let method: "mint" | "paste" = "mint";

            if (!opts.setupToken) {
                const picked = await p.select({
                    message: "How should the long-lived token be obtained?",
                    options: [
                        {
                            value: "mint",
                            label: "Run the OAuth flow here",
                            hint: "authorize in the browser, paste the code — mints a 1-year token",
                        },
                        {
                            value: "paste",
                            label: "Paste a token I already have",
                            hint: `from ${SETUP_COMMAND} in another terminal`,
                        },
                    ],
                });

                if (p.isCancel(picked)) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }

                method = picked as "mint" | "paste";
            }

            if (method === "mint") {
                const minted = await mintLongLivedToken(accountName);

                if (!minted) {
                    p.cancel("Cancelled — nothing saved.");
                    process.exit(0);
                }

                await aiConfig.updateAccount(accountName, {
                    tokens: {
                        ...account.tokens,
                        longLivedToken: minted.token,
                        longLivedTokenExpiresAt: minted.expiresAt,
                    },
                });

                p.log.success(
                    `Long-lived token saved to "${accountName}" (${maskToken(minted.token)}), ` +
                        `valid until ${new Date(minted.expiresAt).toLocaleString()}. ` +
                        `Launch Claude with: ${pc.cyan(`tools claude start ${accountName}`)}`
                );
                return;
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
