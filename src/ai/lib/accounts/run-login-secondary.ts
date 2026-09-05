import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { resolveAccountName } from "./select-account";
import { resolveAccountsProvider } from "./select-provider";
import { siblingCommandOf } from "./tool-names";
import { writeLoginOutcome } from "./write-outcome";

export interface RunLoginSecondaryOptions {
    provider?: string | true;
    name?: string;
    tool: string;
    subcommand?: string[];
}

/**
 * A second, isolated grant on an existing account, used only by
 * `tools claude start <name> --keychain`. The identity comparand is the
 * SECONDARY grant's uuid, not the account's: that is the key future keychain
 * rotations match on, so an unexpected identity here would route them to the
 * wrong account.
 */
export async function runLoginSecondary(opts: RunLoginSecondaryOptions): Promise<void> {
    registerBuiltInPlugins();

    const interactive = isInteractive();

    if (!interactive) {
        out.error(pc.red("login-secondary requires an interactive terminal (code paste)."));
        process.exitCode = 1;
        return;
    }

    const resolved = await resolveAccountsProvider({
        raw: opts.provider,
        interactive,
        tool: opts.tool,
        subcommand: opts.subcommand,
    });

    if (resolved.status === "help") {
        out.printlnErr(resolved.help);
        process.exitCode = 1;
        return;
    }

    if (resolved.status === "cancelled") {
        p.cancel("Cancelled");
        return;
    }

    const plugin = resolved.plugin;
    const alias = providerAliasOf(plugin.id);

    if (!plugin.accounts?.loginSecondary) {
        out.error(pc.red(`${alias} has no login-secondary; use login.`));
        process.exitCode = 1;
        return;
    }

    const store = await AiConfigStore.load();
    const accounts = store.accounts({ provider: plugin.id });

    if (accounts.length === 0) {
        out.error(pc.red(`No ${alias} accounts configured. Run \`${siblingCommandOf(opts.tool, "login")}\` first.`));
        process.exitCode = 1;
        return;
    }

    const picked = await resolveAccountName({
        requested: opts.name,
        accounts,
        message: "Attach the secondary login to which account?",
        tool: opts.tool,
        subcommand: opts.subcommand,
        hintOf: (account) => (account.credentials.secondary ? "has secondary login — will overwrite" : undefined),
    });

    if (picked.status !== "ok") {
        if (picked.status === "cancelled") {
            p.cancel("Cancelled");
            return;
        }

        process.exitCode = 1;
        return;
    }

    const account = picked.account;

    if (account.credentials.secondary) {
        const overwrite = await p.confirm({
            message: `"${account.name}" already has a secondary login. Overwrite?`,
            initialValue: false,
        });

        if (p.isCancel(overwrite) || !overwrite) {
            p.cancel("Cancelled");
            return;
        }
    }

    const outcome = await plugin.accounts.loginSecondary({ account, requestedName: account.name, interactive });

    const written = await writeLoginOutcome({
        name: account.name,
        outcome,
        interactive,
        account,
        storedIdentity: {
            accountUuid: account.credentials.secondary?.accountUuid,
            organizationUuid: account.credentials.secondary?.organizationUuid,
        },
    });

    if (!written) {
        process.exitCode = 1;
        return;
    }

    p.log.success(`Secondary login saved to "${account.name}".`);
    p.outro(`Launch with it: ${pc.cyan(suggestCommand(`tools cc run ${account.name}`, { add: ["--keychain"] }))}`);
}
