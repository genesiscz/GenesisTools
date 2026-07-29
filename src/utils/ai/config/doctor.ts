import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { lastVaultExportAt, masterKeySource, secrets } from "@genesiscz/utils/security";
import { describeCredential } from "../providers/credentials";
import type { ProviderPlugin } from "../providers/plugin-types";
import { tryProviderPlugin } from "../providers/registry";
import { AiConfigStore } from "./AiConfigStore";
import { allReferrers, refToId } from "./refs";
import type { AccountEntry } from "./schema";
import { envKeyNames } from "./selectors";

/**
 * One honest read of the whole AI configuration: where the master key comes
 * from, whether every enabled account can actually produce a credential, and
 * which links, vault entries and expiries have drifted out of agreement.
 *
 * Pure over the config + vault + environment, so it is testable against a
 * sandboxed `GENESIS_TOOLS_HOME` with no network and no CLI involved. It never
 * resolves a secret INTO its output: `describeCredential` reports the source
 * only, which is the whole reason it exists.
 */

export type DoctorLevel = "ok" | "warn" | "err";

export interface DoctorCheck {
    /** Stable machine id, safe to grep and to assert on. */
    id: string;
    /** What the check is about: a subsystem name, or an account name. */
    scope: string;
    level: DoctorLevel;
    detail: string;
}

export interface DoctorReport {
    /** False when any check failed outright. Warnings do not fail the report. */
    ok: boolean;
    counts: Record<DoctorLevel, number>;
    checks: DoctorCheck[];
}

export interface DoctorOptions {
    /**
     * Run each plugin's `health()` probe. Off by default because a health check
     * may touch the network, and `doctor` has to stay usable offline.
     */
    live?: boolean;
    /** Clock seam, so expiry checks are testable without waiting. */
    now?: number;
}

/** Warn this far ahead of a credential expiring. */
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

const VAULT_ACCOUNT_PREFIX = "ai/";

function check(id: string, scope: string, level: DoctorLevel, detail: string): DoctorCheck {
    return { id, scope, level, detail };
}

async function checkMasterKey(): Promise<DoctorCheck> {
    try {
        const source = await masterKeySource();
        if (!source) {
            return check(
                "master-key",
                "security",
                "warn",
                "no master key on any rung yet; one is generated on the first interactive secret write"
            );
        }

        return check("master-key", "security", "ok", `resolved from the ${source} rung`);
    } catch (err) {
        logger.debug({ err }, "doctor could not resolve the master key");
        return check("master-key", "security", "err", err instanceof Error ? err.message : String(err));
    }
}

async function vaultPaths(): Promise<{ paths: string[]; failure?: DoctorCheck }> {
    try {
        const store = await secrets();
        return { paths: await store.list() };
    } catch (err) {
        logger.debug({ err }, "doctor could not read the vault");
        return {
            paths: [],
            failure: check("vault", "security", "err", err instanceof Error ? err.message : String(err)),
        };
    }
}

function checkExpiry(account: AccountEntry, now: number): DoctorCheck[] {
    const fields: Array<[string, number | undefined]> = [
        ["accessToken", account.credentials.expiresAt],
        ["refreshToken", account.credentials.refreshExpiresAt],
        ["longLivedToken", account.credentials.longLivedTokenExpiresAt],
    ];

    const checks: DoctorCheck[] = [];

    for (const [field, expiresAt] of fields) {
        if (expiresAt === undefined) {
            continue;
        }

        if (expiresAt <= now) {
            checks.push(
                check(
                    "account.expiry",
                    account.name,
                    "err",
                    `${field} expired ${new Date(expiresAt).toISOString()}; re-login to refresh it`
                )
            );
            continue;
        }

        if (expiresAt - now <= EXPIRY_WARNING_MS) {
            const days = Math.max(1, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
            checks.push(check("account.expiry", account.name, "warn", `${field} expires in ${days}d`));
        }
    }

    return checks;
}

/**
 * A variable the provider would read is set, but the account opted out of the
 * environment. Nothing is broken; the point is that the user almost certainly
 * expects that variable to be in use and it silently is not.
 */
function checkEnvShadowing(account: AccountEntry, plugin: ProviderPlugin): DoctorCheck[] {
    const allowed = new Set(envKeyNames(account, plugin.credential.envKeys));
    const shadowed = plugin.credential.envKeys.filter((name) => !allowed.has(name) && env.ai.getByEnvKey(name));

    if (shadowed.length === 0) {
        return [];
    }

    return [
        check(
            "account.env-shadow",
            account.name,
            "warn",
            `${shadowed.join(", ")} set in the environment but deliberately ignored (useEnvApiKey is off for it); ` +
                `enable with: tools ai config account edit ${account.name} --use-env ${shadowed.join(",")}`
        ),
    ];
}

async function checkAccount(account: AccountEntry, options: DoctorOptions, now: number): Promise<DoctorCheck[]> {
    const plugin = tryProviderPlugin(account.provider);

    if (!plugin) {
        return [
            check(
                "account.plugin",
                account.name,
                "warn",
                `no provider plugin registered for "${account.provider}"; this account is reachable only through legacy code paths`
            ),
            ...checkExpiry(account, now),
        ];
    }

    const credential = await describeCredential(account, plugin.credential);
    const checks: DoctorCheck[] = [
        check(
            "account.credential",
            account.name,
            credential.ok ? "ok" : "err",
            credential.ok ? `credential from ${credential.detail}` : credential.detail
        ),
        ...checkExpiry(account, now),
        ...checkEnvShadowing(account, plugin),
    ];

    if (options.live && plugin.health) {
        try {
            const health = await plugin.health({ account });
            checks.push(check("account.health", account.name, health.ok ? "ok" : "err", health.detail));
        } catch (err) {
            logger.debug({ err, account: account.name }, "doctor health probe threw");
            checks.push(check("account.health", account.name, "err", err instanceof Error ? err.message : String(err)));
        }
    }

    return checks;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
    const now = options.now ?? Date.now();
    const store = await AiConfigStore.load();
    const config = store.data();
    const checks: DoctorCheck[] = [await checkMasterKey()];

    const { paths, failure } = await vaultPaths();
    checks.push(failure ?? check("vault", "security", "ok", `${paths.length} entries readable`));

    if (paths.length > 0) {
        const exportedAt = await lastVaultExportAt();
        checks.push(
            exportedAt === undefined
                ? check(
                      "escrow",
                      "security",
                      "warn",
                      "the vault has never been exported; losing the keychain entry would lose every secret. Run: tools ai config secret export --out <file>"
                  )
                : check("escrow", "security", "ok", `last exported ${new Date(exportedAt).toISOString()}`)
        );
    }

    for (const account of config.accounts.filter((entry) => entry.enabled)) {
        checks.push(...(await checkAccount(account, options, now)));
    }

    const ids = new Set(config.accounts.map((account) => account.id));

    for (const referrer of await allReferrers(config)) {
        const id = refToId(referrer.ref);
        if (!ids.has(id)) {
            checks.push(check("refs.dangling", referrer.path, "err", `points at "${id}", which no account has`));
        }
    }

    for (const path of paths) {
        if (!path.startsWith(VAULT_ACCOUNT_PREFIX)) {
            continue;
        }

        const id = path.slice(VAULT_ACCOUNT_PREFIX.length).split("/")[0];
        if (id && !ids.has(id)) {
            checks.push(check("vault.orphan", path, "warn", `no account "${id}" owns this secret; it can be deleted`));
        }
    }

    const counts: Record<DoctorLevel, number> = { ok: 0, warn: 0, err: 0 };
    for (const entry of checks) {
        counts[entry.level] += 1;
    }

    logger.debug({ counts }, "ran ai config doctor");
    return { ok: counts.err === 0, counts, checks };
}
