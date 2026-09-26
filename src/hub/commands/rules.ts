import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    addRule,
    type HubRule,
    RULE_KIND_LABELS,
    RULE_KINDS,
    type RuleKind,
    type RulesRunResult,
    readRulesConfig,
    ruleLabel,
    ruleProblem,
    rulesConfigPath,
    runRules,
    writeRulesConfig,
} from "../lib/rules";

function isRuleKind(value: string): value is RuleKind {
    return (RULE_KINDS as readonly string[]).includes(value);
}

function number(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${flag} takes a positive number, got "${value}"`);
    }

    return parsed;
}

function onOff(value: string): boolean {
    if (value === "on" || value === "true") {
        return true;
    }

    if (value === "off" || value === "false") {
        return false;
    }

    throw new Error(`--enabled takes on or off, got "${value}"`);
}

function fail(error: unknown): void {
    out.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

function printRun(result: RulesRunResult): void {
    if (result.skipped) {
        out.println(`Skipped: ${result.skipped}`);
        return;
    }

    const table = createBoxTable(["RULE", "STATE", "MATCHES", result.dryRun ? "WOULD NOTIFY" : "NOTIFIED"]);

    for (const report of result.reports) {
        const state = report.problem
            ? formatDotStatus("err", report.problem)
            : !report.enabled
              ? formatDotStatus("dim", "off")
              : report.seeded
                ? formatDotStatus("warn", "first run: baseline taken")
                : formatDotStatus("ok", "on");
        table.push([`${report.label}\n${pc.dim(report.id)}`, state, String(report.matches), String(report.fired)]);
    }

    out.println(table.toString());

    for (const firing of result.firings) {
        out.println(`→ ${firing.title} · ${firing.subtitle} · ${firing.message}`);
    }

    for (const note of result.reports.map((report) => report.note).filter(Boolean)) {
        out.println(pc.dim(`  ${note}`));
    }

    out.println(
        pc.dim(
            result.dryRun
                ? "Test only: nothing was posted and nothing was saved."
                : `${result.posted} notifications posted.`
        )
    );
}

export function registerRulesCommand(program: Command): void {
    const rules = program
        .command("rules")
        .description(
            `Notification rules the hub-pr-notify daemon tick evaluates (${RULE_KINDS.join(", ")}). Stored in the hub config (~/.genesis-tools/hub/config.json, key notificationRules)`
        );

    rules
        .command("list", { isDefault: true })
        .description("The rules and their settings")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const config = await readRulesConfig();

            if (opts.json) {
                out.result({
                    ...config,
                    configPath: rulesConfigPath(),
                    kinds: RULE_KINDS.map((kind) => ({ kind, label: RULE_KIND_LABELS[kind] })),
                    labels: Object.fromEntries(config.rules.map((rule) => [rule.id, ruleLabel(rule)])),
                });
                return;
            }

            renderCliHeader("Hub notification rules", rulesConfigPath());

            if (config.rules.length === 0) {
                out.println("No rules. Add one: tools hub rules add --kind idle --minutes 30");
                return;
            }

            const table = createBoxTable(["ID", "RULE", "STATE"]);

            for (const rule of config.rules) {
                const problem = ruleProblem(rule);
                table.push([
                    rule.id,
                    ruleLabel(rule),
                    problem
                        ? formatDotStatus("err", problem)
                        : formatDotStatus(rule.enabled ? "ok" : "dim", rule.enabled ? "on" : "off"),
                ]);
            }

            out.println(table.toString());
        });

    rules
        .command("add")
        .description("Add a rule")
        .requiredOption("--kind <kind>", `one of: ${RULE_KINDS.join(", ")}`)
        .option("--minutes <n>", "idle: minutes without activity")
        .option("--percent <n>", "context: percent of the model's context window")
        .option("--project <text>", "idle, decision, context: only sessions whose project or folder contains this")
        .option("--match <text>", "ciFailed: only PRs whose owner/repo#number contains this")
        .option("--label <text>", "the rule's name in notifications and the list")
        .option("--disabled", "add it switched off")
        .option("--json", "print the new rule as JSON")
        .action(
            async (opts: {
                kind: string;
                minutes?: string;
                percent?: string;
                project?: string;
                match?: string;
                label?: string;
                disabled?: boolean;
                json?: boolean;
            }) => {
                try {
                    if (!isRuleKind(opts.kind)) {
                        throw new Error(`--kind takes ${RULE_KINDS.join(", ")}, got "${opts.kind}"`);
                    }

                    const config = await readRulesConfig();
                    const rule = addRule(config, {
                        kind: opts.kind,
                        minutes: number(opts.minutes, "--minutes"),
                        percent: number(opts.percent, "--percent"),
                        project: opts.project,
                        match: opts.match,
                        label: opts.label,
                        enabled: !opts.disabled,
                    });
                    await writeRulesConfig(config);

                    if (opts.json) {
                        out.result(rule);
                        return;
                    }

                    out.log.success(`Added ${rule.id}: ${ruleLabel(rule)}`);
                } catch (error) {
                    fail(error);
                }
            }
        );

    rules
        .command("set <id>")
        .description("Change a rule: switch it, or its threshold, scope or label")
        .option("--enabled <on|off>", "switch it on or off")
        .option("--minutes <n>", "idle threshold")
        .option("--percent <n>", "context threshold")
        .option("--project <text>", "scope ('' clears it)")
        .option("--match <text>", "PR filter ('' clears it)")
        .option("--label <text>", "name ('' clears it)")
        .option("--json", "print the rule as JSON")
        .action(
            async (
                id: string,
                opts: {
                    enabled?: string;
                    minutes?: string;
                    percent?: string;
                    project?: string;
                    match?: string;
                    label?: string;
                    json?: boolean;
                }
            ) => {
                try {
                    const config = await readRulesConfig();
                    const rule = config.rules.find((entry) => entry.id === id);

                    if (!rule) {
                        throw new Error(`no rule ${id} (tools hub rules list)`);
                    }

                    const next: HubRule = { ...rule };

                    if (opts.enabled !== undefined) {
                        next.enabled = onOff(opts.enabled);
                    }

                    next.minutes = number(opts.minutes, "--minutes") ?? next.minutes;
                    next.percent = number(opts.percent, "--percent") ?? next.percent;

                    for (const key of ["project", "match", "label"] as const) {
                        const value = opts[key];

                        if (value !== undefined) {
                            if (value.trim()) {
                                next[key] = value.trim();
                            } else {
                                delete next[key];
                            }
                        }
                    }

                    const problem = ruleProblem(next);

                    if (problem) {
                        throw new Error(problem);
                    }

                    config.rules = config.rules.map((entry) => (entry.id === id ? next : entry));
                    await writeRulesConfig(config);

                    if (opts.json) {
                        out.result(next);
                        return;
                    }

                    out.log.success(`Saved ${id}: ${ruleLabel(next)}${next.enabled ? "" : " (off)"}`);
                } catch (error) {
                    fail(error);
                }
            }
        );

    rules
        .command("rm <id>")
        .description("Remove a rule")
        .action(async (id: string) => {
            const config = await readRulesConfig();
            const kept = config.rules.filter((rule) => rule.id !== id);

            if (kept.length === config.rules.length) {
                fail(new Error(`no rule ${id} (tools hub rules list)`));
                return;
            }

            await writeRulesConfig({ rules: kept });
            out.log.success(`Removed ${id}`);
        });

    rules
        .command("test")
        .description("Evaluate every rule now and show what would notify; posts nothing and saves nothing")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const result = await runRules({ dryRun: true });

            if (opts.json) {
                out.result(result);
                return;
            }

            printRun(result);
        });

    rules
        .command("run")
        .description("Evaluate every rule and post what is new (what the daemon tick does)")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const result = await runRules();

            if (opts.json) {
                out.result(result);
                return;
            }

            printRun(result);
        });
}
