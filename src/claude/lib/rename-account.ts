import { logger } from "@genesiscz/utils/logger";
import type { WarmupConfig } from "./config";
import { UsageHistoryDb } from "./usage/history-db";

export type RenameToResult = { name: string } | { error: "to-required" } | { error: "prompt" };

function rewriteNameList(names: string[], oldName: string, newName: string): string[] {
    return names.map((name) => (name === oldName ? newName : name));
}

/** Re-key warmup account lists and today's log. Returns a new object. */
export function rewriteWarmupNames(warmup: WarmupConfig, oldName: string, newName: string): WarmupConfig {
    return {
        session: { ...warmup.session, accounts: rewriteNameList(warmup.session.accounts, oldName, newName) },
        weekly: { ...warmup.weekly, accounts: rewriteNameList(warmup.weekly.accounts, oldName, newName) },
        todayLog: {
            ...warmup.todayLog,
            events: warmup.todayLog.events.map((event) =>
                event.account === oldName ? { ...event, account: newName } : event
            ),
        },
    };
}

/** Pick the new account name from `--to`, a leftover positional, or a TTY prompt. */
export function resolveRenameTo(opts: { positional?: string; toFlag?: string; interactive: boolean }): RenameToResult {
    const name = (opts.toFlag ?? opts.positional ?? "").trim();

    if (name) {
        return { name };
    }

    if (!opts.interactive) {
        return { error: "to-required" };
    }

    return { error: "prompt" };
}

/**
 * What a user can actually do after a partial rename.
 *
 * "Re-running rename will not fix these" was true and useless: it named the
 * dead end without naming the way out. Reversing the rename IS a repair. Every
 * store that failed still holds `oldName`, and the rekey helpers no-op on a key
 * they cannot find, so renaming back leaves one consistent set of names again.
 */
export function partialRenameAdvice(oldName: string, newName: string): string[] {
    return [
        `Re-running the rename cannot fix these: AIConfig no longer knows "${oldName}".`,
        "Rename back to get one consistent set of names again, then retry once the store is writable:",
        `  tools claude config rename ${newName} --to ${oldName}`,
    ];
}

export interface RenameClaudeAccountDeps {
    renameAiAccount?: (oldName: string, newName: string) => Promise<void>;
    rewriteWarmup?: (oldName: string, newName: string) => Promise<void>;
    renameHistory?: (oldName: string, newName: string) => number;
    rekeyPollGate?: (oldName: string, newName: string) => Promise<void>;
    rekeyInvalidGrant?: (oldName: string, newName: string) => Promise<void>;
    invalidateUsageCache?: () => Promise<void>;
}

const log = logger.child({ component: "claude:rename-account" });

export type RenameStep = "history" | "warmup" | "pollGate" | "invalidGrant" | "usageCache";
export type RenameStepFailure = { step: RenameStep; error: string };
export type RenameClaudeAccountResult = { historyRows: number; failed: RenameStepFailure[] };

async function defaultRenameAiAccount(oldName: string, newName: string): Promise<void> {
    const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
    const config = await AIConfig.load();
    await config.renameAccount(oldName, newName);
}

async function defaultRewriteWarmup(oldName: string, newName: string): Promise<void> {
    const { updateConfig } = await import("./config");
    await updateConfig((cfg) => {
        if (cfg.warmup) {
            cfg.warmup = rewriteWarmupNames(cfg.warmup, oldName, newName);
        }
    });
}

function defaultRenameHistory(oldName: string, newName: string): number {
    return new UsageHistoryDb().renameAccount(oldName, newName);
}

export function rekeyNamedRecord<T>(record: Record<string, T>, oldName: string, newName: string): Record<string, T> {
    if (!(oldName in record) || oldName === newName) {
        return record;
    }

    const next = { ...record, [newName]: record[oldName] };
    delete next[oldName];
    return next;
}

async function defaultRekeyPollGate(oldName: string, newName: string): Promise<void> {
    const { loadPollGate, savePollGate } = await import("./usage/poll-gate");
    const gate = await loadPollGate();

    if (!(oldName in gate)) {
        return;
    }

    await savePollGate(rekeyNamedRecord(gate, oldName, newName));
}

async function defaultRekeyInvalidGrant(oldName: string, newName: string): Promise<void> {
    const { rekeyInvalidGrant } = await import("@genesiscz/utils/claude/subscription-auth");
    await rekeyInvalidGrant(oldName, newName);
}

async function defaultInvalidateUsageCache(): Promise<void> {
    const { invalidateSharedUsage } = await import("./usage/shared-cache");
    await invalidateSharedUsage();
}

/**
 * Rename a Claude account across AIConfig, warmup lists, usage history, poll
 * gate, invalid-grant cooldown, and the shared usage cache.
 */
export async function renameClaudeAccount(
    oldName: string,
    newName: string,
    deps: RenameClaudeAccountDeps = {}
): Promise<RenameClaudeAccountResult> {
    const renameAiAccount = deps.renameAiAccount ?? defaultRenameAiAccount;
    const rewriteWarmup = deps.rewriteWarmup ?? defaultRewriteWarmup;
    const renameHistory = deps.renameHistory ?? defaultRenameHistory;
    const rekeyPollGate = deps.rekeyPollGate ?? defaultRekeyPollGate;
    const rekeyInvalidGrant = deps.rekeyInvalidGrant ?? defaultRekeyInvalidGrant;
    const invalidateUsageCache = deps.invalidateUsageCache ?? defaultInvalidateUsageCache;

    // AIConfig first: it is the identity of record, and the only step whose
    // failure means "nothing happened".
    await renameAiAccount(oldName, newName);

    // Every later store is secondary, history included. Running them with no
    // handler meant one throw left the account renamed in AIConfig while warmup
    // lists, the poll gate and the cooldown still held oldName. History used to
    // sit outside this loop, so a locked SQLite file skipped all four remaining
    // stores AND reported nothing (PR #332 review).
    let historyRows = 0;
    const failed: RenameStepFailure[] = [];
    const steps: Array<[RenameStep, () => Promise<void>]> = [
        [
            "history",
            async () => {
                historyRows = renameHistory(oldName, newName);
            },
        ],
        ["warmup", () => rewriteWarmup(oldName, newName)],
        ["pollGate", () => rekeyPollGate(oldName, newName)],
        ["invalidGrant", () => rekeyInvalidGrant(oldName, newName)],
        ["usageCache", () => invalidateUsageCache()],
    ];

    for (const [step, run] of steps) {
        try {
            await run();
        } catch (error) {
            log.warn({ error, step, oldName, newName }, "secondary rename step failed");
            failed.push({ step, error: error instanceof Error ? error.message : String(error) });
        }
    }

    return { historyRows, failed };
}
