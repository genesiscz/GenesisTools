import { existsSync } from "node:fs";
import { GATE_ONLY_TAG } from "@genesiscz/utils/ai/config/selectors";
import {
    auditPath,
    autoAllowCommand,
    GATE_API_KEY_PROVIDERS,
    GATE_PROVIDERS,
    GateDeniedError,
    grantsPath,
    isGateProvider,
    listGrants,
    listVaultGrants,
    loadVaultAutoAllow,
    readAuditTail,
    requestAccountAccess,
    revokeGrants,
    revokeVaultGrants,
    updateVaultAutoAllow,
    type VaultAutoAllowSettings,
    vaultAutoAllowPath,
    vaultGrantsPath,
} from "@genesiscz/utils/ai/gate";
import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { parseJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { isGenesisAppRpcAvailable } from "@genesiscz/utils/macos/genesis-app-rpc";
import { genesisAppBuildHint } from "@genesiscz/utils/macos/xcode";
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
    account?: string;
    json?: boolean;
    printToken?: boolean;
}

/**
 * `tools ai gate` — the door other processes knock on for an AI account token, or for the stored
 * API key of an xai/openai account (an app with no key in its environment, e.g. Genesis speaking
 * through `tools say`).
 *
 * `request` is the only verb that spends anything: after Martin allows it in the app window, it may
 * refresh the account's expired OAuth access token inside the vault, by design, because a request is
 * real use. The refresh token itself is never handed out. `grants`, `status` and `audit` only read
 * and never refresh. `--pid` names the asking
 * process (a Pi extension passes its own pid). Without it the client is unidentified: the window
 * says so, an allow is good once, and nothing is remembered. `process.ppid` is not a usable
 * default here, because `tools` runs this command under the GenesisTools.app launcher, and a
 * grant keyed on the launcher would cover every tool run.
 */
export function registerGateCommands(program: Command): void {
    const gate = program
        .command("gate")
        .description("Hand an AI account access token or API key to another app after native approval");

    gate.command("request")
        .description("Ask for an access token or API key; GenesisTools.app shows who asks and confirms with Touch ID")
        .requiredOption("--client <name>", "Short name of the asking app, shown in the approval window")
        .option(
            "--pid <n>",
            "Pid of the asking process; without it the grant can only be allowed once, never remembered"
        )
        .option("--provider [value]", `Provider: ${GATE_PROVIDERS.join(", ")}`)
        .option(
            "--account <name>",
            `Account name or id from \`${toolCommand("ai accounts list")}\`; optional for ${GATE_API_KEY_PROVIDERS.join(", ")} (an account that stores a key, tagged ${GATE_ONLY_TAG} first)`
        )
        .option("--json", "Print the full result as JSON")
        .option("--print-token", "Print only the token or key (for a provider's `!command` credential)")
        .action(async (opts: RequestOpts) => {
            const provider = typeof opts.provider === "string" ? opts.provider : "";

            if (!isGateProvider(provider)) {
                out.print(suggestEnumFlag(`${TOOL} request`, "--provider", [...GATE_PROVIDERS]));
                process.exitCode = 1;
                return;
            }

            // `parseInt` reads "12abc" as 12 and "abc" as NaN, which would quietly turn a client that
            // could be remembered into an unidentified allow-once one. Only a plain positive integer.
            const pid = opts.pid === undefined ? undefined : /^\d+$/.test(opts.pid) ? Number(opts.pid) : Number.NaN;

            if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) {
                out.log.error(`--pid must be a positive whole number, got "${opts.pid}".`);
                process.exitCode = 1;
                return;
            }

            try {
                const result = await requestAccountAccess({
                    client: { name: opts.client, pid },
                    provider,
                    account: opts.account,
                });

                if (result.provider === "anthropic-sub" && result.tokenKind === "access") {
                    out.log.warn(
                        `"${result.account.name}" has no long-lived token, so this is an OAuth access token: it dies when any app refreshes the account. Attach one: ${toolCommand("claude login-long")} ${result.account.name}`
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

                // An API key never expires, so its masked form keeps fewer characters than a token's.
                const shown = result.tokenKind === "api-key" ? 4 : 12;
                out.result({ ...result, accessToken: `${result.accessToken.slice(0, shown)}…` });
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
            const vault = listVaultGrants();

            if (opts.json) {
                out.result({ grants, vault });
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

            renderCliHeader("Vault key", `${vault.length} remembered by GenesisTools.app`);
            const vaultTable = createBoxTable(["TOOL", "EXECUTABLE", "SCRIPT", "UNTIL", "BY"]);

            for (const grant of vault) {
                vaultTable.push([
                    truncateDisplay(grant.tool, 16),
                    truncateDisplay(grant.executable, 32),
                    truncateDisplay(grant.script ?? "", 40),
                    grant.until === null ? "always" : new Date(grant.until).toLocaleString("sv-SE").slice(0, 16),
                    grant.method,
                ]);
            }

            out.println(vaultTable.toString());
            renderCliSection("Files");
            out.println(`  ${pc.dim(grantsPath())}`);
            out.println(`  ${pc.dim(vaultGrantsPath())}`);
        });

    gate.command("revoke [client]")
        .description("Forget remembered approvals for a client name or key; `--all` forgets every one")
        .option("--all", "Revoke every grant (a [client] argument is then ignored)")
        .action(async (client: string | undefined, opts: { all?: boolean }) => {
            const selector = opts.all ? "*" : client;

            if (!selector) {
                out.log.error("Pass a client name or key, or --all.");
                out.log.info(suggestCommand("tools ai", { add: ["--all"] }));
                process.exitCode = 1;
                return;
            }

            const removed = await revokeGrants(selector);
            const vault = await revokeVaultGrants(selector);
            out.log.info(
                `Revoked ${removed} grant${removed === 1 ? "" : "s"} and ${vault} vault-key approval${vault === 1 ? "" : "s"}.`
            );
        });

    gate.command("audit")
        .description("Print the last decisions (read-only)")
        .option("--limit <n>", "How many lines from the end", "20")
        .action(async (opts: { limit: string }) => {
            const path = auditPath();
            // `parseInt("abc")` is NaN, and `slice(-NaN)` is the whole history: refuse it instead.
            const limit = /^\d+$/.test(opts.limit) ? Number(opts.limit) : Number.NaN;

            if (!Number.isSafeInteger(limit) || limit < 1) {
                out.log.error(`--limit must be a positive whole number, got "${opts.limit}".`);
                process.exitCode = 1;
                return;
            }

            if (!existsSync(path)) {
                out.log.info(`No audit yet (${path}).`);
                return;
            }

            for (const line of await readAuditTail(limit)) {
                const entry = parseJSON<AuditLine>(line);

                if (entry) {
                    out.println(
                        `${pc.dim(entry.at)} ${entry.event.padEnd(10)} ${entry.client.name}${entry.client.pid ? `(${entry.client.pid})` : ""} ${entry.account ?? ""} ${pc.dim(entry.detail ?? "")}`
                    );
                }
            }
        });

    registerAutoAllowCommands(gate);

    gate.command("status")
        .description("Is the approval window reachable? (read-only)")
        .action(() => {
            const available = isGenesisAppRpcAvailable();
            out.println(
                `${available ? pc.green("● ok") : pc.red("● missing")} GenesisTools.app RPC ${available ? "installed" : `not installed or switched off: ${genesisAppBuildHint()}`}`
            );
            out.println(`${pc.dim("grants")} ${grantsPath()}`);
            out.println(`${pc.dim("audit ")} ${auditPath()}`);
        });
}

/** What the switch means: off stops only this bypass, and a remembered allow still skips the window. */
const AUTO_ALLOW_OFF = `off: no command skips the window on this list (a remembered allow still does; \`${toolCommand("ai gate revoke")}\` drops it)`;

/** The human view of the settings: the switch, the list, the agent apps, the notification and the file. */
function printAutoAllow(settings: VaultAutoAllowSettings): void {
    renderCliHeader("Vault key without a window", settings.enabled ? pc.green("on") : pc.yellow(AUTO_ALLOW_OFF));
    out.println(
        "  Commands on this list get the vault key with no window when an agent starts them; each one is logged."
    );
    renderCliSection("Commands");
    for (const command of settings.commands) {
        out.println(`  tools ${command}`);
    }

    renderCliSection("Agent apps (besides Claude Code, Codex and Grok CLI processes)");
    for (const app of settings.agentApps) {
        out.println(`  ${app}`);
    }

    renderCliSection("Notification");
    out.println(`  ${settings.notify ? "on: one per auto-allow" : "off: the audit line only"}`);
    renderCliSection("File");
    out.println(`  ${pc.dim(vaultAutoAllowPath())}`);
}

/** A settings file the app cannot decode (or a lock that stays held) is an error line and exit code 1, not a trace. */
function reportAutoAllowError(err: unknown): void {
    out.log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
}

/** An argument that names nothing is refused before the file is touched. */
function refuseEmpty(value: string, what: string): boolean {
    if (value) {
        return false;
    }

    out.log.error(`Pass ${what}; an empty one would match nothing.`);
    process.exitCode = 1;
    return true;
}

/** Applies one change under the file's lock and prints the saved settings, or the error. */
async function changeAutoAllow(change: (settings: VaultAutoAllowSettings) => VaultAutoAllowSettings): Promise<void> {
    try {
        printAutoAllow(await updateVaultAutoAllow(change));
    } catch (err) {
        reportAutoAllowError(err);
    }
}

/** `tools ai gate auto-allow` and its subcommands; GenesisTools.app reads the file they write. */
function registerAutoAllowCommands(gate: Command): void {
    const autoAllow = gate
        .command("auto-allow")
        .description(
            "Commands that get the vault key with no window when an agent starts them (default: claude and ai warmup and usage)"
        )
        .option("--json", "Machine-readable output")
        .action((opts: { json?: boolean }) => {
            let settings: VaultAutoAllowSettings;
            try {
                settings = loadVaultAutoAllow();
            } catch (err) {
                reportAutoAllowError(err);
                return;
            }

            if (opts.json) {
                out.result({ ...settings, path: vaultAutoAllowPath() });
                return;
            }

            printAutoAllow(settings);
        });

    autoAllow
        .command("add <command...>")
        .description(`Put a command on the list: \`add claude warmup\` lets "${toolCommand("claude warmup")}" through`)
        .action(async (words: string[]) => {
            const command = autoAllowCommand(words);
            if (refuseEmpty(command, "a command")) {
                return;
            }

            // The app matches `<tool> <subcommand>` exactly, so any other shape would sit on the list and match nothing.
            if (command.split(" ").length !== 2) {
                out.log.error(`A command is a tool and its subcommand, like "claude warmup"; got "${command}".`);
                process.exitCode = 1;
                return;
            }

            await changeAutoAllow((settings) => ({
                ...settings,
                commands: settings.commands.includes(command) ? settings.commands : [...settings.commands, command],
            }));
        });

    autoAllow
        .command("remove <command...>")
        .description(
            `Take a command off the list; it then asks in the window unless an allow is remembered (\`${toolCommand("ai gate revoke")}\`)`
        )
        .action(async (words: string[]) => {
            const command = autoAllowCommand(words);
            if (refuseEmpty(command, "a command")) {
                return;
            }

            await changeAutoAllow((settings) => ({
                ...settings,
                commands: settings.commands.filter((known) => known !== command),
            }));
        });

    autoAllow
        .command("add-agent <app>")
        .description('Count the processes an app starts as an agent\'s (its process name, e.g. "Grok Bot")')
        .action(async (raw: string) => {
            const app = raw.trim();
            if (refuseEmpty(app, "an app name")) {
                return;
            }

            await changeAutoAllow((settings) => ({
                ...settings,
                agentApps: settings.agentApps.includes(app) ? settings.agentApps : [...settings.agentApps, app],
            }));
        });

    autoAllow
        .command("remove-agent <app>")
        .description("Stop counting an app's processes as an agent's")
        .action(async (raw: string) => {
            const app = raw.trim();
            if (refuseEmpty(app, "an app name")) {
                return;
            }

            await changeAutoAllow((settings) => ({
                ...settings,
                agentApps: settings.agentApps.filter((known) => known !== app),
            }));
        });

    autoAllow
        .command("notify <state>")
        .description(
            "on or off: a notification for every auto-allow (on by default); the audit line is written either way"
        )
        .action(async (value: string) => {
            if (value !== "on" && value !== "off") {
                out.log.error(`Expected on or off, got "${value}".`);
                process.exitCode = 1;
                return;
            }

            await changeAutoAllow((settings) => ({ ...settings, notify: value === "on" }));
        });

    autoAllow
        .command("enable")
        .description("Let the listed commands through again")
        .action(() => changeAutoAllow((settings) => ({ ...settings, enabled: true })));

    autoAllow
        .command("disable")
        .description(
            `Stop this bypass (the list is kept); a remembered allow still skips the window, \`${toolCommand("ai gate revoke")}\` drops it`
        )
        .action(() => changeAutoAllow((settings) => ({ ...settings, enabled: false })));
}
