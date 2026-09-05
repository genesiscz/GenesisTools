import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type ClearableCredential, clearCredentials, removeAccount } from "@genesiscz/utils/ai/config/account-ops";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { LogoutTarget } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { resolveAccountName } from "./select-account";
import { resolveAccountsProvider } from "./select-provider";
import { siblingCommandOf } from "./tool-names";

export interface RunLogoutOptions {
    provider?: string | true;
    name?: string;
    /** Which credentials to remove. Prompted for when empty on a TTY. */
    targets?: LogoutTarget[];
    yes?: boolean;
    tool: string;
    subcommand?: string[];
}

/** The credential fields each logout target owns. */
const FIELDS_OF: Record<LogoutTarget, ClearableCredential[]> = {
    oauth: ["accessToken", "refreshToken"],
    longLived: ["longLivedToken"],
    secondary: ["secondary"],
    authFile: ["authFile"],
};

const LABEL_OF: Record<LogoutTarget, { label: string; hint: string }> = {
    oauth: {
        label: "Access + refresh token",
        hint: "stops usage polling; a long-lived token keeps working",
    },
    longLived: {
        label: "Long-lived token",
        hint: "tools claude start/run stops working; usage polling keeps working",
    },
    secondary: { label: "Secondary login", hint: "used only by start --keychain" },
    authFile: { label: "Auth file reference", hint: "the vendor CLI's file is left on disk, only the link is removed" },
};

/** Targets this account actually has something to remove for. */
export function availableTargets(account: AccountEntry, declared: readonly LogoutTarget[]): LogoutTarget[] {
    return declared.filter((target) => FIELDS_OF[target].some((field) => account.credentials[field] !== undefined));
}

export async function runLogout(opts: RunLogoutOptions): Promise<void> {
    registerBuiltInPlugins();

    const interactive = isInteractive();
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
    const declared = plugin.accounts?.logoutTargets ?? [];
    const store = await AiConfigStore.load();
    const accounts = store.accounts({ provider: plugin.id });

    if (accounts.length === 0) {
        out.error(pc.red(`No ${providerAliasOf(plugin.id)} accounts configured.`));
        process.exitCode = 1;
        return;
    }

    const picked = await resolveAccountName({
        requested: opts.name,
        accounts,
        message: "Logout which account?",
        tool: opts.tool,
        subcommand: opts.subcommand,
        hintOf: (account) => {
            const held = availableTargets(account, declared);
            return held.length > 0 ? held.join(" + ") : "no credentials";
        },
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
    const available = availableTargets(account, declared);

    if (available.length === 0) {
        await offerToRemoveEmptyAccount(account, interactive);
        return;
    }

    let targets = (opts.targets ?? []).filter((target) => declared.includes(target));

    if ((opts.targets ?? []).length > 0 && targets.length === 0) {
        out.error(pc.red(`${providerAliasOf(plugin.id)} has none of the credentials you asked to remove.`));
        process.exitCode = 1;
        return;
    }

    if (targets.length > 0) {
        const missing = targets.filter((target) => !available.includes(target));

        if (missing.length > 0) {
            out.error(pc.red(`Account "${account.name}" has no ${missing.join(", ")} credential.`));
            process.exitCode = 1;
            return;
        }
    } else {
        if (!interactive) {
            out.error(pc.red("Token scope required in non-interactive mode."));
            out.printlnErr(
                suggestCommand(opts.tool, {
                    subcommand: opts.subcommand,
                    add: [account.name, `--${available[0] === "longLived" ? "long-lived" : available[0]}`, "--yes"],
                })
            );
            process.exitCode = 1;
            return;
        }

        const chosen = await p.multiselect({
            message: "Remove which credentials?",
            options: available.map((target) => ({ value: target, ...LABEL_OF[target] })),
            required: true,
        });

        if (p.isCancel(chosen)) {
            p.cancel("Cancelled");
            return;
        }

        targets = chosen as LogoutTarget[];
    }

    if (!opts.yes) {
        if (!interactive) {
            out.error(pc.red("Confirmation required: pass --yes in non-interactive mode."));
            process.exitCode = 1;
            return;
        }

        p.note(
            targets.map((target) => `${LABEL_OF[target].label} — ${LABEL_OF[target].hint}`).join("\n"),
            `Logout "${account.name}"`
        );

        const confirmed = await p.confirm({ message: "Remove these credentials?", initialValue: false });

        if (p.isCancel(confirmed) || !confirmed) {
            p.cancel("Cancelled — nothing removed.");
            return;
        }
    }

    // Straight to the v4 store, NOT through the legacy token projection: deleting
    // fields from a `toV3Account` snapshot and writing it back does not revoke
    // anything, because `applyV3Tokens` skips absent fields.
    // By ID, never by name: `requireAccount` refuses an ambiguous name, so two
    // accounts sharing one could not be logged out at all (PR #360 review t6).
    const fields = [...new Set(targets.flatMap((target) => FIELDS_OF[target]))];
    await clearCredentials(account.id, fields);

    p.log.success(`Removed ${targets.join(" + ")} from "${account.name}".`);

    const remaining = availableTargets((await AiConfigStore.load()).account(account.id) ?? account, declared);
    p.log.info(
        pc.dim(`Remaining: ${remaining.length > 0 ? remaining.join(" + ") : "nothing"}. Account entry kept in config.`)
    );
    // The entry survives a logout, so both ways out of that state belong here.
    // The old claude-only command printed them and the shared core dropped them,
    // leaving no hint that the account was still in the config (gap/cli).
    p.log.info(
        pc.dim(
            `Re-login: ${pc.cyan(`${siblingCommandOf(opts.tool, "login")} ${account.name}`)} · ` +
                `full removal: ${pc.cyan(`tools ai config account rm ${account.name}`)}`
        )
    );
}

/**
 * A credential-less entry is usually a typo'd or abandoned account, so offer the
 * only remaining action — but default to no: the entry may still carry a label
 * and the subscription anchor, and deleting it is not undoable.
 */
async function offerToRemoveEmptyAccount(account: AccountEntry, interactive: boolean): Promise<void> {
    p.log.warn(`Account "${account.name}" has no credentials to remove.`);

    if (!interactive) {
        return;
    }

    const removeEntry = await p.confirm({
        message: `Remove the account entry "${account.name}" from the config entirely?`,
        initialValue: false,
    });

    if (p.isCancel(removeEntry) || !removeEntry) {
        p.cancel("Cancelled — account kept.");
        return;
    }

    await removeAccount(account.id);
    logger.info(`[logout] removed credential-less account entry "${account.name}" from the AI config`);
    out.println(pc.green(`Account "${account.name}" removed from the config.`));
}
