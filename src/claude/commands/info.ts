import { out } from "@app/logger";
import { AIConfig } from "@app/utils/ai/AIConfig";
import type { AIAccountEntry } from "@app/utils/config/ai.types";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { normalizeLimits } from "../lib/usage/limits";
import { peekSharedUsage } from "../lib/usage/shared-cache";

interface InfoOptions {
    format?: string;
}

interface AccountInfoPayload {
    name: string;
    label: string | null;
    /** Bucket key (five_hour, seven_day, seven_day_fable, ...) -> rounded percent. */
    usage: Record<string, number> | null;
    stale: boolean;
    fetchedAt: number | null;
}

/**
 * Token arrives on stdin (never argv — argv is visible in `ps` to every
 * process on the machine).
 */
async function readStdinToken(): Promise<string | null> {
    if (process.stdin.isTTY) {
        return null;
    }

    const token = (await Bun.stdin.text()).trim();
    return token.length > 0 ? token : null;
}

async function resolveAccount(name: string | undefined, aiConfig: AIConfig): Promise<AIAccountEntry | null> {
    const accounts = aiConfig.getAccountsByProvider("anthropic-sub");

    if (name) {
        return accounts.find((a) => a.name === name) ?? null;
    }

    const token = await readStdinToken();
    if (!token) {
        return null;
    }

    return accounts.find((a) => a.tokens.longLivedToken === token) ?? null;
}

async function buildPayload(account: AIAccountEntry): Promise<AccountInfoPayload> {
    // Passive cache read only — `tools claude info` must never hit the network
    // (it is called from the statusline on every cache-miss refresh).
    const cached = await peekSharedUsage();
    const accountUsage = cached?.accounts.find((a) => a.accountName === account.name);

    let usage: Record<string, number> | null = null;

    if (accountUsage?.usage) {
        usage = {};
        for (const limit of normalizeLimits(accountUsage.usage)) {
            usage[limit.bucket] = Math.round(limit.percent);
        }
    }

    return {
        name: account.name,
        label: account.label ?? null,
        usage,
        stale: Boolean(accountUsage?.stale),
        fetchedAt: cached?.fetchedAt ?? null,
    };
}

function printText(payload: AccountInfoPayload): void {
    out.print(`${payload.name}${payload.label ? ` (${payload.label})` : ""}`);

    if (!payload.usage) {
        out.print(pc.dim("  no cached usage data"));
        return;
    }

    for (const [bucket, pct] of Object.entries(payload.usage)) {
        out.print(`  ${bucket}: ${pct}%`);
    }

    if (payload.stale) {
        out.print(pc.yellow("  (stale — last poll failed)"));
    }
}

export function registerInfoCommand(program: Command): void {
    program
        .command("info [name]")
        .description(
            "Show account info + cached usage percentages (no network). " +
                "Without [name], pairs a CLAUDE_CODE_OAUTH_TOKEN piped on stdin with the configured accounts."
        )
        .option("--format <fmt>", "Output format: text | json", "text")
        .action(async (name: string | undefined, opts: InfoOptions) => {
            if (opts.format !== "text" && opts.format !== "json") {
                out.error(pc.red(`Unsupported --format "${opts.format}" — expected "text" or "json".`));
                await out.flush();
                process.exit(1);
            }

            const aiConfig = await AIConfig.load();
            const account = await resolveAccount(name, aiConfig);

            if (!account) {
                if (name) {
                    out.error(pc.red(`Account "${name}" not found (provider anthropic-sub).`));
                } else {
                    out.error(pc.red("No account name given and no matching long-lived token arrived on stdin."));
                    out.printlnErr(pc.dim('Usage: tools claude info <name>   OR   echo "$TOKEN" | tools claude info'));
                }
                await out.flush();
                process.exit(1);
            }

            const payload = await buildPayload(account);

            if (opts.format === "json") {
                out.result(SafeJSON.stringify(payload));
            } else {
                printText(payload);
            }
        });
}
