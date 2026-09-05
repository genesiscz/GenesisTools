import { applyLongLivedToken } from "@app/claude/lib/long-lived-token";
import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountFlowContext } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { resolveAccountName } from "./select-account";
import { resolveAccountsProvider } from "./select-provider";
import { siblingCommandOf } from "./tool-names";

/**
 * Spec 4.1 widens `loginLong`'s context with `pastedToken` only, and
 * `--setup-token` ("mint instead of prompting me") is Anthropic's own switch. It
 * therefore rides on a declared context type rather than a cast; a provider that
 * does not know the field ignores it.
 */
type LoginLongContext = AccountFlowContext & { pastedToken?: string; setupToken?: boolean };

export interface RunLoginLongOptions {
    /** Pinned by `tools claude login-long`; resolved from `--provider` otherwise. */
    provider?: string | true;
    name?: string;
    setupToken?: boolean;
    tool: string;
    subcommand?: string[];
}

function maskToken(token: string): string {
    if (token.length < 24) {
        return "****";
    }
    return `${token.slice(0, 20)}…${token.slice(-4)}`;
}

/**
 * Attach a long-lived token to an existing account.
 *
 * The write is `applyLongLivedToken` INSIDE `AiConfigStore.mutate`, never
 * `applyLoginOutcome`: the browser round-trip takes minutes and the poll daemon
 * rotates the access/refresh pair during it, so a spread of the credentials this
 * process read at startup would write the dead pair back and cost the account
 * its login.
 */
export async function runLoginLong(opts: RunLoginLongOptions): Promise<void> {
    registerBuiltInPlugins();

    const resolved = await resolveAccountsProvider({
        raw: opts.provider,
        interactive: isInteractive(),
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

    if (!plugin.accounts?.loginLong) {
        out.error(pc.red(`${alias} has no login-long; use login.`));
        process.exitCode = 1;
        return;
    }

    const store = await AiConfigStore.load();
    const accounts = store.accounts({ provider: plugin.id });

    if (accounts.length === 0) {
        out.error(pc.red(`No ${alias} accounts configured yet.`));
        out.println(pc.dim(`Run ${pc.cyan(siblingCommandOf(opts.tool, "login"))} first, then rerun this command.`));
        process.exitCode = 1;
        return;
    }

    const picked = await resolveAccountName({
        requested: opts.name,
        accounts,
        message: "Which account should hold the long-lived token?",
        tool: opts.tool,
        subcommand: opts.subcommand,
        hintOf: (account) => (account.credentials.longLivedToken ? "has token — will overwrite" : undefined),
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

    if (!isInteractive()) {
        out.error(pc.red("Attaching a long-lived token requires an interactive terminal."));
        process.exitCode = 1;
        return;
    }

    if (account.credentials.longLivedToken) {
        const overwrite = await p.confirm({
            message: `"${account.name}" already has a long-lived token. Overwrite?`,
            initialValue: false,
        });

        if (p.isCancel(overwrite) || !overwrite) {
            p.cancel("Cancelled");
            return;
        }
    }

    const flowContext: LoginLongContext = {
        account,
        requestedName: account.name,
        interactive: true,
        setupToken: opts.setupToken,
    };

    const outcome = await plugin.accounts.loginLong(flowContext);

    const token = outcome.credentials.longLivedToken;

    if (typeof token !== "string") {
        out.error(pc.red("The login flow returned no long-lived token — nothing written."));
        process.exitCode = 1;
        return;
    }

    const expiresAt = outcome.credentials.longLivedTokenExpiresAt;

    await store.mutate((data) =>
        applyLongLivedToken(data, {
            accountName: account.name,
            token,
            expiresAt,
            organizationUuid: outcome.accountFields?.organizationUuid,
        })
    );

    p.log.success(
        `Long-lived token saved to "${account.name}" (${maskToken(token)})` +
            `${expiresAt === undefined ? "" : `, valid until ${new Date(expiresAt).toLocaleString()}`}. ` +
            `Launch Claude with: ${pc.cyan(suggestCommand("tools claude", { replaceCommand: ["start", account.name] }))}`
    );
}
