import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { ACCOUNT_PROVIDER_ALIASES, providerAliasOf, resolveProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { selectWarmupAccounts, type WarmupResult, warmupAccounts } from "@genesiscz/utils/ai/warmup";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

interface WarmupFlags {
    all?: boolean;
    provider?: string;
    json?: boolean;
}

function viaHint(result: WarmupResult): string {
    return result.via === "login-long" ? " used login-long token" : "";
}

function renderResult(result: WarmupResult): string {
    const icon = result.ok ? pc.green("✓") : result.skipped ? pc.yellow("–") : pc.red("✗");
    const reason = result.error ?? "failed";
    const tail = result.ok
        ? pc.dim(viaHint(result))
        : result.skipped
          ? pc.yellow(` skipped: ${reason}`)
          : pc.red(` ${reason}`);
    const line = `  ${icon} ${result.accountName} ${pc.dim(`(${providerAliasOf(result.provider)}, ${result.durationMs}ms)`)}${tail}`;
    return result.hint ? `${line}\n      ${pc.dim(result.hint)}` : line;
}

/**
 * One warmup command for every door. `tools claude|codex|grok warmup` pin the provider;
 * `tools ai warmup` takes `--provider` or runs every subscription account. All four share
 * the selection, the send and the report in `@genesiscz/utils/ai/warmup`.
 */
export function registerWarmupCommand(program: Command, opts: { provider?: string; tool: string }): void {
    const warmup = program
        .command("warmup [account...]")
        .description("Send one tiny request per account to start its session timer")
        .option("--all", "Every enabled account in scope, no prompt")
        .option("--json", "Machine-readable results");

    if (!opts.provider) {
        warmup.option("--provider <value>", `Only this provider: ${ACCOUNT_PROVIDER_ALIASES.join(", ")}`);
    }

    warmup.action(async (accountArgs: string[], flags: WarmupFlags) => {
        const provider = opts.provider ?? (flags.provider ? resolveProviderAlias(flags.provider) : undefined);
        const store = await AiConfigStore.load();
        let names = accountArgs;

        if (names.length === 0 && !flags.all) {
            const candidates = selectWarmupAccounts(store, { provider });

            if (candidates.length === 0) {
                out.error(`No enabled subscription accounts${provider ? ` for ${providerAliasOf(provider)}` : ""}.`);
                process.exitCode = 1;
                return;
            }

            if (!isInteractive() || flags.json) {
                out.error("Name the accounts, or pass --all.");
                out.info(suggestCommand(opts.tool, { add: ["--all"] }));
                process.exitCode = 1;
                return;
            }

            const picked = await p.multiselect({
                message: "Select accounts to warm up",
                options: candidates.map((a) => ({
                    // The id, not the name: two accounts may share a name, and the store
                    // refuses an ambiguous name where it resolves an id (PR #383 review).
                    value: a.id,
                    label: `${a.name} ${pc.dim(`(${providerAliasOf(a.provider)}${a.label ? `, ${a.label}` : ""})`)}`,
                })),
                required: true,
            });

            if (p.isCancel(picked)) {
                p.outro("Cancelled.");
                return;
            }

            names = picked as string[];
        }

        const selection = { provider, ...(names.length > 0 ? { names } : {}) };
        const spinner = flags.json ? undefined : p.spinner();
        spinner?.start(`Warming up ${names.length > 0 ? names.join(", ") : "every account"}...`);
        const results = await warmupAccounts({ store, ...selection });
        const skipped = results.filter((r) => r.skipped).length;
        const failed = results.filter((r) => !r.ok && !r.skipped).length;
        const skippedNote = skipped > 0 ? `, ${skipped} skipped (no quota left)` : "";
        spinner?.stop(
            failed === 0
                ? `${results.length - skipped} account(s) warmed up${skippedNote}`
                : `${failed} of ${results.length} failed${skippedNote}`
        );

        if (flags.json) {
            out.result(results);
        } else {
            p.note(results.map(renderResult).join("\n"), "Warmup Results");
        }

        if (failed > 0) {
            process.exitCode = 1;
        }
    });
}
