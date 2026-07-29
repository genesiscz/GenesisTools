import type { AccountEntry, AiConfigData } from "./schema";

/**
 * A resolvable pointer to an account, usable from ANY GenesisTools config.
 * Built from the immutable `id`, so renaming an account never breaks a link
 * (which is exactly what today's name-based `accountName` references do).
 */
export type AccountRef = `@account/${string}`;

const REF_PREFIX = "@account/";

export function accountRef(id: string): AccountRef {
    return `${REF_PREFIX}${id}`;
}

export function isAccountRef(value: unknown): value is AccountRef {
    return typeof value === "string" && value.startsWith(REF_PREFIX) && value.length > REF_PREFIX.length;
}

export function refToId(ref: AccountRef): string {
    return ref.slice(REF_PREFIX.length);
}

export function resolveRef(config: AiConfigData, ref: AccountRef): AccountEntry | undefined {
    const id = refToId(ref);
    return config.accounts.find((account) => account.id === id);
}

/**
 * A ModelRef may embed an account ref (`@account/acc_x:opus`), so extract the
 * account part before comparing.
 */
export function accountRefIn(value: string): AccountRef | undefined {
    if (!value.startsWith(REF_PREFIX)) {
        return undefined;
    }

    const withoutPrefix = value.slice(REF_PREFIX.length);
    const id = withoutPrefix.split(":")[0];
    if (!id) {
        return undefined;
    }

    return accountRef(id);
}

export interface Referrer {
    /** Dotted location inside the config, e.g. `defaults.app.youtube.chat.model`. */
    path: string;
    ref: AccountRef;
}

type ExternalScanner = () => Promise<Referrer[]>;

const externalScanners = new Map<string, ExternalScanner>();

/**
 * Other configs (ai-proxy's provider list, a tool's own settings) hold account
 * refs too. They register a scanner so `referrersOf` can answer "what breaks if
 * I delete this account" across the whole system, not just this file.
 */
export function registerExternalRefScanner(name: string, scan: ExternalScanner): void {
    externalScanners.set(name, scan);
}

export function _clearExternalRefScanners(): void {
    externalScanners.clear();
}

function walk(value: unknown, path: string, out: Referrer[]): void {
    if (typeof value === "string") {
        const ref = accountRefIn(value);
        if (ref) {
            out.push({ path, ref });
        }

        return;
    }

    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            walk(item, `${path}[${index}]`, out);
        });
        return;
    }

    if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            walk(child, path ? `${path}.${key}` : key, out);
        }
    }
}

/**
 * Every account ref held anywhere, in-config and via registered scanners,
 * whether or not the account it names still exists. `doctor` needs the unfiltered
 * list to spot refs that point at a deleted account.
 */
export async function allReferrers(config: AiConfigData): Promise<Referrer[]> {
    const found: Referrer[] = [];

    walk(config.defaults, "defaults", found);
    walk(config.models ?? {}, "models", found);

    for (const [name, scan] of externalScanners) {
        const external = await scan();
        for (const referrer of external) {
            found.push({ path: `${name}:${referrer.path}`, ref: referrer.ref });
        }
    }

    return found;
}

/** Everything pointing at this account, in-config and via registered scanners. */
export async function referrersOf(config: AiConfigData, id: string): Promise<Referrer[]> {
    const target = accountRef(id);
    const found = await allReferrers(config);

    return found.filter((referrer) => referrer.ref === target);
}
