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
        const account = input.accounts.find((entry) => entry.name === input.requested || entry.id === input.requested);

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

    const picked = await p.select({
        message: input.message,
        options: input.accounts.map((account) => ({
            value: account.name,
            label: account.label ? `${account.name} ${pc.dim(`(${account.label})`)}` : account.name,
            hint: input.hintOf?.(account),
        })),
    });

    if (p.isCancel(picked)) {
        return { status: "cancelled" };
    }

    const account = input.accounts.find((entry) => entry.name === picked);

    if (!account) {
        return { status: "error" };
    }

    return { status: "ok", account };
}
