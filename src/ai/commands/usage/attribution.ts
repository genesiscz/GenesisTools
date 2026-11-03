import {
    type AttributionOptions,
    queryAttribution,
    querySpikes,
    type SpikesOptions,
} from "@app/ai/lib/usage/attribution-query";
import { LIMIT_KIND_VALUES } from "@genesiscz/utils/ai/providers/account-features";
import type { AttributionData, SessionShare, SpikesData } from "@genesiscz/utils/ai/usage/attribution";
import { addReservedHarnessOption, addWindowOptions, type UsageEnvelope } from "@genesiscz/utils/ai/usage/contract";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { accountLabel, addSelectorOptions, emit, guarded, printWarnings } from "./limits";

function usd(value: number): string {
    return `$${value.toFixed(2)}`;
}

function sessionLine(session: SessionShare): string {
    const pin = session.basis === "none" ? pc.dim(" (no account)") : session.approximate ? pc.dim(" (last pin)") : "";
    return `${Math.round(session.share * 100)}% ${session.agent} ${session.sessionId.slice(0, 8)} ${truncateDisplay(session.project, 24)} ${usd(session.costUsd)}${pin}`;
}

function renderSpikes(envelope: UsageEnvelope<SpikesData>): void {
    const { settings, spikes } = envelope.data;
    renderCliHeader(
        "Usage spikes",
        `${envelope.window?.label ?? ""} · rise of ${settings.minDelta}+ points within ${settings.windowMinutes} min · ${spikes.length} found`
    );
    const table = createBoxTable(["ACCOUNT", "WINDOW", "WHEN", "RISE", "TOP SESSIONS"]);

    for (const spike of spikes) {
        const top = spike.sessions.slice(0, 3).map(sessionLine);

        if (spike.unattributed.costUsd > 0 || spike.sessions.length === 0) {
            top.push(
                pc.magenta(
                    `${Math.round(spike.unattributed.share * 100)}% unattributed (another host or a missing pin) ${usd(spike.unattributed.costUsd)}`
                )
            );
        }

        table.push([
            accountLabel(spike.account),
            spike.kind ?? spike.key,
            `${new Date(spike.from).toLocaleString()} → ${new Date(spike.to).toLocaleTimeString()}`,
            `+${spike.delta.toFixed(1)} (${spike.startPercent.toFixed(0)}→${spike.endPercent.toFixed(0)}%)`,
            top.join("\n"),
        ]);
    }

    out.println(table.toString());
    printWarnings(envelope.warnings);
}

function renderAttribution(envelope: UsageEnvelope<AttributionData>): void {
    renderCliHeader("Who ate the bar", envelope.window?.label ?? "");

    for (const bar of envelope.data.bars) {
        const since = `${bar.sinceReset ? "since reset" : "since"} ${new Date(bar.since).toLocaleString()}`;
        const rate = bar.usdPerPercent === null ? "" : ` · ${usd(bar.usdPerPercent)} per point`;
        out.println(
            pc.bold(
                `${accountLabel(bar.account)} ${bar.kind ?? bar.key}: +${bar.risePercent.toFixed(1)} points ${since} · ${usd(bar.totalUsd)}${rate}`
            )
        );
        const table = createBoxTable(["SHARE", "BAR", "COST", "MAIN / SUB", "SESSION", "PROJECT"]);

        for (const session of bar.sessions.slice(0, 10)) {
            table.push([
                `${Math.round(session.share * 100)}%`,
                `${session.barPercent.toFixed(1)}`,
                usd(session.costUsd),
                `${usd(session.mainUsd)} / ${usd(session.subagentUsd)}`,
                `${session.agent} ${session.sessionId.slice(0, 8)}${session.approximate ? pc.dim(" (last pin)") : ""}`,
                truncateDisplay(session.project, 30),
            ]);
        }

        if (bar.unattributed.costUsd > 0) {
            table.push([
                `${Math.round(bar.unattributed.share * 100)}%`,
                `${bar.unattributed.barPercent.toFixed(1)}`,
                usd(bar.unattributed.costUsd),
                "",
                pc.magenta("unpinned"),
                "",
            ]);
        }

        out.println(table.toString());
    }

    printWarnings(envelope.warnings);
}

/**
 * `tools ai usage limits spikes` and `limits attribution` (design 2026-11-01, step U9): why a bar jumped, and which
 * work ate it since its reset. Both read the usage store and the ai-spend events cache, and name sessions through the
 * `SessionAccountSource` table; every session row prints its `tools ai sessions report <id>` as `next`.
 */
export function registerAiUsageAttributionCommands(limits: Command): void {
    const spikes = addWindowOptions(
        addSelectorOptions(
            limits
                .command("spikes")
                .description(
                    "Every rise of a window by --min-delta points within --window-min minutes, with the sessions that spent on that account; --json prints usage.limits.spikes@1"
                )
        ),
        { since: "24h" }
    )
        .option("--min-delta <points>", "The smallest rise that counts (default 5 points)")
        .option("--window-min <minutes>", "Within this many minutes (default 10)")
        .option("--kind [kinds...]", `Only these window kinds: ${LIMIT_KIND_VALUES.join(" | ")}`);

    addReservedHarnessOption(spikes).action(async (_opts: SpikesOptions, command: Command) => {
        await guarded(["limits", "spikes"], async () => {
            const opts = command.optsWithGlobals<SpikesOptions>();
            await emit(await querySpikes(opts), opts.json, renderSpikes);
        });
    });

    const attribution = addWindowOptions(
        addSelectorOptions(
            limits
                .command("attribution")
                .description(
                    "Who ate the bar: each window's rise since its last reset, split by project and session, in dollars and points; --json prints usage.limits.attribution@1"
                )
        ),
        { since: "the window's last reset (8d lookback)" }
    ).option("--kind [kinds...]", `Window kinds (default weekly): ${LIMIT_KIND_VALUES.join(" | ")}`);

    addReservedHarnessOption(attribution).action(async (_opts: AttributionOptions, command: Command) => {
        await guarded(["limits", "attribution"], async () => {
            const opts = command.optsWithGlobals<AttributionOptions>();
            await emit(await queryAttribution(opts), opts.json, renderAttribution);
        });
    });
}
