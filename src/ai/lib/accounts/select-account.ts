import * as p from "@clack/prompts";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

/**
 * Pick which account a flow targets: the positional name when given, a prompt on
 * a TTY, and a `suggestCommand` line plus exit 1 otherwise.
 */
export type AccountResolution = { status: "ok"; account: AccountEntry } | { status: "error" } | { status: "cancelled" };

export interface ResolveAccountInput {
    requested?: string;
    accounts: AccountEntry[];
    /** Prompt text when several accounts exist. */
    message: string;
    /** Command name for the non-interactive hint, e.g. `tools claude logout`. */
    tool: string;
    subcommand?: string[];
    hintOf?: (account: AccountEntry) => string | undefined;
}

export async function resolveAccountName(input: ResolveAccountInput): Promise<AccountResolution> {
    if (input.accounts.length === 0) {
        out.error(pc.red("No accounts configured for this provider."));
        return { status: "error" };
    }

    if (input.requested) {
        // Ids FIRST, then names, exactly as `AiConfigStore.account()` resolves:
        // checking names first let an account whose NAME equals another account's
        // id intercept an explicit id (PR #359 review t10).
        const byId = input.accounts.find((entry) => entry.id === input.requested);
        const byName = byId ? [] : input.accounts.filter((entry) => entry.name === input.requested);

        // An ambiguous name is an ERROR, never the first match. `runLogout` hands
        // the resolved id straight to the irreversible `clearCredentials`, so
        // guessing here silently wipes the wrong account's credentials.
        if (byName.length > 1) {
            out.error(pc.red(`Account name "${input.requested}" is ambiguous (${byName.length} accounts share it).`));
            out.printlnErr(pc.dim(`Use the id: ${byName.map((entry) => entry.id).join(", ")}`));
            return { status: "error" };
        }

        const account = byId ?? byName[0];

        if (!account) {
            out.error(pc.red(`Account "${input.requested}" not found.`));
            out.printlnErr(pc.dim(`Known: ${input.accounts.map((entry) => entry.name).join(", ")}`));
            return { status: "error" };
        }

        return { status: "ok", account };
    }

    if (!isInteractive()) {
        out.error(pc.red("Account name required in non-interactive mode."));
        out.printlnErr(
            suggestCommand(input.tool, {
                subcommand: input.subcommand,
                add: [input.accounts[0]?.name ?? "<name>"],
            })
        );
        return { status: "error" };
    }

    // Keyed by the immutable id, not the name: two accounts sharing a name gave
    // the picker two identical values, so either choice resolved to the first of
    // them and the other was unreachable (PR #359 review t10). The name is still
    // what the user reads; the id joins the label only when it has to.
    const duplicated = new Set(
        input.accounts
            .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) !== index)
            .map((entry) => entry.name)
    );

    const picked = await p.select({
        message: input.message,
        options: input.accounts.map((account) => ({
            value: account.id,
            label: labelFor(account, duplicated.has(account.name)),
            hint: input.hintOf?.(account),
        })),
    });

    if (p.isCancel(picked)) {
        return { status: "cancelled" };
    }

    const account = input.accounts.find((entry) => entry.id === picked);

    if (!account) {
        return { status: "error" };
    }

    return { status: "ok", account };
}

function labelFor(account: AccountEntry, ambiguous: boolean): string {
    const suffix = [account.label, ambiguous ? account.id : undefined].filter(Boolean).join(", ");
    return suffix ? `${account.name} ${pc.dim(`(${suffix})`)}` : account.name;
}
