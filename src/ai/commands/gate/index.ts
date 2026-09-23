import { existsSync, readFileSync } from "node:fs";
import {
    auditPath,
    GATE_PROVIDERS,
    GateDeniedError,
    grantsPath,
    isGateProvider,
    listGrants,
    requestAccountAccess,
    revokeGrants,
} from "@genesiscz/utils/ai/gate";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { parseJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { isGenesisAppRpcAvailable } from "@genesiscz/utils/macos/genesis-app-rpc";
import { createBoxTable, renderCliHeader, renderCliSection, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const TOOL = "tools ai gate";

interface AuditLine {
    at: string;
    event: string;
    client: { name: string; pid: number | null };
    account?: string;
    detail?: string;
}

interface RequestOpts {
    client: string;
    pid?: string;
    provider?: string | true;
    account: string;
    json?: boolean;
    printToken?: boolean;
}

/**
 * `tools ai gate` — the door other processes knock on for an AI account token.
 *
 * `request` is the only verb that spends anything (it may refresh a grant, after Martin allows
 * it in the app window). `grants`, `status` and `audit` only read. `--pid` names the asking
 * process (a Pi extension passes its own pid). Without it the client is unidentified: the window
 * says so, an allow is good once, and nothing is remembered. `process.ppid` is not a usable
 * default here, because `tools` runs this command under the GenesisTools.app launcher, and a
 * grant keyed on the launcher would cover every tool run.
 */
export function registerGateCommands(program: Command): void {
    const gate = program
        .command("gate")
        .description("Hand an AI account access token to another app after native approval");

    gate.command("request")
        .description("Ask for an access token; GenesisTools.app shows who asks and confirms with Touch ID")
        .requiredOption("--client <name>", "Short name of the asking app, shown in the approval window")
        .option(
            "--pid <n>",
            "Pid of the asking process; without it the grant can only be allowed once, never remembered"
        )
        .option("--provider [value]", `Provider: ${GATE_PROVIDERS.join(", ")}`)
        .requiredOption("--account <name>", "Account name or id from `tools ai accounts list`")
        .option("--json", "Print the full result as JSON")
        .option("--print-token", "Print only the access token (for a provider's `!command` credential)")
        .action(async (opts: RequestOpts) => {
            const provider = typeof opts.provider === "string" ? opts.provider : "";

            if (!isGateProvider(provider)) {
                out.print(suggestEnumFlag(`${TOOL} request`, "--provider", [...GATE_PROVIDERS]));
                process.exitCode = 1;
                return;
            }

            const pid = opts.pid ? Number.parseInt(opts.pid, 10) : undefined;

            try {
                const result = await requestAccountAccess({
                    client: { name: opts.client, pid },
                    provider,
                    account: opts.account,
                });

                if (result.provider === "anthropic-sub" && result.tokenKind === "access") {
                    out.log.warn(
                        `"${result.account.name}" has no long-lived token, so this is an OAuth access token: it dies when any app refreshes the account. Attach one: tools claude login-long ${result.account.name}`
                    );
                }

                if (opts.printToken) {
                    out.print(result.accessToken);
                    return;
                }

                if (opts.json) {
                    out.result(result);
                    return;
                }

                out.result({ ...result, accessToken: `${result.accessToken.slice(0, 12)}…` });
            } catch (error) {
                if (error instanceof GateDeniedError) {
                    out.log.error(`${error.code}: ${error.message}`);
                    process.exitCode = 77;
                    return;
                }

                throw error;
            }
        });

    gate.command("grants")
        .description("Remembered approvals that have not expired (read-only)")
        .option("--json", "Machine-readable output")
        .action((opts: { json?: boolean }) => {
            const grants = listGrants();

            if (opts.json) {
                out.result(grants);
                return;
            }

            renderCliHeader("AI gate grants", `${grants.length} live`);
            const table = createBoxTable(["CLIENT", "EXECUTABLE", "PROVIDER", "ACCOUNT", "UNTIL", "BY"]);

            for (const grant of grants) {
                table.push([
                    truncateDisplay(grant.clientName, 16),
                    truncateDisplay(grant.executable ?? "", 32),
                    grant.provider,
                    truncateDisplay(grant.accountName, 24),
                    new Date(grant.until).toLocaleString("sv-SE").slice(0, 16),
                    grant.method,
                ]);
            }

            out.println(table.toString());
            renderCliSection("Files");
            out.println(`  ${pc.dim(grantsPath())}`);
        });

    gate.command("revoke <client>")
        .description("Forget remembered approvals for a client name or key; `--all` forgets every one")
        .option("--all", "Revoke every grant (the <client> argument is then ignored)")
        .action(async (client: string, opts: { all?: boolean }) => {
            const removed = await revokeGrants(opts.all ? "*" : client);
            out.log.info(`Revoked ${removed} grant${removed === 1 ? "" : "s"}.`);
        });

    gate.command("audit")
        .description("Print the last decisions (read-only)")
        .option("--limit <n>", "How many lines from the end", "20")
        .action((opts: { limit: string }) => {
            const path = auditPath();

            if (!existsSync(path)) {
                out.log.info(`No audit yet (${path}).`);
                return;
            }

            const lines = readFileSync(path, "utf8").trim().split("\n");
            const limit = Number.parseInt(opts.limit, 10);

            for (const line of lines.slice(-limit)) {
                const entry = parseJSON<AuditLine>(line);

                if (entry) {
                    out.println(
                        `${pc.dim(entry.at)} ${entry.event.padEnd(10)} ${entry.client.name}${entry.client.pid ? `(${entry.client.pid})` : ""} ${entry.account ?? ""} ${pc.dim(entry.detail ?? "")}`
                    );
                }
            }
        });

    gate.command("status")
        .description("Is the approval window reachable? (read-only)")
        .action(() => {
            const available = isGenesisAppRpcAvailable();
            out.println(
                `${available ? pc.green("● ok") : pc.red("● missing")} GenesisTools.app RPC ${available ? "installed" : "not installed or switched off (tools macos permissions build)"}`
            );
            out.println(`${pc.dim("grants")} ${grantsPath()}`);
            out.println(`${pc.dim("audit ")} ${auditPath()}`);
        });
}
