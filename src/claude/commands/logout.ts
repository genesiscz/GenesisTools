import { out } from "@app/logger";
import { AIConfig } from "@app/utils/ai/AIConfig";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import type { AIAccountEntry, AIAccountTokens } from "@app/utils/config/ai.types";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

type LogoutScope = "oauth" | "long" | "both";

interface LogoutOptions {
    oauth?: boolean;
    longLived?: boolean;
    both?: boolean;
    yes?: boolean;
}

function maskToken(token: string): string {
    if (token.length < 24) {
        return "****";
    }
    return `${token.slice(0, 16)}…${token.slice(-4)}`;
}

function hasOAuthPair(acc: AIAccountEntry): boolean {
    return Boolean(acc.tokens.accessToken || acc.tokens.refreshToken);
}

function tokenInventory(acc: AIAccountEntry): string {
    const parts: string[] = [];

    if (hasOAuthPair(acc)) {
        parts.push("oauth");
    }

    if (acc.tokens.longLivedToken) {
        parts.push("long-lived");
    }

    return parts.length > 0 ? parts.join(" + ") : "no tokens";
}

function scopeFromFlags(opts: LogoutOptions): LogoutScope | undefined {
    if (opts.both) {
        return "both";
    }

    if (opts.oauth && opts.longLived) {
        return "both";
    }

    if (opts.oauth) {
        return "oauth";
    }

    if (opts.longLived) {
        return "long";
    }

    return undefined;
}

function describeScope(scope: LogoutScope, acc: AIAccountEntry): string[] {
    const lines: string[] = [];

    if (scope === "oauth" || scope === "both") {
        const access = acc.tokens.accessToken ? maskToken(acc.tokens.accessToken) : pc.dim("none");
        const refresh = acc.tokens.refreshToken ? maskToken(acc.tokens.refreshToken) : pc.dim("none");
        lines.push(`Access token:     ${access}`);
        lines.push(`Refresh token:    ${refresh}`);
        lines.push(pc.yellow("→ usage polling stops for this account (tools claude usage)"));
    }

    if (scope === "long" || scope === "both") {
        const long = acc.tokens.longLivedToken ? maskToken(acc.tokens.longLivedToken) : pc.dim("none");
        lines.push(`Long-lived token: ${long}`);
        lines.push(pc.yellow("→ tools claude start/run stops working for this account"));
    }

    return lines;
}

async function pickAccount(accounts: AIAccountEntry[]): Promise<string | null> {
    const picked = await p.select({
        message: "Logout which account?",
        options: accounts.map((acc) => ({
            value: acc.name,
            label: acc.label ? `${acc.name} ${pc.dim(`(${acc.label})`)}` : acc.name,
            hint: tokenInventory(acc),
        })),
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked as string;
}

async function pickScope(acc: AIAccountEntry): Promise<LogoutScope | null> {
    const oauth = hasOAuthPair(acc);
    const long = Boolean(acc.tokens.longLivedToken);

    const options: Array<{ value: LogoutScope; label: string; hint: string }> = [];

    if (oauth) {
        options.push({
            value: "oauth",
            label: "Access + refresh token",
            hint: "stops usage polling; long-lived token (start/run) keeps working",
        });
    }

    if (long) {
        options.push({
            value: "long",
            label: "Long-lived token",
            hint: "tools claude start/run stops working; usage polling keeps working",
        });
    }

    if (oauth && long) {
        options.push({ value: "both", label: "Both", hint: "full logout — account entry stays in config" });
    }

    const picked = await p.select({ message: "Remove which tokens?", options });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked as LogoutScope;
}

export function registerLogoutCommand(program: Command): void {
    program
        .command("logout [name]")
        .description("Remove saved tokens from an account (OAuth pair, long-lived token, or both)")
        .option("--oauth", "Remove the access + refresh token (stops usage polling)")
        .option("--long-lived", "Remove the long-lived token (used by start/run)")
        .option("--both", "Remove all tokens")
        .option("-y, --yes", "Skip the confirmation prompt")
        .action(async (name: string | undefined, opts: LogoutOptions) => {
            const aiConfig = await AIConfig.load();
            const accounts = aiConfig.getAccountsByProvider("anthropic-sub");

            if (accounts.length === 0) {
                out.error(pc.red("No Claude accounts configured."));
                process.exit(1);
            }

            let accountName = name;

            if (accountName) {
                if (!accounts.some((a) => a.name === accountName)) {
                    out.error(pc.red(`Account "${accountName}" not found.`));
                    out.printlnErr(pc.dim(`Known: ${accounts.map((a) => a.name).join(", ")}`));
                    process.exit(1);
                }
            } else {
                if (!isInteractive()) {
                    out.error(pc.red("Account name required in non-interactive mode."));
                    out.printlnErr(
                        suggestCommand("tools claude logout", {
                            add: [accounts[0]?.name ?? "<name>", "--oauth", "--yes"],
                        })
                    );
                    process.exit(1);
                }

                const picked = await pickAccount(accounts);
                if (!picked) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }

                accountName = picked;
            }

            const account = accounts.find((a) => a.name === accountName)!;

            if (!hasOAuthPair(account) && !account.tokens.longLivedToken) {
                p.log.warn(`Account "${accountName}" has no tokens to remove.`);
                process.exit(0);
            }

            let scope = scopeFromFlags(opts);

            if (scope) {
                if ((scope === "oauth" || scope === "both") && !hasOAuthPair(account)) {
                    out.error(pc.red(`Account "${accountName}" has no access/refresh token.`));
                    process.exit(1);
                }

                if ((scope === "long" || scope === "both") && !account.tokens.longLivedToken) {
                    out.error(pc.red(`Account "${accountName}" has no long-lived token.`));
                    process.exit(1);
                }
            } else {
                if (!isInteractive()) {
                    out.error(pc.red("Token scope required in non-interactive mode."));
                    out.printlnErr(
                        suggestCommand("tools claude logout", {
                            add: [accountName, "--oauth|--long-lived|--both", "--yes"],
                        })
                    );
                    process.exit(1);
                }

                const picked = await pickScope(account);
                if (!picked) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }

                scope = picked;
            }

            if (!opts.yes) {
                if (!isInteractive()) {
                    out.error(pc.red("Confirmation required: pass --yes in non-interactive mode."));
                    process.exit(1);
                }

                p.note(describeScope(scope, account).join("\n"), `Logout "${accountName}"`);

                const confirmed = await p.confirm({
                    message: "Remove these tokens?",
                    initialValue: false,
                });

                if (p.isCancel(confirmed) || !confirmed) {
                    p.cancel("Cancelled — nothing removed.");
                    process.exit(0);
                }
            }

            const tokens: AIAccountTokens = { ...account.tokens };

            if (scope === "oauth" || scope === "both") {
                delete tokens.accessToken;
                delete tokens.refreshToken;
                delete tokens.expiresAt;
            }

            if (scope === "long" || scope === "both") {
                delete tokens.longLivedToken;
            }

            await aiConfig.updateAccount(accountName, { tokens });

            const removed =
                scope === "both" ? "all tokens" : scope === "oauth" ? "access + refresh token" : "long-lived token";
            p.log.success(`Removed ${removed} from "${accountName}".`);

            const remaining = tokenInventory({ ...account, tokens });
            p.log.info(pc.dim(`Remaining: ${remaining}. Account entry kept in config.`));
            p.log.info(
                pc.dim(
                    `Re-login: ${pc.cyan(`tools claude login ${accountName}`)} · ` +
                        `full removal: ${pc.cyan(`tools claude config remove ${accountName}`)}`
                )
            );
        });
}
