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
     * `--all-homes`. Ones already bound to an account are skipped here: the
     * account's own `spendScope` already contributed them, with its id.
     */
    discoveredHomes?: readonly DiscoveredHome[];
}

/**
 * Merge order, so a bound root always beats the unbound copy of itself:
 *
 * 1. `driver.roots(userHome)` — the unbound defaults.
 * 2. `driver.rootsForAccounts(accounts)` — the same trees, tagged.
 * 3. discovered homes no account claims — unbound.
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
        if (discovered.boundToAccountId) {
            continue;
        }

        for (const path of nativeSessionRootsForHome(options.driver.id, discovered.home)) {
            add({ path, home: discovered.home });
        }
    }

    return [...byPath.values()];
}

/**
 * The account a file belongs to, by LONGEST matching root path.
 *
 * Longest wins because roots nest: `~/.codex/sessions` sits under a discovered
 * `~/.codex`, and the more specific root is the one that was actually claimed.
 * A file under no bound root returns undefined, which reports as "(unbound)".
 */
export function accountIdForFile(file: string, roots: readonly DriverRoot[]): string | undefined {
    let best: DriverRoot | undefined;

    for (const root of roots) {
        if (!file.startsWith(`${root.path}/`) && file !== root.path) {
            continue;
        }

        if (!best || root.path.length > best.path.length) {
            best = root;
        }
    }

    return best?.accountId;
}
