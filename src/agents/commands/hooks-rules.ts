import { homedir } from "node:os";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { detectShellViolations } from "@genesiscz/utils/shell/rules";
import type { ShellRule } from "@genesiscz/utils/shell/rules/types";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    HARNESS_NAMES,
    type HarnessName,
    type HooksConfig,
    hooksConfigPath,
    loadHooksConfig,
} from "../lib/hooks/config";
import { recentBashCommands } from "../lib/hooks/corpus";
import {
    BUILT_IN_SOURCE,
    type CustomRules,
    type DetectFailure,
    loadRuleSet,
    type RuleSet,
} from "../lib/hooks/custom-rules";
import { repoRoot } from "../lib/hooks/install";
import { resolveOutcome } from "../lib/hooks/outcome";
import { checkRuleExamples, replayCorpus } from "../lib/hooks/rules-check";
import { ruleEnabled, setRuleSelection } from "../lib/hooks/set-config";

const DEFAULT_CORPUS = 2000;

export function shortPath(path: string): string {
    const home = homedir();

    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function sourceLabel(set: RuleSet, ruleId: string): string {
    const source = set.sources.get(ruleId) ?? BUILT_IN_SOURCE;

    return source === BUILT_IN_SOURCE ? source : shortPath(source);
}

/** `on`, `off`, and any harness that allows the rule on its own. */
export function ruleState(config: HooksConfig, ruleId: string): string {
    const allowedFor = HARNESS_NAMES.filter((harness) => config.guard.harnesses[harness]?.[ruleId] === "allow");
    const state = ruleEnabled(config, ruleId) ? "on" : "off";

    return allowedFor.length > 0 && state === "on" ? `on (allowed for ${allowedFor.join(", ")})` : state;
}

/** Every custom-rule problem as one warning line each, so a broken module is never silent. */
export function warnCustomProblems(custom: CustomRules | null): number {
    if (!custom) {
        return 0;
    }

    let problems = 0;

    for (const entry of custom.missing) {
        ui.warn(`custom rules: ${entry.source}: ${entry.reason}`);
        problems += 1;
    }

    for (const module of custom.modules) {
        if (module.status === "failed") {
            ui.warn(`custom rules: ${shortPath(module.file)} failed to load: ${module.reason}`);
            problems += 1;
        }

        for (const refused of module.refused) {
            ui.warn(`custom rules: ${shortPath(module.file)}: refused ${refused.id}: ${refused.reason}`);
            problems += 1;
        }
    }

    return problems;
}

function findRule(set: RuleSet, id: string): ShellRule | undefined {
    return set.rules.find((rule) => rule.id === id);
}

function isHarness(value: string): value is HarnessName {
    return (HARNESS_NAMES as readonly string[]).includes(value);
}

function parseIds(value: string | boolean | undefined): string[] {
    return typeof value === "string"
        ? value
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
        : [];
}

export function registerRuleCommands(hooks: Command): void {
    const rules = hooks.command("rules").description("Inspect and verify the shell rules, built-in and custom");

    rules
        .command("list", { isDefault: true })
        .description("Every rule with its source, kind, severity and whether it is on")
        .option("--json", "Emit machine-readable JSON")
        .action(async (options: { json?: boolean }) => {
            const config = loadHooksConfig();
            const set = await loadRuleSet(config);

            if (options.json) {
                out.result(
                    set.rules.map(({ id, kind, severity, title }) => ({
                        id,
                        kind,
                        severity,
                        title,
                        source: set.sources.get(id) ?? BUILT_IN_SOURCE,
                        enabled: ruleEnabled(config, id),
                    }))
                );
                return;
            }

            const custom = set.rules.length - set.rules.filter((r) => set.sources.get(r.id) === BUILT_IN_SOURCE).length;

            renderCliHeader("Shell rules", `${set.rules.length - custom} built-in, ${custom} custom`);

            const table = createBoxTable(["ID", "SOURCE", "KIND", "SEVERITY", "STATE", "TITLE"]);

            for (const rule of set.rules) {
                const state = ruleState(config, rule.id);

                table.push([
                    pc.white(rule.id),
                    sourceLabel(set, rule.id),
                    rule.kind,
                    rule.severity,
                    state === "off" ? pc.yellow(state) : state,
                    rule.title.slice(0, 60),
                ]);
            }

            out.println(table.toString());
            warnCustomProblems(set.custom);
        });

    rules
        .command("explain")
        .description("Why one rule exists, with its wrong and right forms")
        .argument("<id>", "Rule id from `rules list`")
        .action(async (id: string) => {
            const set = await loadRuleSet(loadHooksConfig());
            const rule = findRule(set, id);

            if (!rule) {
                logger.error({ id }, "No such rule");
                warnCustomProblems(set.custom);
                process.exitCode = 1;
                return;
            }

            ui.raw(`${pc.bold(rule.id)} ${pc.dim(`${rule.kind} · ${rule.severity} · ${sourceLabel(set, rule.id)}`)}`);
            ui.raw("");
            ui.raw(rule.why);
            ui.raw("");
            ui.raw(`${pc.red("wrong")}  ${rule.wrong}`);
            ui.raw(`${pc.green("right")}  ${rule.right}`);

            if (rule.evidence) {
                ui.raw("");
                ui.raw(pc.dim(rule.evidence));
            }
        });

    rules
        .command("test")
        .description("Show which rules a command trips, and the resolved outcome")
        .argument("<command>", "The shell command to check")
        .option("--harness [name]", "claude, codex or grok (default: claude)")
        .option("--model <id>", "Model id for glob overrides")
        .option("--cwd <dir>", "The folder the command would run in (for rules that read the project)")
        .action(async (command: string, options: { harness?: string | boolean; model?: string; cwd?: string }) => {
            const given = options.harness;

            if (given !== undefined && (typeof given !== "string" || !isHarness(given))) {
                out.println(
                    suggestEnumFlag("tools agents hooks rules test", "--harness", HARNESS_NAMES, {
                        subcommand: ["hooks", "rules", "test"],
                        given: String(given),
                    })
                );
                process.exitCode = 1;
                return;
            }

            const config = loadHooksConfig();
            const set = await loadRuleSet(config);
            const harness: HarnessName = given ?? "claude";
            // Every rule that fired, `allow` included, so a rule switched off still shows why it is quiet.
            const violations = detectShellViolations(command, set.rules, { cwd: options.cwd ?? process.cwd() });

            warnCustomProblems(set.custom);

            if (violations.length === 0) {
                ui.raw(pc.green("no rule matched"));
                return;
            }

            for (const violation of violations) {
                const { outcome, trace } = resolveOutcome({
                    ruleId: violation.ruleId,
                    ruleSeverity: violation.severity,
                    kind: violation.kind,
                    harness,
                    model: options.model ?? "",
                    command,
                    config: config.guard,
                });

                ui.raw(
                    `${pc.bold(violation.ruleId)} → ${outcome} ${pc.dim(`(${sourceLabel(set, violation.ruleId)})`)}`
                );

                for (const [layer, value] of trace) {
                    ui.raw(pc.dim(`    ${layer}: ${value}`));
                }
            }
        });

    rules
        .command("check")
        .description(
            "Run every enabled rule's own wrong and right examples (built-in and custom); with --corpus, replay recent Bash commands from Claude transcripts and count what each rule would fire on"
        )
        .option("--corpus [count]", `Replay the newest N unique Bash commands (default ${DEFAULT_CORPUS})`)
        .option("--cwd <dir>", "Folder the examples run in, for rules that read the project (default: this checkout)")
        .option("--json", "Emit machine-readable JSON")
        .action(async (options: { corpus?: string | boolean; cwd?: string; json?: boolean }) => {
            let corpusSize = 0;

            if (options.corpus !== undefined) {
                corpusSize = options.corpus === true ? DEFAULT_CORPUS : Number(options.corpus);

                if (!Number.isInteger(corpusSize) || corpusSize < 1) {
                    ui.err(`--corpus takes a positive whole number, got ${String(options.corpus)}`);
                    process.exitCode = 1;
                    return;
                }
            }

            const config = loadHooksConfig();
            const failures: DetectFailure[] = [];
            const set = await loadRuleSet(config, { onDetectError: (failure) => failures.push(failure) });
            const enabled = set.rules.filter((rule) => ruleEnabled(config, rule.id));
            const cwd = options.cwd ?? repoRoot();
            const checks = checkRuleExamples(enabled, { cwd });
            const corpus = corpusSize > 0 ? replayCorpus(recentBashCommands(corpusSize), enabled) : null;
            const failedChecks = checks.filter((check) => !check.ok);

            if (options.json) {
                out.result({
                    checks: checks.map((check) => ({ ...check, source: set.sources.get(check.ruleId) })),
                    corpus,
                    detectFailures: failures.map(({ ruleId, file, err }) => ({
                        ruleId,
                        file,
                        error: err instanceof Error ? err.message : String(err),
                    })),
                    custom: set.custom,
                });
            } else {
                renderCliHeader("Rule check", `${enabled.length} enabled rules, examples run in ${shortPath(cwd)}`);

                const table = createBoxTable(["RULE", "SOURCE", "WRONG FIRES", "RIGHT QUIET"]);

                for (const check of checks) {
                    const wrongOk = check.wrongGot.length === 1 && check.wrongGot[0] === check.ruleId;

                    table.push([
                        check.ok ? pc.white(check.ruleId) : pc.red(check.ruleId),
                        sourceLabel(set, check.ruleId),
                        wrongOk ? pc.green("yes") : pc.red(`no (${check.wrongGot.join(", ") || "nothing fired"})`),
                        check.rightGot.length === 0 ? pc.green("yes") : pc.red(`no (${check.rightGot.join(", ")})`),
                    ]);
                }

                out.println(table.toString());

                if (corpus) {
                    out.println("");
                    renderCliHeader("Corpus replay", `${corpus.commands} recent unique Bash commands`);

                    const replay = createBoxTable(["RULE", "FIRED", "SHARE", "SAMPLES"]);

                    for (const row of [...corpus.rows].sort((a, b) => b.fired - a.fired)) {
                        const share =
                            corpus.commands > 0 ? `${((row.fired / corpus.commands) * 100).toFixed(1)}%` : "-";

                        replay.push([row.ruleId, String(row.fired), share, row.samples.join("\n") || pc.dim("-")]);
                    }

                    out.println(replay.toString());
                }
            }

            const problems = warnCustomProblems(set.custom);
            const byRule = new Map<string, DetectFailure[]>();

            for (const failure of failures) {
                byRule.set(failure.ruleId, [...(byRule.get(failure.ruleId) ?? []), failure]);
            }

            for (const [ruleId, list] of byRule) {
                const first = list[0]?.err;

                ui.warn(
                    `custom rule ${ruleId} failed ${list.length} time(s) while checking: ${first instanceof Error ? first.message : String(first)}`
                );
            }

            if (failedChecks.length > 0 || problems > 0 || byRule.size > 0) {
                process.exitCode = 1;
            }
        });
}

/** `config rules`: the picker. It changes only `guard.default` in the hooks config file. */
export function registerRulePicker(configCommand: Command): void {
    configCommand
        .command("rules")
        .description(
            "Switch rules on and off, built-in and custom. A terminal gets a picker; elsewhere, or with flags, it prints the list and takes --enable/--disable"
        )
        .option("--enable [ids]", "Comma list of rule ids to switch on")
        .option("--disable [ids]", "Comma list of rule ids to switch off")
        .option("--write", "With --enable/--disable: actually write; without it this is a dry run")
        .action(async (options: { enable?: string | boolean; disable?: string | boolean; write?: boolean }) => {
            const config = loadHooksConfig();
            const set = await loadRuleSet(config);
            const ids = set.rules.map((rule) => rule.id);
            const ruleIds = new Set(ids);

            warnCustomProblems(set.custom);

            for (const flag of ["enable", "disable"] as const) {
                if (options[flag] === true) {
                    out.println(
                        suggestEnumFlag("tools agents hooks config rules", `--${flag}`, ids, {
                            subcommand: ["hooks", "config", "rules"],
                        })
                    );
                    process.exitCode = 1;
                    return;
                }
            }

            const flagged = options.enable !== undefined || options.disable !== undefined;

            if (flagged) {
                applySelection({
                    enable: parseIds(options.enable),
                    disable: parseIds(options.disable),
                    write: Boolean(options.write),
                    ruleIds,
                });
                return;
            }

            if (!isInteractive()) {
                printRuleCatalogue(config, set);
                ui.raw("");
                ui.raw(
                    `Switch rules with: ${suggestCommand("tools agents", { replaceCommand: ["hooks", "config", "rules", "--disable", "<id,...>", "--enable", "<id,...>", "--write"] })}`
                );
                return;
            }

            printRuleCatalogue(config, set, { details: true });

            const picked = await p.multiselect({
                message: "Rules to keep on (space toggles, enter saves to the hooks config)",
                options: set.rules.map((rule) => ({
                    value: rule.id,
                    label: `${rule.id}: ${rule.title}`,
                    hint: `${rule.kind} · ${rule.severity} · ${sourceLabel(set, rule.id)} · wrong: ${rule.wrong} · right: ${rule.right}`,
                })),
                initialValues: ids.filter((id) => ruleEnabled(config, id)),
                required: false,
            });

            if (p.isCancel(picked)) {
                p.cancel("Nothing changed.");
                return;
            }

            const on = new Set(picked.map(String));

            applySelection({
                enable: ids.filter((id) => on.has(id)),
                disable: ids.filter((id) => !on.has(id)),
                write: true,
                ruleIds,
            });
        });
}

function printRuleCatalogue(config: HooksConfig, set: RuleSet, options: { details?: boolean } = {}): void {
    if (!options.details) {
        const table = createBoxTable(["ID", "SOURCE", "KIND", "SEVERITY", "STATE"]);

        for (const rule of set.rules) {
            table.push([rule.id, sourceLabel(set, rule.id), rule.kind, rule.severity, ruleState(config, rule.id)]);
        }

        out.println(table.toString());
        return;
    }

    for (const rule of set.rules) {
        ui.raw(
            `${pc.bold(rule.id)} ${pc.dim(`${rule.kind} · ${rule.severity} · ${sourceLabel(set, rule.id)} · ${ruleState(config, rule.id)}`)}`
        );
        ui.raw(`  ${rule.title}`);
        ui.raw(pc.dim(`  why: ${rule.why}`));
        ui.raw(`  ${pc.red("wrong")} ${rule.wrong}`);
        ui.raw(`  ${pc.green("right")} ${rule.right}`);
        ui.raw("");
    }
}

function applySelection(options: {
    enable: string[];
    disable: string[];
    write: boolean;
    ruleIds: ReadonlySet<string>;
}): void {
    let result: ReturnType<typeof setRuleSelection>;

    try {
        result = setRuleSelection(
            { enable: options.enable, disable: options.disable },
            { write: options.write, ruleIds: options.ruleIds }
        );
    } catch (err) {
        logger.debug({ err, enable: options.enable, disable: options.disable }, "Rejected a rule selection");
        ui.err(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
    }

    ui.raw(`${pc.bold("switched on")}   ${result.enabled.join(", ") || "nothing"}`);
    ui.raw(`${pc.bold("switched off")}  ${result.disabled.join(", ") || "nothing"}`);
    ui.raw(pc.dim(hooksConfigPath()));

    if (result.enabled.length === 0 && result.disabled.length === 0) {
        ui.raw(pc.dim("already set like this; the config file was not touched"));
        return;
    }

    if (!result.written) {
        ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
    }
}
