import { sep } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { nativeSessionRootsForHome } from "@genesiscz/utils/providers/session-paths";
import type { DriverRoot, MonitorDriver } from "./drivers";

/**
 * Which trees an agent walks, and who each one belongs to.
 *
 * One merge, shared by the monitor and by `reports/native.ts`, so a file is
 * attributed to the same account whichever door asked. Synchronous on purpose:
 * `buildMonitorReport` is sync end to end, so the caller awaits
 * `plugin.accounts.discoverHomes()` and hands the result in rather than making
 * every reader of the monitor async.
 */
export interface ResolveDriverRootsOptions {
    driver: MonitorDriver;
    /** User home directory the driver's default roots hang off. */
    userHome: string;
    /** Enabled accounts of this driver's provider. Absent means every root is unbound. */
    accounts?: readonly AccountEntry[];
    /**
     * Homes found on disk by `plugin.accounts.discoverHomes()`, from
     * `--all-homes`. Ones whose roots this merge already bound are skipped: the
     * account's own `spendScope` contributed them, with its id.
     */
    discoveredHomes?: readonly DiscoveredHome[];
}

/**
 * Merge order, so a bound root always beats the unbound copy of itself:
 *
 * 1. `driver.roots(userHome)` — the unbound defaults.
 * 2. `driver.rootsForAccounts(accounts)` — the same trees, tagged.
 * 3. discovered homes step 2 did not already bind — unbound.
 *
 * Deduped by path, last tagged writer wins over an untagged one.
 */
export function resolveDriverRoots(options: ResolveDriverRootsOptions): DriverRoot[] {
    const byPath = new Map<string, DriverRoot>();

    const add = (root: DriverRoot): void => {
        const existing = byPath.get(root.path);

        if (existing && (root.accountId === undefined || existing.accountId !== undefined)) {
            return;
        }

        byPath.set(root.path, root);
    };

    for (const path of options.driver.roots(options.userHome)) {
        add({ path });
    }

    const accounts = options.accounts ?? [];

    if (accounts.length > 0 && options.driver.rootsForAccounts) {
        for (const root of options.driver.rootsForAccounts([...accounts], options.userHome)) {
            add(root);
        }
    }

    for (const discovered of options.discoveredHomes ?? []) {
        const homeRoots = nativeSessionRootsForHome(options.driver.id, discovered.home);

        // The question is whether step 2 ALREADY bound this home, not what
        // `discovered.boundToAccountId` claims. Discovery matches homes against
        // every account of the provider, while the caller supplies only the
        // ENABLED ones, so a disabled account's home arrives flagged as bound
        // and is contributed by nobody. Trusting the flag dropped that home's
        // spend entirely, even under `--all-homes`; asking the map instead
        // still skips a genuinely bound home, so its archived roots do not
        // reappear as a second, unbound row.
        if (homeRoots.some((path) => byPath.get(path)?.accountId !== undefined)) {
            continue;
        }

        for (const path of homeRoots) {
            add({ path, home: discovered.home });
        }
    }

    return [...byPath.values()];
}

/**
 * The root a file sits under, by LONGEST matching path.
 *
 * Longest wins because roots nest: `~/.codex/sessions` sits under a discovered
 * `~/.codex`, and the more specific root is the one that was actually claimed.
 * The boundary check is on `${path}${sep}` rather than the bare prefix, so
 * `~/.codex/sessions-old` is not read as living under `~/.codex/sessions`.
 *
 * `sep`, never a literal `/`: both the roots and the transcript paths are built
 * with `node:path`, so on Windows they carry backslashes and a hard-coded slash
 * matched nothing — every bound home reported as unbound and `--account` then
 * dropped all of its spend. Same fix as `openai-sub/discover.ts:boundAccountId`.
 *
 * ONE selector, because a file's `accountId` and its `home` are two fields of
 * the same row: picking them with two separate loops let them drift apart.
 */
export function rootForFile(file: string, roots: readonly DriverRoot[]): DriverRoot | undefined {
    let best: DriverRoot | undefined;

    for (const root of roots) {
        if (!file.startsWith(`${root.path}${sep}`) && file !== root.path) {
            continue;
        }

        if (!best || root.path.length > best.path.length) {
            best = root;
        }
    }

    return best;
}

/** A file under no bound root returns undefined, which reports as "(unbound)". */
export function accountIdForFile(file: string, roots: readonly DriverRoot[]): string | undefined {
    return rootForFile(file, roots)?.accountId;
}
