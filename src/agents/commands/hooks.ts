import { existsSync, readFileSync, realpathSync } from "node:fs";
import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { SHELL_RULES } from "@genesiscz/utils/shell/rules";
import type { ShellRule } from "@genesiscz/utils/shell/rules/types";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type CodexWiring,
    codexHooksPath,
    codexWiring,
    installCodexHooks,
    uninstallCodexHooks,
} from "../lib/hooks/codex";
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
import { type CustomRules, loadRuleSet } from "../lib/hooks/custom-rules";
import { collectStaleCaptures, parseHorizon } from "../lib/hooks/gc";
import { lastSeenPerHarness } from "../lib/hooks/harnesses";
import { hooksFileListsOldDefaults, recordInstallState } from "../lib/hooks/hooks-file";
import {
    claudeSettingsPath,
    hooksDistPath,
    type InstallResult,
    installAndPoint,
    repoRoot,
    uninstallHooks,
    wiringStatus,
} from "../lib/hooks/install";
import { SETTABLE_KEYS, type SetResult, setHooksConfig } from "../lib/hooks/set-config";
import { registerRuleCommands, registerRulePicker, ruleState, shortPath } from "./hooks-rules";

const HARNESSES: readonly HarnessName[] = ["claude", "codex", "grok"];
/** Grok has no hook file of its own: it runs the hooks in Claude's settings.json. */
const INSTALLABLE = ["claude", "codex"] as const;

type InstallableHarness = (typeof INSTALLABLE)[number];

/** `--harness` for install and uninstall: the value, or `null` after printing the choices. */
function installableHarness(given: string | boolean | undefined, verb: string): InstallableHarness | null {
    if (given === undefined) {
        return "claude";
    }

    const harness = INSTALLABLE.find((name) => name === given);

    if (harness) {
        return harness;
    }

    out.println(
        suggestEnumFlag(`tools agents hooks ${verb}`, "--harness", INSTALLABLE, {
            subcommand: ["hooks", verb],
            given: given === true ? undefined : String(given),
        })
    );
    process.exitCode = 1;

    return null;
}

function printInstallResult(result: InstallResult, write: boolean, file: string): void {
    ui.raw(`${pc.bold("added")}      ${result.added.join(", ") || "nothing"}`);
    ui.raw(`${pc.bold("updated")}    ${result.updated.join(", ") || "nothing"}`);
    ui.raw(`${pc.bold("unchanged")}  ${result.unchanged.join(", ") || "nothing"}`);

    if (result.removed.length > 0) {
        ui.raw(`${pc.bold("removed")}    ${result.removed.join(", ")}`);
    }

    if (result.backup) {
        ui.raw(`${pc.bold("backup")}     ${result.backup}`);
    }

    if (!result.changed) {
        ui.raw("");
        ui.raw(pc.dim(`already wired exactly like this; ${file} was not touched`));
        return;
    }

    if (!write) {
        ui.raw("");
        ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
    }
}

/** Rules switched off for every harness, and rules only some harnesses allow. */
function ruleOverrides(config: HooksConfig, rules: readonly ShellRule[]): { off: string; perHarness: string } {
    const states = rules.map((rule) => ({ id: rule.id, state: ruleState(config, rule.id) }));

    return {
        off: states
            .filter((rule) => rule.state === "off")
            .map((rule) => rule.id)
            .join(", "),
        perHarness: states
            .filter((rule) => rule.state.startsWith("on ("))
            .map((rule) => `${rule.id} ${rule.state.slice(3)}`)
            .join(", "),
    };
}

function seenLabel(at: string | undefined): string {
    return at ? new Date(at).toLocaleString("sv-SE") : pc.yellow("not in the newest records");
}

function codexLabel(codex: CodexWiring): string {
    if (codex.error) {
        return pc.red(`${shortPath(codex.path)} unreadable: ${codex.error}`);
    }

    if (codex.state === "missing") {
        return pc.yellow(`${shortPath(codex.path)}: not installed, so Codex has no shell guard`);
    }

    const trust = codex.trust
        .map((entry) => `${entry.event} ${entry.recorded ? "trust recorded" : pc.yellow("not trusted yet")}`)
        .join(", ");

    return `${shortPath(codex.path)}: ${codex.state === "stale" ? pc.yellow(`stale (${codex.events.join(", ")} differ)`) : "installed"}; ${trust}`;
}

/** The custom-rule modules, one row each, with every failure named. */
function printCustomRules(config: HooksConfig, custom: CustomRules | null): void {
    if (config.guard.customRules.length === 0) {
        ui.raw(
            pc.dim(
                `custom rules: none configured. Add a folder: ${suggestCommand("tools agents", { replaceCommand: ["hooks", "config", "set", "guard.customRules", "<folder>", "--write"] })}`
            )
        );
        return;
    }

    const table = createBoxTable(["CUSTOM RULES", "STATE", "RULES OR REASON"]);

    for (const entry of custom?.missing ?? []) {
        table.push([entry.source, pc.red("missing"), entry.reason]);
    }

    for (const module of custom?.modules ?? []) {
        table.push([
            shortPath(module.file),
            module.status === "loaded" ? pc.green("loaded") : pc.red("failed"),
            module.status === "loaded" ? module.ruleIds.join(", ") || pc.dim("no rules") : (module.reason ?? ""),
        ]);

        for (const refused of module.refused) {
            table.push(["", pc.yellow(`refused ${refused.id}`), refused.reason]);
        }
    }

    out.println(table.toString());
    ui.raw(pc.dim(`guard.customRules: ${config.guard.customRules.join(", ")}`));
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
    registerRuleCommands(hooks);

    hooks
        .command("doctor")
        .description("Is it wired for each harness, what is configured, which custom rules loaded")
        .action(async () => {
            const config = loadHooksConfig();
            const set = await loadRuleSet(config);

            renderCliHeader("Agent hooks", hooksConfigPath());

            const table = createBoxTable(["SETTING", "VALUE"]);

            table.push(["guard.enabled", String(config.guard.enabled)]);
            table.push([
                "guard rules",
                `${SHELL_RULES.length} built-in, ${set.rules.length - SHELL_RULES.length} custom`,
            ]);
            const overrides = ruleOverrides(config, set.rules);

            table.push(["rules switched off", overrides.off || "none"]);
            table.push(["rules allowed per harness", overrides.perHarness || "none"]);
            table.push([
                "longCommand",
                `${config.guard.longCommand.lines} lines / ${config.guard.longCommand.chars} chars`,
            ]);
            table.push(["contextCapPerSession", String(config.guard.contextCapPerSession)]);
            table.push(["diff.enabled", String(config.diff.enabled)]);
            table.push(["diff.maxFiles", String(config.diff.maxFiles)]);
            table.push(["diff.standDownWhenNative", String(config.diff.standDownWhenNative)]);
            table.push(["diff per harness", perHarnessDiff(config)]);
            table.push(["agentsTalk.hint", String(config.agentsTalk.hint)]);
            table.push(["shadow", config.shadow ? "ON (decides, says nothing)" : "off (it speaks)"]);
            table.push(["log", config.logPath]);
            table.push(["log rotates at", `${config.maxLogMB} MB, keeping one generation`]);
            out.println(table.toString());

            printCustomRules(config, set.custom);

            const wired = wiringStatus();
            const codex = codexWiring();
            const seen = lastSeenPerHarness(config.logPath);
            const dist = hooksDistPath();
            const distTarget = existsSync(dist) ? realpathSync(dist) : "not created";
            const wiring = createBoxTable(["HARNESS", "WIRING", "LAST DECISION IN THE LOG"]);

            wiring.push([
                "claude",
                `${shortPath(claudeSettingsPath())}: ${
                    wired.state === "stale"
                        ? pc.yellow(`stale (${wired.events.join(", ")} differ)`)
                        : wired.state === "installed"
                          ? "installed"
                          : pc.yellow("not installed")
                }`,
                seenLabel(seen.claude),
            ]);
            wiring.push(["codex", codexLabel(codex), seenLabel(seen.codex)]);
            wiring.push([
                "grok",
                `no file of its own: Grok runs the hooks in ${shortPath(claudeSettingsPath())}`,
                seenLabel(seen.grok),
            ]);
            out.println(wiring.toString());
            ui.raw(`${pc.bold("dist symlink")}  ${dist} → ${distTarget}`);

            if (wired.state === "stale") {
                ui.warn(
                    `settings.json holds an older wiring of these hooks. Fix: ${suggestCommand("tools agents", { replaceCommand: ["hooks", "install", "--write"] })}`
                );
            }

            if (codex.state !== "installed") {
                ui.warn(
                    `Codex has no ${codex.state === "stale" ? "current " : ""}shell guard of ours. Fix: ${suggestCommand("tools agents", { replaceCommand: ["hooks", "install", "--harness", "codex", "--write"] })}`
                );
            } else if (codex.trust.some((entry) => !entry.recorded)) {
                ui.warn(
                    "Codex has not trusted every hook of ours yet. It asks at its next interactive start; until then it does not run them."
                );
            }

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

            if (hooksFileListsOldDefaults(hooksConfigPath())) {
                // The newer defaults already apply to every setting the user did not change; only
                // the values the file SHOWS are older. Read-only here: the fix is a write.
                ui.warn(
                    `the file lists older defaults (the newer ones already apply). Refresh it: ${suggestCommand("tools agents", { replaceCommand: ["hooks", "install", "--write"] })}`
                );
            }
        });

    hooks
        .command("install")
        .description(
            "Wire the hooks into a harness, additively. Claude: ~/.claude/settings.json; the decision hub's Stop and UserPromptSubmit hooks are wired only while decisions.stopHook, decisions.harvest or decisions.injectAnswers is on. Codex: <CODEX_HOME>/hooks.json (the guard, plus the Bash diff while it is on for Codex). Grok runs Claude's hooks"
        )
        .option("--harness [name]", "claude (default) or codex")
        .option("--dist <path>", "Stable path the entries call (default: the agents dist symlink)")
        .option("--target <path>", "Claude only: checkout the dist symlink points at (default: this checkout)")
        .option("--write", "Actually write; without it this is a dry run")
        .action((options: { harness?: string | boolean; dist?: string; target?: string; write?: boolean }) => {
            const harness = installableHarness(options.harness, "install");

            if (!harness) {
                return;
            }

            const dist = options.dist ?? hooksDistPath();

            if (harness === "codex") {
                const result = installCodexHooks({ dist, write: Boolean(options.write) });

                ui.raw(`${pc.bold("file")}       ${codexHooksPath()}`);
                printInstallResult(result, Boolean(options.write), "the hooks file");

                if (result.changed && options.write) {
                    ui.raw(
                        pc.dim(
                            "Codex trusts each hook by its position and content: it asks to review a new or changed one at its next interactive start, and does not run it before that."
                        )
                    );
                }

                return;
            }

            const target = options.target ?? repoRoot();
            // The symlink is only ours to manage when it IS ours. A `--dist` pointing
            // somewhere else is the caller's path, and silently repointing it would be a
            // surprise; it is reported instead.
            const managed = dist === hooksDistPath();
            const result = installAndPoint({ dist, target, write: Boolean(options.write) });

            ui.raw(`${pc.bold("dist")}       ${dist}${managed ? ` → ${target}` : pc.dim(" (yours, not repointed)")}`);

            if (options.write) {
                // Also when nothing changed: the file then gains every setting and the record.
                recordInstallState({ dist, target: managed ? target : null });
            }

            printInstallResult(result, Boolean(options.write), "the settings file");

            if (options.write) {
                ui.raw(`${pc.bold("config")}     ${hooksConfigPath()} (every setting, plus what was installed)`);
            }
        });

    hooks
        .command("uninstall")
        .description("Remove the entries this installer added")
        .option("--harness [name]", "claude (default) or codex")
        .option("--write", "Actually write; without it this is a dry run")
        .action((options: { harness?: string | boolean; write?: boolean }) => {
            const harness = installableHarness(options.harness, "uninstall");

            if (!harness) {
                return;
            }

            const result =
                harness === "codex"
                    ? uninstallCodexHooks({ write: Boolean(options.write) })
                    : uninstallHooks({ write: Boolean(options.write) });

            ui.raw(`${pc.bold("entries")}   ${result.removed}`);

            if (!options.write) {
                ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
                return;
            }

            if (harness === "claude") {
                recordInstallState({ dist: hooksDistPath(), target: null });
                ui.raw(`${pc.bold("recorded")}  ${hooksConfigPath()}`);
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

    const config = hooks.command("config").description("Read and change the hooks config");

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

    registerRulePicker(config);

    config
        .command("set")
        .description("Change one setting, e.g. `shadow false` or `rules.find-from-root allow`")
        .argument("<key>", `One of: ${SETTABLE_KEYS.join(", ")}`)
        .argument("<value>", "The new value")
        .option("--write", "Actually write; without it this is a dry run")
        .action(async (key: string, value: string, options: { write?: boolean }) => {
            let result: SetResult;
            // A rule key may name a custom rule, so the custom modules are loaded first.
            const set = await loadRuleSet(loadHooksConfig());

            try {
                result = setHooksConfig(key, value, {
                    write: Boolean(options.write),
                    ruleIds: new Set(set.rules.map((rule) => rule.id)),
                });
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
