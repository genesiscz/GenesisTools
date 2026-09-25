import { billingAnchor, formatRenewsAtFull, nextRenewalDate } from "@app/claude/lib/usage/subscription";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { calendarDay } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/subscription";
import { stampSnapshotsRenewal } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

/** Whether year, month and day name a real calendar day (no February 30 rolling into March). */
function isCalendarDay(year: number, month: number, day: number): boolean {
    const probe = new Date(Date.UTC(year, month - 1, day));

    return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * `2026-07-07`, or an ISO timestamp `2026-07-07T10:00[:00[.000]](Z|±hh:mm)`. A date-only input is
 * stored AS the calendar day (`2026-07-07`), and the projection reads it as local noon wherever it
 * runs, so the same config names the same day in every timezone. Anything else, and any date that
 * does not exist (month 13, February 30), is refused rather than normalized.
 */
export function parseAnchor(input: string): string | null {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);

    if (dateOnly) {
        const [, year, month, day] = dateOnly;
        return isCalendarDay(Number(year), Number(month), Number(day)) ? input : null;
    }

    const stamp = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input);

    if (!stamp || !isCalendarDay(Number(stamp[1]), Number(stamp[2]), Number(stamp[3]))) {
        return null;
    }

    const parsed = new Date(input);

    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function sourceOf(account: AIAccountEntry): string {
    if (account.subscriptionAnchorOverride) {
        return "manual";
    }

    if (
        account.subscriptionReactivatedAt &&
        account.subscriptionCreatedAt &&
        Date.parse(account.subscriptionReactivatedAt) > Date.parse(account.subscriptionCreatedAt)
    ) {
        return "reactivation";
    }

    return "profile";
}

function listAnchors(accounts: AIAccountEntry[], now: Date): void {
    out.println(pc.dim("  Billing anchors — the day every projected renewal is derived from.\n"));

    for (const account of accounts) {
        const anchor = billingAnchor(account);
        const ends = formatRenewsAtFull(anchor, now) ?? "ends —";

        out.println(
            `  ${account.name.padEnd(28)} ${pc.dim((anchor ?? "—").slice(0, 10).padEnd(12))} ${sourceOf(account).padEnd(14)}${pc.dim(ends)}`
        );
    }

    out.println("");
    out.println(pc.dim("  profile      = subscription_created_at (does not move when the plan changes)"));
    out.println(pc.dim("  reactivation = a canceled→active flip a poll watched"));
    out.println(pc.dim("  manual       = set here; wins over both"));
    out.println("");
    out.println(pc.dim("  tools claude anchor <name> 2026-07-07    set"));
    out.println(
        pc.dim("  tools claude anchor <name> --clear       back to the reactivation stamp, else the profile stamp")
    );
}

/**
 * Anthropic's profile has no period end. `subscription_created_at` is the
 * original signup, so a plan change that moved the charge day (one account: created
 * the 24th, invoices on the 7th) can only be corrected here.
 */
export function registerAnchorCommand(program: Command): void {
    program
        .command("anchor [name] [date]")
        .description("Show or correct the billing-day anchor (the profile has no renewal date)")
        .option(
            "--clear",
            "Drop the manual anchor; the later of a watched reactivation and the profile signup stamp applies again"
        )
        .action(async (name: string | undefined, date: string | undefined, opts: { clear?: boolean }) => {
            const config = await AIConfig.load();
            const accounts = config.getAccountsByProvider("anthropic-sub");
            const now = new Date();

            if (!name) {
                listAnchors(accounts, now);
                return;
            }

            const target = accounts.find((account) => account.name === name);

            if (!target) {
                out.log.error(`No Claude account named "${name}".`);
                process.exitCode = 1;
                return;
            }

            const plan = planAnchor(target, { date, clear: opts.clear === true, now });

            if (!plan.ok) {
                out.log.error(plan.error);
                process.exitCode = 1;
                return;
            }

            // The config is the record; the snapshots cache only mirrors it, so it is written second.
            await saveAnchorOverride(name, plan.override);
            out.println(
                opts.clear
                    ? `Cleared the manual anchor for ${name}.`
                    : `Anchored ${name} to ${plan.override?.slice(0, 10)}.`
            );
            out.println(pc.dim(`  ${formatRenewsAtFull(plan.anchor, now) ?? "ends —"}`));

            // The popup reads the snapshots cache. The next poll rewrites it; don't wait for that.
            // A clear that leaves no anchor removes the cached date rather than keeping a stale one.
            try {
                await stampSnapshotsRenewal({
                    provider: "anthropic-sub",
                    accountName: name,
                    renewsAt: plan.next ? calendarDay(plan.next) : null,
                    billingAnchor: plan.anchor ?? null,
                });
            } catch (error) {
                logger.debug({ error }, "snapshots cache renewal stamp failed");
                out.log.warn("The anchor is saved; the usage cache shows it after the next poll.");
            }
        });
}

/**
 * Writes the override on the ANTHROPIC account of that name, in the v4 store. The v3 facade's
 * `updateAccount` matches a name across every provider, so a same-named account of another
 * provider could have received the Claude billing anchor.
 */
async function saveAnchorOverride(name: string, override: string | undefined): Promise<void> {
    const store = await AiConfigStore.load();
    await store.mutate((config) => {
        const account = config.accounts.find((entry) => entry.provider === "anthropic-sub" && entry.name === name);

        if (!account) {
            throw new Error(`No Claude account named "${name}".`);
        }

        if (override) {
            account.subscriptionAnchorOverride = override;
        } else {
            delete account.subscriptionAnchorOverride;
        }
    });
}

export type AnchorPlan =
    | { ok: false; error: string }
    | { ok: true; override: string | undefined; anchor: string | undefined; next: Date | null };

/**
 * What a set or a clear does to one account, before anything is written: the override to store,
 * the anchor that then applies (a clear falls back to the profile stamps), and the next renewal.
 */
export function planAnchor(
    account: AIAccountEntry,
    { date, clear, now }: { date?: string; clear: boolean; now: Date }
): AnchorPlan {
    if (!clear && !date) {
        return { ok: false, error: "Give a date (`tools claude anchor <name> 2026-07-07`) or --clear." };
    }

    const override = clear ? undefined : (parseAnchor(date ?? "") ?? undefined);

    if (!clear && !override) {
        return { ok: false, error: `"${date}" is not a date — use YYYY-MM-DD.` };
    }

    const anchor = clear ? billingAnchor({ ...account, subscriptionAnchorOverride: undefined }) : override;

    return { ok: true, override, anchor, next: anchor ? nextRenewalDate(anchor, now) : null };
}
