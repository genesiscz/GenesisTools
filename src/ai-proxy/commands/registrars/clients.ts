import { clientsAdd, clientsList, clientsSecure, clientsUsage } from "@app/ai-proxy/commands/clients";
import type { AiProxyProviderType } from "@app/ai-proxy/lib/types";
import type { Command } from "commander";

export function register(program: Command): void {
    const clientsCmd = program.command("clients").description("Manage per-user client keys + usage ledger");

    clientsCmd
        .command("list")
        .description("List configured clients (keys masked)")
        .action(async () => {
            await clientsList();
        });

    clientsCmd
        .command("add <name>")
        .description("Add a client; prints its generated key ONCE")
        .option("--token-cap <n>", "Monthly total-token cap", (v) => Number.parseInt(v, 10))
        .option("--cost-cap <usd>", "Monthly cost cap in USD", (v) => Number.parseFloat(v))
        .option("--provider <type...>", "Restrict to provider types (never subscription types)")
        .action(async (name: string, opts: { tokenCap?: number; costCap?: number; provider?: string[] }) => {
            await clientsAdd({
                name,
                tokenCap: opts.tokenCap,
                costCap: opts.costCap,
                providers: opts.provider as AiProxyProviderType[] | undefined,
            });
        });

    clientsCmd
        .command("secure")
        .description("Move plaintext client keys into the vault (config keeps only a reference)")
        .action(async () => {
            await clientsSecure();
        });

    clientsCmd
        .command("usage")
        .description("Per-client monthly usage (JSON, or CSV for invoicing)")
        .option("--month <YYYY-MM>", "Month to report (default: current UTC month)")
        .option("--csv", "CSV output")
        .action(async (opts: { month?: string; csv?: boolean }) => {
            await clientsUsage(opts);
        });
}
