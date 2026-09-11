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
    /**
     * After the exact id-then-name pass fails, accept a unique case-insensitive substring of
     * a name (`tools codex run shop` for `cdx-shop`). Several substring hits prompt on a TTY
     * and are an error otherwise; the exact pass always runs first, so an id or a full name
     * can never be shadowed by a longer name that contains it.
     */
    fuzzy?: boolean;
}

/**
 * The accounts an explicit `requested` names exactly, by the first pass that hits anything.
 *
 * Ids FIRST, then names, exactly as `AiConfigStore.account()` resolves: checking names first
 * let an account whose NAME equals another account's id intercept an explicit id (PR #359
 * review t10). Each of those runs on the literal spelling before the case-folded one, so a
 * differently-cased id can never shadow an exact one.
 *
 * The case-folded passes come from `tools claude run`, which has always treated a case
 * difference as a typo rather than a different account. Without them `tools codex run Shop`
 * fell through to the substring pass and then had to ask between `shop` and `shop-archive`.
 *
 * Several hits mean the caller must refuse: this returns them all rather than choosing.
 */
function matchExactly(accounts: AccountEntry[], requested: string): AccountEntry[] {
    const needle = requested.toLowerCase();
    const passes = [
        (entry: AccountEntry) => entry.id === requested,
        (entry: AccountEntry) => entry.name === requested,
        (entry: AccountEntry) => entry.id.toLowerCase() === needle,
        (entry: AccountEntry) => entry.name.toLowerCase() === needle,
    ];

    for (const pass of passes) {
        const hits = accounts.filter(pass);

        if (hits.length > 0) {
            return hits;
        }
    }

    return [];
}

export async function resolveAccountName(input: ResolveAccountInput): Promise<AccountResolution> {
    if (input.accounts.length === 0) {
        out.error(pc.red("No accounts configured for this provider."));
        return { status: "error" };
    }

    if (input.requested) {
        const exact = matchExactly(input.accounts, input.requested);

        // An ambiguous name is an ERROR, never the first match. `runLogout` hands
        // the resolved id straight to the irreversible `clearCredentials`, so
        // guessing here silently wipes the wrong account's credentials.
        if (exact.length > 1) {
            out.error(pc.red(`Account name "${input.requested}" is ambiguous (${exact.length} accounts share it).`));
            out.printlnErr(pc.dim(`Use the id: ${exact.map((entry) => entry.id).join(", ")}`));
            return { status: "error" };
        }

        if (exact.length === 1) {
            return { status: "ok", account: exact[0] };
        }

        const needle = input.requested.toLowerCase();
        const partial = input.fuzzy ? input.accounts.filter((entry) => entry.name.toLowerCase().includes(needle)) : [];

        if (partial.length === 1) {
            return { status: "ok", account: partial[0] };
        }

        if (partial.length === 0) {
            out.error(pc.red(`Account "${input.requested}" not found.`));
            out.printlnErr(pc.dim(`Known: ${input.accounts.map((entry) => entry.name).join(", ")}`));
            return { status: "error" };
        }

        if (!isInteractive()) {
            out.error(pc.red(`Account "${input.requested}" is ambiguous in non-interactive mode.`));
            out.printlnErr(pc.dim(`Matches: ${partial.map((entry) => entry.name).join(", ")}`));
            return { status: "error" };
        }

        // Several substring hits on a TTY: the same picker as a missing name, scoped to them.
        return promptForAccount({ ...input, accounts: partial });
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

    return promptForAccount(input);
}

async function promptForAccount(input: ResolveAccountInput): Promise<AccountResolution> {
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
