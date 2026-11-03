/** One account as every usage answer names it. `accountId` is the immutable config id. */
export interface AccountKey {
    /** Plugin id: `anthropic-sub`, `openai-sub`, `grok-sub`. */
    provider: string;
    accountId: string;
    accountName: string;
}

export interface UsageWarning {
    /** Stable, kebab-case: `no-current`, `account-missing`. */
    code: string;
    message: string;
}

/** The time range an answer covers. Instants are ISO UTC; `tz` is the zone day boundaries were drawn in. */
export interface UsageWindow {
    from: string;
    to: string;
    tz: string;
    label: string;
}

/** `usage.<verb>@<version>`: the verb (dots for nested verbs) and its shape version. */
export type UsageSchema = `usage.${string}@${number}`;

/**
 * The one output shape of every `tools ai usage` verb (design section 6). Swift `Codable`
 * ignores unknown keys, so a field added later breaks no decoder; a breaking change bumps the
 * version in `schema` instead.
 */
export interface UsageEnvelope<T> {
    schema: UsageSchema;
    /** ISO instant in UTC. */
    generatedAt: string;
    window?: UsageWindow;
    selector: { accounts: AccountKey[]; harnesses?: string[] };
    data: T;
    /** Shown as text by every door, never dropped. */
    warnings: UsageWarning[];
}

const VERB = /^[a-z]+(\.[a-z]+)*$/;

export function usageSchema(verb: string, version: number): UsageSchema {
    if (!VERB.test(verb) || !Number.isInteger(version) || version < 1) {
        throw new Error(`Not a usage schema: verb "${verb}", version ${version}`);
    }

    return `usage.${verb}@${version}`;
}

export interface UsageEnvelopeInput<T> {
    verb: string;
    version: number;
    now: Date;
    window?: { from: Date; to: Date; tz: string; label: string };
    accounts: readonly AccountKey[];
    harnesses?: readonly string[];
    data: T;
    warnings?: readonly UsageWarning[];
}

/** Builds the envelope with its keys in one fixed order, so two runs over one store print the same bytes. */
export function usageEnvelope<T>(input: UsageEnvelopeInput<T>): UsageEnvelope<T> {
    const selector: UsageEnvelope<T>["selector"] = {
        accounts: input.accounts.map((account) => ({
            provider: account.provider,
            accountId: account.accountId,
            accountName: account.accountName,
        })),
        ...(input.harnesses === undefined ? {} : { harnesses: [...input.harnesses] }),
    };

    return {
        schema: usageSchema(input.verb, input.version),
        generatedAt: input.now.toISOString(),
        ...(input.window === undefined
            ? {}
            : {
                  window: {
                      from: input.window.from.toISOString(),
                      to: input.window.to.toISOString(),
                      tz: input.window.tz,
                      label: input.window.label,
                  },
              }),
        selector,
        data: input.data,
        warnings: [...(input.warnings ?? [])],
    };
}

/** The distinct accounts of a list of rows, in first-seen order. */
export function accountKeysOf(rows: readonly AccountKey[]): AccountKey[] {
    const seen = new Set<string>();
    const out: AccountKey[] = [];

    for (const row of rows) {
        const id = `${row.provider}\u0000${row.accountId}`;

        if (seen.has(id)) {
            continue;
        }

        seen.add(id);
        out.push({ provider: row.provider, accountId: row.accountId, accountName: row.accountName });
    }

    return out;
}
