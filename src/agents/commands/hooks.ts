import { existsSync, readFileSync, realpathSync } from "node:fs";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { detectShellViolations, ruleById, SHELL_RULES } from "@genesiscz/utils/shell/rules";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    DEFAULT_HOOKS_CONFIG,
    diffFor,
    type HarnessName,
    type HooksConfig,
    hooksConfigPath,
    lastConfigLoadError,
    lastConfigProblems,
    loadHooksConfig,
} from "../lib/hooks/config";
import { collectStaleCaptures, parseHorizon } from "../lib/hooks/gc";
import { type ImportResult, importGuardConfig } from "../lib/hooks/import-config";
import {
    claudeSettingsPath,
    hooksDistPath,
    INSTALL_MARKER,
    installAndPoint,
    readSettings,
    repoRoot,
    uninstallHooks,
} from "../lib/hooks/install";
import { resolveOutcome } from "../lib/hooks/outcome";
import { SETTABLE_KEYS, type SetResult, setHooksConfig } from "../lib/hooks/set-config";

const HARNESSES: readonly HarnessName[] = ["claude", "codex", "grok"];

function isHarness(value: string): value is HarnessName {
    return (HARNESSES as readonly string[]).includes(value);
}

/** Which harnesses render the diff, so a harness that is switched off is visible at a glance. */
function perHarnessDiff(config: HooksConfig): string {
    return HARNESSES.map((harness) => {
        const resolved = diffFor(config, harness);

        return `${harness} ${resolved.enabled ? "on" : pc.yellow("off")}`;
    }).join(" · ");
}

export function registerHooksCommands(program: Command): void {
    const hooks = program.command("hooks").description("Shell guard and diff watcher for any coding agent");
    const rules = hooks.command("rules").description("Inspect the shell rules");

    rules
        .command("list", { isDefault: true })
        .description("Every rule with its severity and kind")
        .option("--json", "Emit machine-readable JSON")
        .action((options: { json?: boolean }) => {
            if (options.json) {
                out.result(SHELL_RULES.map(({ id, kind, severity, title }) => ({ id, kind, severity, title })));
                return;
            }

            renderCliHeader("Shell rules", `${SHELL_RULES.length} registered`);

            const table = createBoxTable(["ID", "KIND", "SEVERITY", "TITLE"]);

            for (const rule of SHELL_RULES) {
                table.push([pc.white(rule.id), rule.kind, rule.severity, rule.title.slice(0, 60)]);
            }

            out.println(table.toString());
        });

    rules
        .command("explain")
        .description("Why one rule exists, with its wrong and right forms")
        .argument("<id>", "Rule id from `rules list`")
        .action((id: string) => {
            const rule = ruleById(id);

            if (!rule) {
                logger.error({ id }, "No such rule");
                process.exitCode = 1;
                return;
            }

            ui.raw(`${pc.bold(rule.id)} ${pc.dim(`${rule.kind} · ${rule.severity}`)}`);
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
        .action((command: string, options: { harness?: string; model?: string }) => {
            const given = options.harness;

            if (given !== undefined && !isHarness(given)) {
                out.println(
                    suggestEnumFlag("tools agents hooks rules test", "--harness", HARNESSES, {
                        subcommand: ["hooks", "rules", "test"],
                        given: String(given),
                    })
                );
                process.exitCode = 1;
                return;
            }

            const config = loadHooksConfig();
            const harness: HarnessName = given ?? "claude";
            const violations = detectShellViolations(command);

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

                ui.raw(`${pc.bold(violation.ruleId)} → ${outcome}`);

                for (const [layer, value] of trace) {
                    ui.raw(pc.dim(`    ${layer}: ${value}`));
                }
            }
        });

    hooks
        .command("doctor")
        .description("Is it wired, what is configured, what would fire")
        .action(() => {
            const config = loadHooksConfig();

            renderCliHeader("Agent hooks", hooksConfigPath());

            const table = createBoxTable(["SETTING", "VALUE"]);

            table.push(["guard.enabled", String(config.guard.enabled)]);
            table.push(["guard rules", String(SHELL_RULES.length)]);
            table.push([
                "longCommand",
                `${config.guard.longCommand.lines} lines / ${config.guard.longCommand.chars} chars`,
            ]);
            table.push(["contextCapPerSession", String(config.guard.contextCapPerSession)]);
            table.push(["diff.enabled", String(config.diff.enabled)]);
            table.push(["diff.maxFiles", String(config.diff.maxFiles)]);
            table.push(["diff.standDownWhenNative", String(config.diff.standDownWhenNative)]);
            table.push(["diff per harness", perHarnessDiff(config)]);
            table.push(["shadow", config.shadow ? "ON (decides, says nothing)" : "off (it speaks)"]);
            table.push(["log", config.logPath]);
            table.push(["log rotates at", `${config.maxLogMB} MB, keeping one generation`]);
            out.println(table.toString());

            const wired = existsSync(claudeSettingsPath())
                ? SafeJSON.stringify(readSettings()).includes(INSTALL_MARKER)
                : false;
            const dist = hooksDistPath();
            const distTarget = existsSync(dist) ? realpathSync(dist) : "not created";
            const wiring = createBoxTable(["WIRING", "VALUE"]);

            wiring.push(["settings.json", wired ? "installed" : "not installed"]);
            wiring.push(["dist symlink", dist]);
            wiring.push(["dist points at", distTarget]);
            out.println(wiring.toString());

            for (const problem of lastConfigProblems()) {
                ui.warn(problem);
            }

            const loadError = lastConfigLoadError() as NodeJS.ErrnoException | undefined;
            const isDefault = SafeJSON.stringify(config) === SafeJSON.stringify(DEFAULT_HOOKS_CONFIG);

            ui.raw("");

            if (loadError && loadError.code !== "ENOENT") {
                // A file that exists and cannot be read is exactly the state someone runs
                // `doctor` to diagnose, and it used to print as "no config file".
                ui.err(`${hooksConfigPath()} exists but could not be read: ${loadError.message}`);
                ui.raw(pc.dim("the built-in defaults are in effect until that is fixed"));
                return;
            }

            ui.raw(isDefault ? pc.dim("using built-in defaults, no config file") : pc.dim("config file in effect"));
        });

    hooks
        .command("install")
        .description("Wire the three hooks into Claude Code's ~/.claude/settings.json, additively")
        .option("--dist <path>", "Stable path the settings entries call (default: the agents dist symlink)")
        .option("--target <path>", "Checkout the dist symlink points at (default: this checkout)")
        .option("--write", "Actually write; without it this is a dry run")
        .action((options: { dist?: string; target?: string; write?: boolean }) => {
            const dist = options.dist ?? hooksDistPath();
            const target = options.target ?? repoRoot();
            // The symlink is only ours to manage when it IS ours. A `--dist` pointing
            // somewhere else is the caller's path, and silently repointing it would be a
            // surprise; it is reported instead.
            const managed = dist === hooksDistPath();
            const result = installAndPoint({ dist, target, write: Boolean(options.write) });

            ui.raw(`${pc.bold("dist")}       ${dist}${managed ? ` → ${target}` : pc.dim(" (yours, not repointed)")}`);
            ui.raw(`${pc.bold("added")}      ${result.added.join(", ") || "nothing"}`);
            ui.raw(`${pc.bold("updated")}    ${result.updated.join(", ") || "nothing"}`);
            ui.raw(`${pc.bold("unchanged")}  ${result.unchanged.join(", ") || "nothing"}`);

            if (result.backup) {
                ui.raw(`${pc.bold("backup")}     ${result.backup}`);
            }

            if (!result.changed) {
                ui.raw("");
                ui.raw(pc.dim("already wired exactly like this; the settings file was not touched"));
                return;
            }

            if (!options.write) {
                ui.raw("");
                ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
            }
        });

    hooks
        .command("uninstall")
        .description("Remove the entries this installer added")
        .option("--write", "Actually write; without it this is a dry run")
        .action((options: { write?: boolean }) => {
            const result = uninstallHooks({ write: Boolean(options.write) });

            ui.raw(`${pc.bold("entries")}   ${result.removed}`);

            if (!options.write) {
                ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
                return;
            }

            ui.raw(
                pc.dim("⚠️ Hook config is snapshotted at session start; a running session keeps calling the old path.")
            );
        });

    hooks
        .command("log")
        .description("Read the decision log")
        .option("--session <id>", "Only this session")
        .option("--decision <name>", "Only this decision: emitted, silent, skip, block, warn")
        .option("-n, --lines <count>", "How many records", "20")
        .action((options: { session?: string; decision?: string; lines?: string }) => {
            // `--lines abc` and `--lines 0` both sliced from 0, so they printed the whole log.
            const count = Number(options.lines ?? "20");

            if (!Number.isInteger(count) || count < 1) {
                ui.err(`--lines must be a positive integer, got ${options.lines}`);
                process.exitCode = 1;
                return;
            }

            const config = loadHooksConfig();
            const records: Record<string, unknown>[] = [];
            let skipped = 0;

            try {
                // Concurrent hook processes append to this file, so a torn or partial line is
                // a realistic state. One of them used to make the whole log unreadable, and
                // this reader is the only way to inspect a shadow run.
                for (const line of readFileSync(config.logPath, "utf8").split("\n")) {
                    if (line.length === 0) {
                        continue;
                    }

                    try {
                        records.push(SafeJSON.parse(line, { strict: true }) as Record<string, unknown>);
                    } catch {
                        skipped += 1;
                    }
                }
            } catch (err) {
                logger.error({ err, path: config.logPath }, "Cannot read the decision log");
                process.exitCode = 1;
                return;
            }

            const filtered = records
                .filter((record) => !options.session || record.session === options.session)
                .filter((record) => !options.decision || record.decision === options.decision)
                .slice(-count);

            if (skipped > 0) {
                ui.warn(`skipped ${skipped} unparseable line(s)`);
            }

            out.result(filtered);
        });

    hooks
        .command("gc")
        .description("Remove captures whose command is over")
        .option("--older-than <duration>", "Age horizon, e.g. 6h, 30m, 0s", "6h")
        .option("--session <id>", "Only this session, ignoring age")
        .option("--write", "Actually delete; without it this is a dry run")
        .action((options: { olderThan?: string; session?: string; write?: boolean }) => {
            let horizonMs: number;

            try {
                horizonMs = parseHorizon(options.olderThan ?? "6h");
            } catch (err) {
                logger.debug({ err, olderThan: options.olderThan }, "Rejected a gc horizon");
                ui.err(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
                return;
            }

            const result = collectStaleCaptures({
                now: Date.now(),
                horizonMs,
                sessionId: options.session,
                write: Boolean(options.write),
            });

            ui.raw(`${pc.bold("captures")}  ${result.removed.length} stale, ${result.kept} live`);
            ui.raw(`${pc.bold("bytes")}     ${result.bytes}`);

            if (!options.write) {
                ui.raw(pc.yellow("dry run: nothing was deleted. Pass --write to apply."));
            }
        });

    const config = hooks.command("config").description("Read, import and change the hooks config");

    config
        .command("show", { isDefault: true })
        .description("The config in effect, after defaults")
        .action(() => {
            out.result(loadHooksConfig());
        });

    config
        .command("path")
        .description("Where the config file lives")
        .action(() => {
            out.print(hooksConfigPath());
        });

    config
        .command("import")
        .description("Take the tuned overrides from the guard this port replaces")
        .option("--from <path>", "Legacy config (default: ~/.claude/hooks/bash-guard.config.json)")
        .option("--write", "Actually write; without it this is a dry run")
        .action((options: { from?: string; write?: boolean }) => {
            let result: ImportResult;

            try {
                result = importGuardConfig({ from: options.from, write: Boolean(options.write) });
            } catch (err) {
                logger.debug({ err, from: options.from }, "Legacy guard config could not be read");
                ui.err(`Config import failed: ${err instanceof Error ? err.message : String(err)}`);
                process.exitCode = 1;
                return;
            }

            ui.raw(`${pc.bold("from")}  ${result.from}`);
            ui.raw(`${pc.bold("to")}    ${result.to}`);
            out.result(result.config);

            if (!result.written) {
                ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
            }
        });

    config
        .command("set")
        .description("Change one setting, e.g. `shadow false` or `rules.find-from-root allow`")
        .argument("<key>", `One of: ${SETTABLE_KEYS.join(", ")}`)
        .argument("<value>", "The new value")
        .option("--write", "Actually write; without it this is a dry run")
        .action((key: string, value: string, options: { write?: boolean }) => {
            let result: SetResult;

            try {
                result = setHooksConfig(key, value, { write: Boolean(options.write) });
            } catch (err) {
                logger.debug({ err, key, value }, "Rejected a hooks config setting");
                ui.err(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
                return;
            }

            ui.raw(`${pc.bold(key)} → ${value}`);
            ui.raw(pc.dim(result.path));

            if (!result.written) {
                ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
            }
        });
}
