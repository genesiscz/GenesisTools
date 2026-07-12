import { out } from "@app/logger";
import { AIConfig } from "@app/utils/ai/AIConfig";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import type { AIAccountEntry, AISecondaryLogin } from "@app/utils/config/ai.types";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { fetchAndDisplayProfile, generateAuthUrl, presentAuthUrl, promptAndExchangeCode } from "./config";

function maskToken(token: string): string {
    if (token.length < 24) {
        return "****";
    }
    return `${token.slice(0, 16)}…${token.slice(-4)}`;
}

async function pickAccount(accounts: AIAccountEntry[]): Promise<string | null> {
    const picked = await p.select({
        message: "Attach the secondary login to which account?",
        options: accounts.map((acc) => ({
            value: acc.name,
            label: acc.label ? `${acc.name} ${pc.dim(`(${acc.label})`)}` : acc.name,
            hint: acc.secondary ? pc.yellow("has secondary login — will overwrite") : undefined,
        })),
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked as string;
}

export function registerLoginSecondaryCommand(program: Command): void {
    program
        .command("login-secondary [name]")
        .description(
            "OAuth login stored as a SECONDARY token set on an account — a separate grant used by " +
                "`tools claude start <name> --keychain`, never by usage polling"
        )
        .action(async (name?: string) => {
            if (!isInteractive()) {
                out.error(pc.red("login-secondary requires an interactive terminal (code paste)."));
                process.exit(1);
            }

            const aiConfig = await AIConfig.load();
            const accounts = aiConfig.getAccountsByProvider("anthropic-sub");

            if (accounts.length === 0) {
                out.error(pc.red("No Claude accounts configured. Run `tools claude login` first."));
                process.exit(1);
            }

            let accountName = name;

            if (accountName) {
                if (!aiConfig.getAccount(accountName)) {
                    out.error(pc.red(`Account "${accountName}" not found.`));
                    out.printlnErr(pc.dim(`Known: ${accounts.map((a) => a.name).join(", ")}`));
                    process.exit(1);
                }
            } else {
                const picked = await pickAccount(accounts);
                if (!picked) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }

                accountName = picked;
            }

            const account = accounts.find((a) => a.name === accountName)!;

            p.intro(pc.bgCyan(pc.black(` secondary login → ${accountName} `)));
            p.log.info(
                `The account's primary tokens (usage polling) and long-lived token stay untouched.\n` +
                    `${pc.dim("Log into the matching Anthropic account in the browser before authorizing.")}`
            );

            if (account.secondary) {
                const overwrite = await p.confirm({
                    message:
                        `"${accountName}" already has a secondary login ` +
                        `(${maskToken(account.secondary.accessToken)}${account.secondary.emailAddress ? `, ${account.secondary.emailAddress}` : ""}). Overwrite?`,
                    initialValue: false,
                });

                if (p.isCancel(overwrite) || !overwrite) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }
            }

            const authUrl = await generateAuthUrl();
            await presentAuthUrl(authUrl);

            const tokens = await promptAndExchangeCode();
            if (!tokens) {
                p.cancel("Cancelled — no tokens retrieved.");
                process.exit(0);
            }

            const profile = await fetchAndDisplayProfile(tokens);

            // Guard the sync-back match key: an unexpected identity here would
            // route future keychain rotations to the wrong account.
            if (
                account.secondary?.accountUuid &&
                tokens.account?.uuid &&
                account.secondary.accountUuid !== tokens.account.uuid
            ) {
                const proceed = await p.confirm({
                    message:
                        `This grant belongs to ${tokens.account.email ?? tokens.account.uuid}, but the previous ` +
                        `secondary login was a DIFFERENT Anthropic account. Save anyway?`,
                    initialValue: false,
                });

                if (p.isCancel(proceed) || !proceed) {
                    p.cancel("Cancelled — nothing saved.");
                    process.exit(0);
                }
            }

            const subscriptionType = profile?.account.has_claude_max
                ? "max"
                : profile?.account.has_claude_pro
                  ? "pro"
                  : null;

            const secondary: AISecondaryLogin = {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
                scopes: tokens.scopes,
                subscriptionType,
                rateLimitTier: profile?.organization.rate_limit_tier ?? null,
                accountUuid: tokens.account?.uuid,
                emailAddress: tokens.account?.email,
                organizationUuid: tokens.organization?.uuid,
            };

            await aiConfig.updateAccount(accountName, { secondary });

            p.log.success(
                `Secondary login saved to "${accountName}" (${maskToken(tokens.accessToken)}` +
                    `${tokens.account?.email ? `, ${tokens.account.email}` : ""}).`
            );
            p.outro(
                `Launch with it: ${pc.cyan(suggestCommand(`tools cc run ${accountName}`, { add: ["--keychain"] }))}`
            );
        });
}
