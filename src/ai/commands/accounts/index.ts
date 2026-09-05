import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import type { Command } from "commander";
import { type LogoutFlags, logoutTargetsFromFlags } from "../../lib/accounts/logout-flags";
import { runDiscover } from "../../lib/accounts/run-discover";
import { runList } from "../../lib/accounts/run-list";
import { runLogin } from "../../lib/accounts/run-login";
import { runLoginLong } from "../../lib/accounts/run-login-long";
import { runLoginSecondary } from "../../lib/accounts/run-login-secondary";
import { runLogout } from "../../lib/accounts/run-logout";
import { runShow } from "../../lib/accounts/run-show";
import { runWho } from "../../lib/accounts/run-who";

const TOOL = "tools ai accounts";
const PROVIDER_HELP = `Provider: ${ACCOUNT_PROVIDER_ALIASES.join(", ")} (plugin ids also accepted)`;

/**
 * `tools ai accounts` — the provider-neutral account lifecycle.
 *
 * Every subcommand here is a thin door onto `src/ai/lib/accounts`, which is the
 * same core `tools claude login*`, `tools codex login` and `tools grok login`
 * call. A behaviour must never exist behind one door and not the others.
 *
 * `--provider` is declared `[value]`, not `<value>`: commander would otherwise
 * exit with a generic "argument missing" that never names the possible values.
 */
export function registerAccountsCommands(program: Command): void {
    registerBuiltInPlugins();

    const accounts = program.command("accounts").description("Log in, log out and inspect subscription accounts");

    accounts
        .command("list")
        .description("List subscription accounts and which credentials each one holds")
        .option("--provider [value]", PROVIDER_HELP)
        .option("--json", "Machine-readable output")
        .action(async (opts: { provider?: string | true; json?: boolean }) => {
            await runList({ ...opts, tool: `${TOOL} list`, subcommand: ["accounts", "list"] });
        });

    accounts
        .command("show <account>")
        .description("Identity, stored credential kinds and homes for one account (never polls)")
        .option("--json", "Machine-readable output")
        .action(async (name: string, opts: { json?: boolean }) => {
            await runShow({ name, json: opts.json, tool: `${TOOL} show` });
        });

    accounts
        .command("login [name]")
        .description("Browser login for a subscription provider")
        .option("--provider [value]", PROVIDER_HELP)
        .option("--home <dir>", "Vendor home to log into (a codex profile dir, a grok GROK_HOME)")
        .option("--auth-file <file>", "Bind an existing credential file instead of running a flow")
        .action(
            async (name: string | undefined, opts: { provider?: string | true; home?: string; authFile?: string }) => {
                await runLogin({ ...opts, name, tool: `${TOOL} login`, subcommand: ["accounts", "login"] });
            }
        );

    accounts
        .command("login-long [name]")
        .description("Attach a long-lived token to an existing account (providers that have one)")
        .option("--provider [value]", PROVIDER_HELP)
        .option("--setup-token", "Skip the prompt and mint the token via the OAuth flow")
        .action(async (name: string | undefined, opts: { provider?: string | true; setupToken?: boolean }) => {
            await runLoginLong({ ...opts, name, tool: `${TOOL} login-long`, subcommand: ["accounts", "login-long"] });
        });

    accounts
        .command("login-secondary [name]")
        .description("Attach a second, isolated grant to an account (providers that have one)")
        .option("--provider [value]", PROVIDER_HELP)
        .action(async (name: string | undefined, opts: { provider?: string | true }) => {
            await runLoginSecondary({
                ...opts,
                name,
                tool: `${TOOL} login-secondary`,
                subcommand: ["accounts", "login-secondary"],
            });
        });

    accounts
        .command("logout [name]")
        .description("Remove stored credentials from an account (the entry itself is kept)")
        .option("--provider [value]", PROVIDER_HELP)
        .option("--oauth", "Remove the access + refresh token")
        .option("--long-lived", "Remove the long-lived token")
        .option("--secondary", "Remove the secondary grant")
        .option("--auth-file", "Remove the auth-file reference")
        .option("--all", "Remove every credential the provider declares")
        .option("-y, --yes", "Skip the confirmation prompt")
        .action(async (name: string | undefined, opts: LogoutFlags & { provider?: string | true; yes?: boolean }) => {
            await runLogout({
                provider: opts.provider,
                name,
                targets: logoutTargetsFromFlags(opts),
                yes: opts.yes,
                tool: `${TOOL} logout`,
                subcommand: ["accounts", "logout"],
            });
        });

    accounts
        .command("discover")
        .description("List vendor home directories on this machine; --bind creates accounts for the unbound ones")
        .option("--provider [value]", PROVIDER_HELP)
        .option("--bind", "Create an account for every unbound home (the only writing path here)")
        .option("--json", "Machine-readable output")
        .action(async (opts: { provider?: string | true; bind?: boolean; json?: boolean }) => {
            await runDiscover({ ...opts, tool: `${TOOL} discover`, subcommand: ["accounts", "discover"] });
        });

    accounts
        .command("who")
        .description("Live Claude Code processes and the account each one runs as")
        .option("--json", "Machine-readable output")
        .option("--all", "Include helper processes (mcp servers, SDK launchers)")
        .action(async (opts: { json?: boolean; all?: boolean }) => {
            await runWho(opts);
        });
}
