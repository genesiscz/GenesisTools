import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { CLAUDE_ALL_ACCOUNT_ID, CLAUDE_ALL_ACCOUNT_NAME, UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage/types";
import { aiUsageCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import type { AccountKey } from "./envelope";
import { UsageQueryError } from "./errors";

/**
 * The spend rows that are not accounts: transcripts under a home no account claims, and every
 * Claude transcript as one row (Claude transcripts carry no account). Only spend verbs accept
 * them; a limits verb refuses them by name, because no limit window belongs to either.
 */
export const SPEND_PSEUDO_ACCOUNTS: readonly AccountKey[] = [
    { provider: "", accountId: UNBOUND_ACCOUNT_ID, accountName: UNBOUND_ACCOUNT_ID },
    { provider: "anthropic-sub", accountId: CLAUDE_ALL_ACCOUNT_ID, accountName: CLAUDE_ALL_ACCOUNT_NAME },
];

/** A repeatable, comma-separated list flag as its trimmed, non-empty values. */
export function splitList(values: string | readonly string[] | boolean | undefined): string[] {
    if (values === undefined || typeof values === "boolean") {
        return [];
    }

    const list = typeof values === "string" ? [values] : values;

    return list
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
}

/** `claude/work (acc_…)`: how an error names a candidate. */
export function describeAccount(account: AccountKey): string {
    const owner = account.provider ? `${providerAliasOf(account.provider)}/` : "";
    return `${owner}${account.accountName} (${account.accountId})`;
}

function exactForms(account: AccountKey): string[] {
    return [
        account.accountId,
        account.accountName,
        `${account.provider}/${account.accountName}`,
        `${providerAliasOf(account.provider)}/${account.accountName}`,
    ].map((form) => form.toLowerCase());
}

function substringForms(account: AccountKey): string[] {
    return [account.accountName, `${providerAliasOf(account.provider)}/${account.accountName}`].map((form) =>
        form.toLowerCase()
    );
}

const LISTED_CANDIDATES = 12;

function candidateList(accounts: readonly AccountKey[]): string {
    const shown = accounts.slice(0, LISTED_CANDIDATES).map(describeAccount);
    const more = accounts.length > LISTED_CANDIDATES ? `, and ${accounts.length - LISTED_CANDIDATES} more` : "";

    return `${shown.join(", ")}${more}`;
}

export interface SelectAccountsOptions {
    /** Spend verbs only: `(unbound)` and `claude-all` select their pseudo rows. */
    acceptPseudo?: boolean;
}

function matchOne(value: string, candidates: readonly AccountKey[], opts: SelectAccountsOptions): AccountKey {
    const wanted = value.toLowerCase();
    const pseudo = SPEND_PSEUDO_ACCOUNTS.find((account) => account.accountId.toLowerCase() === wanted);

    if (pseudo) {
        if (!opts.acceptPseudo) {
            throw new UsageQueryError(
                "pseudo-account",
                `--account ${value} names transcript spend, not an account with limit windows. It works with ${aiUsageCommand("spend")}.`,
                { given: value }
            );
        }

        return pseudo;
    }

    const exact = candidates.filter((account) => exactForms(account).includes(wanted));
    const tier =
        exact.length > 0
            ? exact
            : candidates.filter((account) => substringForms(account).some((form) => form.includes(wanted)));

    if (tier.length === 1) {
        return tier[0];
    }

    if (tier.length > 1) {
        throw new UsageQueryError(
            "ambiguous-account",
            `--account ${value} matches ${tier.length} accounts: ${candidateList(tier)}. Pass an id, provider/name, or add --provider.`,
            { given: value, candidates: tier }
        );
    }

    throw new UsageQueryError(
        "unknown-account",
        candidates.length === 0
            ? `--account ${value} matches nothing: no account is configured for these providers.`
            : `--account ${value} matches no account. Known: ${candidateList(candidates)}.`,
        { given: value, candidates }
    );
}

/**
 * `--account` values to accounts (design section 5). Each value may be an immutable id, a
 * name, `provider/name` (plugin id or alias) or a spend pseudo account. An exact match wins;
 * otherwise a value must be a substring of exactly one account. A value that fits several is an
 * error listing them, never a silent pick.
 *
 * `undefined` means no value was given, which every verb reads as "every account". Callers
 * narrow `candidates` by `--provider` first, so `--provider codex --account work` is not
 * ambiguous when Claude also has a `work`.
 */
export function selectAccounts(
    values: string | readonly string[] | boolean | undefined,
    candidates: readonly AccountKey[],
    opts: SelectAccountsOptions = {}
): AccountKey[] | undefined {
    const list = splitList(values);

    if (list.length === 0) {
        return undefined;
    }

    const picked = new Map<string, AccountKey>();

    for (const value of list) {
        const account = matchOne(value, candidates, opts);
        picked.set(`${account.provider}\u0000${account.accountId}`, account);
    }

    const order = new Map(candidates.map((account, index) => [`${account.provider}\u0000${account.accountId}`, index]));

    return [...picked.entries()]
        .sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
        .map(([, account]) => account);
}
