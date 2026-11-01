import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AbsentLimit, absentLimitText } from "@genesiscz/utils/ai/providers/account-features";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { withVaultPurpose } from "@genesiscz/utils/security/vault-purpose";
import type { Command } from "commander";
import pc from "picocolors";
import { absentLimitsOf, normalizeLimits } from "../lib/usage/limits";
import { peekSharedUsage } from "../lib/usage/shared-cache";

interface InfoOptions {
    format?: string;
}

export interface AccountInfoPayload {
    name: string;
    label: string | null;
    /**
     * Bucket key (five_hour, seven_day, seven_day_fable, ...) -> rounded percent. A window the account does not
     * have is null here and named in `absentLimits` (`five_hour` on an account without a 5-hour limit).
     */
    usage: Record<string, number | null> | null;
    /** Windows the account does not have; the statusline drops their slot. Empty when none is known absent. */
    absentLimits: AbsentLimit[];
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

/** What the payload needs of an account: its name and label, no secret. */
export interface InfoAccount {
    name: string;
    label?: string;
}

interface SecretAccounts {
    getAccountsByProvider(provider: "anthropic-sub"): AIAccountEntry[];
}

/**
 * The statusline runs this in every Claude session. With a name it reads the config's account list only:
 * `AIConfig.load()` decrypts every account's secrets, which reads the vault's master key from the keychain, and
 * macOS then asks the user whether `gt-claude` may use it. Only a token on stdin needs the stored tokens to compare.
 */
export async function resolveInfoAccount({
    name,
    readAccounts = readAnthropicAccounts,
    loadSecrets = () => AIConfig.load(),
    readToken = readStdinToken,
}: {
    name: string | undefined;
    readAccounts?: () => Promise<InfoAccount[]>;
    loadSecrets?: () => Promise<SecretAccounts>;
    readToken?: () => Promise<string | null>;
}): Promise<InfoAccount | null> {
    if (name) {
        return (await readAccounts()).find((a) => a.name === name) ?? null;
    }

    const token = await readToken();
    if (!token) {
        return null;
    }

    const config = await withVaultPurpose(
        "match this Claude session's token to a configured account, for the statusline",
        () => loadSecrets()
    );
    return config.getAccountsByProvider("anthropic-sub").find((a) => a.tokens.longLivedToken === token) ?? null;
}

async function readAnthropicAccounts(): Promise<InfoAccount[]> {
    const store = await AiConfigStore.readOnly();
    return store.data().accounts.filter((a) => a.provider === "anthropic-sub");
}

export async function buildPayload(
    account: InfoAccount,
    { peek = peekSharedUsage }: { peek?: typeof peekSharedUsage } = {}
): Promise<AccountInfoPayload> {
    // Passive cache read only — `tools claude info` must never hit the network
    // (it is called from the statusline on every cache-miss refresh).
    const cached = await peek();
    const accountUsage = cached?.accounts.find((a) => a.accountName === account.name);
    const absentLimits = absentLimitsOf(accountUsage?.usage);

    let usage: Record<string, number | null> | null = null;

    if (accountUsage?.usage) {
        usage = {};
        for (const limit of normalizeLimits(accountUsage.usage)) {
            usage[limit.bucket] = Math.round(limit.percent);
        }

        for (const limit of absentLimits) {
            usage[limit.key] = null;
        }
    }

    return {
        name: account.name,
        label: account.label ?? null,
        usage,
        absentLimits,
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
        const absent = payload.absentLimits.find((limit) => limit.key === bucket);
        out.print(`  ${bucket}: ${absent ? absentLimitText(absent) : `${pct}%`}`);
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

            const account = await resolveInfoAccount({ name });

            if (!account) {
                if (name) {
                    out.error(pc.red(`Account "${name}" not found (provider anthropic-sub).`));
                } else {
                    out.error(pc.red("No account name given and no matching long-lived token arrived on stdin."));
                    out.printlnErr(
                        pc.dim(
                            `Usage: ${toolCommand("claude info", "<name>")}   OR   echo "$TOKEN" | ${toolCommand("claude info")}`
                        )
                    );
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
