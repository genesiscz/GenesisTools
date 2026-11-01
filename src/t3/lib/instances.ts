import { embedAccountEnvVar, parseEmbedAccountRequest } from "@genesiscz/utils/ai/account-env";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { isGateOnly } from "@genesiscz/utils/ai/config/selectors";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessLabel, harnessPluginId } from "@genesiscz/utils/ai/providers/harness-index";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger } from "@genesiscz/utils/logger";
import { isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { type T3HostSpec, t3HostFor } from "./hosts";

const { log } = logger.scoped("t3:instances");

/** Every instance id this tool owns starts with it. Nothing else in `providerInstances` is ever written. */
export const OWNED_INSTANCE_PREFIX = "gt-";

const INSTANCE_ID_MAX = 64;

/** One `environment` row of a T3 Code provider instance (`packages/contracts/src/providerInstance.ts`). */
export interface T3EnvironmentVariable {
    name: string;
    value: string;
    sensitive: boolean;
    [key: string]: unknown;
}

/** A T3 Code provider instance. Keys this tool does not know stay as they are. */
export interface T3Instance {
    driver: string;
    displayName?: string;
    accentColor?: string;
    environment?: T3EnvironmentVariable[];
    enabled?: boolean;
    config?: unknown;
    [key: string]: unknown;
}

export function isOwnedInstanceId(id: string): boolean {
    return id.startsWith(OWNED_INSTANCE_PREFIX);
}

/** `gt-<alias>-<slug of account>`, inside T3's id rule `^[a-zA-Z][a-zA-Z0-9_-]*$`, 64 characters at most. */
export function instanceIdFor(alias: HarnessId, account: string): string {
    const slug =
        account
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "default";

    return `${OWNED_INSTANCE_PREFIX}${alias}-${slug}`.slice(0, INSTANCE_ID_MAX).replace(/-+$/, "");
}

/**
 * Two different account names that map to one instance id: `work laptop` and `work-laptop`, `Work` and `work`, or two
 * names that differ only past the id's 64th character. Writing both would leave one instance whose variable names the
 * second account under the first one's display name, so nothing is written.
 */
export class InstanceIdCollisionError extends Error {
    constructor(id: string, accounts: readonly string[]) {
        const named = accounts.length >= 2 ? accounts.map((account) => `"${account}"`).join(" and ") : "Two instances";
        super(
            `${named} map to the same T3 Code instance id "${id}", so one would run as the other. Rename one of the accounts, or remove that instance from T3 Code's settings first; nothing was written.`
        );
        this.name = "InstanceIdCollisionError";
    }
}

export function defaultDisplayName(alias: HarnessId, account: string): string {
    return `${harnessLabel(alias)} (${account})`;
}

/** What `providers add` and `providers sync` ask for one instance. */
export interface InstanceRequest {
    alias: HarnessId;
    /** The embed account value: an account name, `auto`, or `proxy:<account>/<provider>`. */
    account: string;
    /** The T3 Code facts of the agent's embed host (`t3HostFor`). */
    host: T3HostSpec;
    binaryPath: string;
    /** Set the display name. Undefined keeps the current one (T3 Code lets the user rename an instance). */
    displayName?: string;
    /** `next` sets the steer variable, `off` removes it, undefined keeps what is there. */
    steer?: "next" | "off";
}

function upsertVariable(rows: T3EnvironmentVariable[], name: string, value: string): T3EnvironmentVariable[] {
    const index = rows.findIndex((row) => row.name === name);

    if (index < 0) {
        return [...rows, { name, value, sensitive: false }];
    }

    return rows.map((row, at) => (at === index ? { ...row, value, sensitive: false } : row));
}

/**
 * The instance after a request: `driver`, `config.binaryPath` and the agent's embed variables are this tool's; every
 * other key, variable and config value stays. A new instance is enabled, because T3 Code leaves a Grok instance off
 * unless it says `enabled: true`.
 */
export function buildInstance(existing: T3Instance | undefined, request: InstanceRequest): T3Instance {
    const bound = existing ? instanceEmbed(existing) : null;
    const id = instanceIdFor(request.alias, request.account);

    // An instance another account name already runs as, under this id. A hand edit to a value with another id is not
    // a collision: the request puts back the account the id names.
    if (
        bound !== null &&
        bound.alias === request.alias &&
        bound.value !== request.account &&
        instanceIdFor(bound.alias, bound.value) === id
    ) {
        throw new InstanceIdCollisionError(id, [bound.value, request.account]);
    }

    const spec = request.host;
    let environment = upsertVariable(existing?.environment ?? [], embedAccountEnvVar(request.alias), request.account);

    if (spec.steer && request.steer === "next") {
        environment = upsertVariable(environment, spec.steer.variable, spec.steer.next);
    }

    if (spec.steer && request.steer === "off") {
        const variable = spec.steer.variable;
        environment = environment.filter((row) => row.name !== variable);
    }

    const config = isJsonObject(existing?.config) ? existing.config : {};

    return {
        ...existing,
        driver: request.host.driver,
        displayName: request.displayName ?? existing?.displayName ?? defaultDisplayName(request.alias, request.account),
        enabled: existing?.enabled ?? true,
        environment,
        config: { ...config, binaryPath: request.binaryPath },
    };
}

/** The embed account an instance names through its environment, and the agent that variable belongs to. */
export interface InstanceEmbed {
    alias: HarnessId;
    variable: string;
    value: string;
}

export function instanceEmbed(instance: T3Instance): InstanceEmbed | null {
    for (const alias of ACCOUNT_PROVIDER_ALIASES) {
        const variable = embedAccountEnvVar(alias);
        const row = instance.environment?.find((entry) => entry.name === variable);

        if (row && typeof row.value === "string") {
            return { alias, variable, value: row.value };
        }
    }

    return null;
}

export type EmbedAccountStatus = "exists" | "missing" | "wrong-provider" | "auto" | "proxy" | "invalid" | "none";

/** Whether the account an embed value names is in the GenesisTools AI config, under the agent's provider. */
export function embedAccountStatus(embed: InstanceEmbed | null, accounts: readonly AccountEntry[]): EmbedAccountStatus {
    if (!embed) {
        return "none";
    }

    let request: ReturnType<typeof parseEmbedAccountRequest>;

    try {
        request = parseEmbedAccountRequest(embed.value);
    } catch (error) {
        log.debug({ value: embed.value, error }, "unreadable embed account value");
        return "invalid";
    }

    if (request.kind !== "account") {
        return request.kind;
    }

    const provider = harnessPluginId(embed.alias);
    const named = accounts.filter((account) => account.id === request.name || account.name === request.name);

    if (named.length === 0) {
        return "missing";
    }

    return named.some((account) => account.provider === provider) ? "exists" : "wrong-provider";
}

export function instanceBinaryPath(instance: T3Instance): string | null {
    const config = instance.config;

    if (!isJsonObject(config) || typeof config.binaryPath !== "string") {
        return null;
    }

    return config.binaryPath;
}

/** One instance as `providers list` shows it. */
export interface InstanceRow {
    id: string;
    owned: boolean;
    driver: string;
    displayName: string | null;
    enabled: boolean | null;
    binaryPath: string | null;
    embedAccount: string | null;
    embedAlias: HarnessId | null;
    accountStatus: EmbedAccountStatus;
}

export function instanceRows(
    instances: Readonly<Record<string, T3Instance>>,
    accounts: readonly AccountEntry[]
): InstanceRow[] {
    return Object.entries(instances).map(([id, instance]) => {
        const embed = instanceEmbed(instance);

        return {
            id,
            owned: isOwnedInstanceId(id),
            driver: instance.driver,
            displayName: instance.displayName ?? null,
            enabled: typeof instance.enabled === "boolean" ? instance.enabled : null,
            binaryPath: instanceBinaryPath(instance),
            embedAccount: embed?.value ?? null,
            embedAlias: embed?.alias ?? null,
            accountStatus: embedAccountStatus(embed, accounts),
        };
    });
}

/** The accounts `providers sync` makes one instance for, per agent, with the agent's T3 Code host facts. */
export async function syncAccounts(
    accounts: readonly AccountEntry[],
    hostOf: (alias: HarnessId) => Promise<T3HostSpec> = t3HostFor
): Promise<Array<{ alias: HarnessId; account: AccountEntry; host: T3HostSpec }>> {
    const perAgent = await Promise.all(
        ACCOUNT_PROVIDER_ALIASES.map(async (alias) => {
            const host = await hostOf(alias);
            const provider = harnessPluginId(alias);

            return accounts
                .filter(
                    (account) =>
                        account.enabled && !isGateOnly(account) && account.provider === provider && host.syncs(account)
                )
                .map((account) => ({ alias, account, host }));
        })
    );

    return perAgent.flat();
}
