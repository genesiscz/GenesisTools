import {
    type AlertRulesData,
    type AlertsListData,
    type AlertsListOptions,
    type AlertTestData,
    type AlertTestOptions,
    ackAlerts,
    queryAlertRules,
    queryAlerts,
    testAlertRule,
} from "@app/ai/lib/usage/alerts-query";
import { usageProviderValues } from "@app/ai/lib/usage/provider-values";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { ALERT_RULE_IDS, type AlertLevel } from "@genesiscz/utils/ai/usage/alerts/types";
import { addWindowOptions, type UsageEnvelope } from "@genesiscz/utils/ai/usage/contract";
import { aiUsageCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { emit, guarded, printWarnings } from "./limits";

const LEVEL_TONE: Record<AlertLevel, (text: string) => string> = {
    info: pc.cyan,
    warning: pc.yellow,
    critical: pc.red,
};

function who(alert: { provider: string | null; accountName: string | null }): string {
    if (alert.provider === null) {
        return pc.dim("all");
    }

    return `${providerAliasOf(alert.provider)}/${alert.accountName ?? "?"}`;
}

function renderList(envelope: UsageEnvelope<AlertsListData>): void {
    renderCliHeader("Usage alerts", `${envelope.window?.label ?? ""} · ${envelope.data.unacked} open`);
    const table = createBoxTable(["ID", "FIRED", "RULE", "ACCOUNT", "MESSAGE", "ACK"]);

    for (const alert of envelope.data.alerts) {
        table.push([
            String(alert.id),
            new Date(alert.firedAt).toLocaleString(),
            LEVEL_TONE[alert.level](alert.rule),
            who(alert),
            truncateDisplay(alert.message, 70),
            alert.ackAt === null ? pc.yellow("open") : pc.dim("acked"),
        ]);
    }

    out.println(table.toString());

    if (envelope.data.unacked > 0) {
        out.println(pc.dim(`Acknowledge: ${aiUsageCommand("alerts", "ack", "<id...>")} or --all`));
    }

    printWarnings(envelope.warnings);
}

function renderRules(envelope: UsageEnvelope<AlertRulesData>): void {
    const { data } = envelope;
    const quiet = data.quietHours ? `quiet ${data.quietHours.start}-${data.quietHours.end}` : "no quiet hours";
    renderCliHeader("Usage alert rules", `${data.enabled ? pc.green("engine on") : pc.red("engine off")} · ${quiet}`);
    const table = createBoxTable(["RULE", "ON", "CHANNELS", "SETTINGS", "OFF FOR"]);

    for (const rule of data.rules) {
        table.push([
            `${rule.id}\n${pc.dim(truncateDisplay(rule.description, 48))}`,
            rule.enabled ? pc.green("on") : pc.dim("off"),
            rule.channels.join(", ") || pc.dim("record only"),
            truncateDisplay(SafeJSON.stringify(rule.settings), 50),
            rule.offFor.join(", ") || pc.dim("—"),
        ]);
    }

    out.println(table.toString());
    printWarnings(envelope.warnings);
}

function renderTest(envelope: UsageEnvelope<AlertTestData>): void {
    const { data } = envelope;
    renderCliHeader(`Alert rule test: ${data.rule}`, `${data.candidates.length} finding(s) in the last poll`);

    for (const candidate of data.candidates) {
        const verdict = candidate.fires ? pc.green("would fire") : pc.dim(`already fired (#${candidate.previous?.id})`);
        out.println(`${LEVEL_TONE[candidate.level]("●")} ${who(candidate)}: ${candidate.message}`);
        out.println(pc.dim(`  ${verdict} · to ${candidate.channels.join(", ") || "the record only"}`));
    }

    if (data.sent) {
        out.println(pc.cyan(`Sent to: ${data.sent.join(", ") || "no channel (the rule has none now)"}`));
    }

    printWarnings(envelope.warnings);
}

interface AckFlags {
    all?: boolean;
    json?: boolean;
}

function addListOptions(command: Command): Command {
    return addWindowOptions(
        command
            .option("--provider [list...]", `Limit to these providers: ${usageProviderValues().join(" | ")}`)
            .option("--account <list...>", "Accounts by exact id or name")
            .option("--rule [rules...]", `Only these rules: ${ALERT_RULE_IDS.join(" | ")}`)
            .option("--unacked", "Only the alerts nobody acknowledged")
            .option("--json", "Print the JSON envelope"),
        { since: "7d" }
    );
}

async function runList(command: Command): Promise<void> {
    const opts = command.optsWithGlobals<AlertsListOptions>();
    await emit(await queryAlerts(opts), opts.json, renderList);
}

/**
 * `tools ai usage alerts list | ack | rules | test` (design 2026-11-01, step U7, proposal 7). `alerts` alone lists.
 * The engine runs in the usage daemon's tick; these verbs read its record, acknowledge it, show the rules and try one.
 */
export function registerAiUsageAlertsCommand(usage: Command): void {
    const alerts = addListOptions(
        usage
            .command("alerts")
            .description("Usage alerts the daemon fired (list, ack, rules, test); --json prints usage.alerts@1")
    ).action(async (_opts: AlertsListOptions, command: Command) => {
        await guarded(["alerts"], () => runList(command));
    });

    addListOptions(alerts.command("list").description("The alerts fired in the window, newest first")).action(
        async (_opts: AlertsListOptions, command: Command) => {
            await guarded(["alerts", "list"], () => runList(command));
        }
    );

    alerts
        .command("ack")
        .description("Acknowledge alerts by id, or every open one with --all")
        .argument("[ids...]", "Alert ids from the list")
        .option("--all", "Acknowledge every open alert")
        .option("--json", "Print the JSON envelope")
        .action(async (ids: string[], _opts: AckFlags, command: Command) => {
            await guarded(["alerts", "ack"], async () => {
                const opts = command.optsWithGlobals<AckFlags>();
                await emit(ackAlerts({ ids, ...(opts.all ? { all: true } : {}) }), opts.json, (envelope) =>
                    out.println(`Acknowledged ${envelope.data.acked} alert(s).`)
                );
            });
        });

    alerts
        .command("rules")
        .description(
            "Every alert rule with its settings, channels and provider overrides; --json prints usage.alerts.rules@1"
        )
        .option("--json", "Print the JSON envelope")
        .action(async (_opts: { json?: boolean }, command: Command) => {
            await guarded(["alerts", "rules"], async () => {
                await emit(await queryAlertRules(), command.optsWithGlobals<{ json?: boolean }>().json, renderRules);
            });
        });

    alerts
        .command("test")
        .description(
            "What one rule finds in the last poll and whether it would fire now; never polls or records. --send tries its channels"
        )
        .argument("<rule>", ALERT_RULE_IDS.join(" | "))
        .option("--account <list...>", "Only these accounts (exact id or name)")
        .option("--send", "Deliver the findings, or one test card, through the rule's channels")
        .option("--json", "Print the JSON envelope")
        .action(async (rule: string, _opts: AlertTestOptions, command: Command) => {
            await guarded(["alerts", "test"], async () => {
                const opts = command.optsWithGlobals<AlertTestOptions>();
                await emit(await testAlertRule(rule, opts), opts.json, renderTest);
            });
        });
}
