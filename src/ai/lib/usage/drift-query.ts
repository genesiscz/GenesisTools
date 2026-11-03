import { loadAttributedSpend } from "@genesiscz/utils/ai/usage/attribution";
import {
    accountKeysOf,
    refuseHarness,
    resolveWindow,
    selectAccounts,
    type UsageEnvelope,
    usageEnvelope,
} from "@genesiscz/utils/ai/usage/contract";
import {
    computeDrift,
    DRIFT_DEFAULTS,
    type DriftData,
    type DriftSettings,
    LIMITS_DRIFT_SCHEMA,
    recordDrift,
} from "@genesiscz/utils/ai/usage/drift/drift";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { logger } from "@genesiscz/utils/logger";
import { type AttributionOptions, positive, readScope, resolveKinds, spendWarnings } from "./attribution-query";

export interface DriftOptions extends AttributionOptions {
    minWindows?: string;
    pad?: string;
    record?: boolean;
}

/**
 * `tools ai usage limits drift` (design 2026-11-01, step U12, proposal 13): tokens and dollars per point of a window
 * (weekly by default), per account, model and week, from exclusive windows, with the verdict against earlier weeks.
 * It reads only; `--record` also writes the weeks into `limit_drift`.
 */
export async function queryDrift(
    opts: DriftOptions,
    deps: { now?: Date; loadEvents?: typeof loadAttributedSpend; readScope?: typeof readScope } = {}
): Promise<UsageEnvelope<DriftData>> {
    refuseHarness(opts.harness);

    const now = deps.now ?? new Date();
    const window = resolveWindow(opts, { now, defaultSince: "28d" });
    const settings: DriftSettings = {
        ...DRIFT_DEFAULTS,
        minWindows: positive("--min-windows", opts.minWindows, DRIFT_DEFAULTS.minWindows),
        padMinutes: positive("--pad", opts.pad, DRIFT_DEFAULTS.padMinutes),
    };
    const kinds = resolveKinds(opts.kind, ["weekly"]);
    const scope = await (deps.readScope ?? readScope)({
        opts: { ...opts, account: undefined },
        from: window.from,
        to: window.to,
        kinds,
    });
    const events = await (deps.loadEvents ?? loadAttributedSpend)({
        from: window.from,
        now,
        directory: scope.directory,
    });
    // Every account's readings are read, since the other accounts decide which rises are exclusive; --account only
    // narrows the rows answered.
    const selection = selectAccounts(opts.account, scope.directory);
    const picked =
        selection === undefined
            ? undefined
            : new Set(selection.map((key) => `${key.provider}\u0000${key.accountName}`));
    // One call over every series: a model-scoped window is exclusive only when no unscoped (or other-model) window of
    // another account of its provider rose around it.
    const rows = computeDrift({
        series: scope.series,
        events,
        accountOf: scope.keyOf,
        settings,
        tz: window.tz,
    }).filter((row) => !picked || picked.has(`${row.account.provider}\u0000${row.account.accountName}`));

    if (opts.record) {
        const db = new UsageLimitsDb();

        try {
            logger.debug({ written: recordDrift(db.connection(), rows, now) }, "[ai-usage] limit drift recorded");
        } finally {
            db.close();
        }
    }

    logger.debug({ window: window.label, rows: rows.length }, "[ai-usage] limits drift");

    return usageEnvelope({
        ...LIMITS_DRIFT_SCHEMA,
        now,
        window,
        accounts: accountKeysOf(rows.map((row) => row.account)),
        data: { settings, rows },
        warnings: spendWarnings(events),
    });
}
