import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
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
import { findFullDiff, fullDiffDir } from "../lib/hooks/diff/full";
import { decisionCounts, extendFromTranscripts, formatEntry, readDiffLog } from "../lib/hooks/diff-log";
import { collectStaleCaptures, parseHorizon } from "../lib/hooks/gc";
import { lastSeenPerHarness } from "../lib/hooks/harnesses";
import { hooksFileListsOldDefaults, recordInstallState } from "../lib/hooks/hooks-file";
import {
    claudeSettingsPath,
    hooksDistPath,
    type InstallResult,
    installAndPoint,
    readSettings,
    repoRoot,
    type SubagentLinePlan,
    uninstallHooks,
    wireSubagentLine,
    wiringStatus,
} from "../lib/hooks/install";
import {
    claudePlugin,
    claudeUserSettingsPath,
    MOD_SWITCHES,
    MODS_PLUGIN,
    MODS_SCOPES,
    type ModsScope,
    modSwitchKeys,
    modsPluginState,
    modsWatchState,
    PLUGIN_DIRS_VAR,
    pluginDirsOf,
    withModsWatch,
} from "../lib/hooks/mods";
import { nativeDiffForced, nativeDiffState, setNativeDiff } from "../lib/hooks/native-diff";
import { SETTABLE_KEYS, type SetResult, setHooksConfig } from "../lib/hooks/set-config";
import { writeJsonFile } from "../lib/hooks/write-json";
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

    if (result.subagentLine === "theirs" || result.subagentLine === "replaced" || result.subagentLine === "restored") {
        ui.raw(`${pc.bold("subagentStatusLine")} ${subagentLineSaid(result.subagentLine, write)}`);
    }

    if (result.nativeDiff === "turned-off") {
        ui.raw(
            `${pc.bold("native")}     Claude Code's own Bash diff ${write ? "turned off" : "would be turned off"} (bashEditDiffEnabled: false): the hook draws every Bash diff`
        );
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

/** Claude Code's own Bash diff, as `doctor` reports it; loud while it duplicates and misattributes. */
function nativeDiffLabel(config: HooksConfig): string {
    const state = nativeDiffState();

    if (state === "off" && nativeDiffForced() === "1") {
        return pc.red(
            "🛑 off in settings, but CLAUDE_CODE_BASH_EDIT_DIFF=1 in this environment turns it on for sessions started here"
        );
    }

    if (state === "off") {
        return config.shadow
            ? "off, and shadow is on: neither diff is shown until shadow is off"
            : "off: the hook draws every Bash diff";
    }

    if (config.shadow) {
        return `${state} (shadow on: the hook prints nothing, so Claude Code's diff stays)`;
    }

    if (!config.diff.replaceNative) {
        return `${state} (diff.replaceNative false: the hook stands down per file)`;
    }

    return pc.red(
        `🛑 ${state === "on" ? "ON" : "ON (default)"}: it shows other sessions' edits. Fix: ${toolCommand("agents hooks native-diff off", "--write")}`
    );
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
            table.push(["native Bash diff", nativeDiffLabel(config)]);
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
        .option(
            "--replace-subagent-line",
            "Claude only: while mods.agentRow is on, replace a subagentStatusLine of someone else's (uninstall puts it back)"
        )
        .option("--write", "Actually write; without it this is a dry run")
        .action(
            (options: {
                harness?: string | boolean;
                dist?: string;
                target?: string;
                write?: boolean;
                replaceSubagentLine?: boolean;
            }) => {
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
                const result = installAndPoint({
                    dist,
                    target,
                    write: Boolean(options.write),
                    replaceSubagentLine: Boolean(options.replaceSubagentLine),
                });

                ui.raw(
                    `${pc.bold("dist")}       ${dist}${managed ? ` → ${target}` : pc.dim(" (yours, not repointed)")}`
                );

                if (options.write) {
                    // Also when nothing changed: the file then gains every setting and the record.
                    recordInstallState({ dist, target: managed ? target : null });
                }

                printInstallResult(result, Boolean(options.write), "the settings file");

                if (options.write) {
                    ui.raw(`${pc.bold("config")}     ${hooksConfigPath()} (every setting, plus what was installed)`);
                }
            }
        );

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
        .command("native-diff [state]")
        .description(
            "Claude Code's own Bash diff (bashEditDiffEnabled): status, off or on. It has no attribution and shows other sessions' edits, so the hook replaces it"
        )
        .option("--write", "Actually change ~/.claude/settings.json; without it this is a dry run")
        .action((state: string | undefined, options: { write?: boolean }) => {
            const wanted = state ?? "status";

            if (wanted === "status") {
                const now = nativeDiffState();
                ui.raw(`Claude Code's own Bash diff: ${now === "off" ? pc.green("off") : pc.red(now)}`);

                if (nativeDiffForced() === "1") {
                    ui.raw(
                        pc.yellow(
                            `🛑 CLAUDE_CODE_BASH_EDIT_DIFF=1 is set here, and it wins over the setting: a session started from this environment shows it anyway. Unset it, or start sessions with ${toolCommand("claude start")}.`
                        )
                    );
                }

                if (now !== "off") {
                    ui.raw(
                        pc.yellow(
                            `🛑 It shows other sessions' edits. Run: ${toolCommand("agents hooks native-diff off", "--write")}`
                        )
                    );
                }

                return;
            }

            if (wanted !== "off" && wanted !== "on") {
                ui.err(`native-diff takes status, off or on, not ${wanted}`);
                process.exitCode = 1;
                return;
            }

            const result = setNativeDiff({ enabled: wanted === "on", write: Boolean(options.write) });

            if (!result.changed) {
                ui.raw(pc.dim(`already ${result.after}; ${claudeSettingsPath()} was not touched`));
                return;
            }

            ui.raw(`Claude Code's own Bash diff: ${result.before} -> ${result.after}`);

            if (result.backup) {
                ui.raw(`${pc.bold("backup")} ${result.backup}`);
            }

            if (!options.write) {
                ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
            }
        });

    registerMods(hooks);

    const diffCommand = hooks.command("diff").description("The Bash diff hook");

    diffCommand
        .command("show <call>")
        .description("Print the full diff a cut message linked, by tool call id or a prefix of it")
        .action((call: string) => {
            const path = findFullDiff(call);

            if (!path) {
                ui.err(`no full diff for ${call} in ${fullDiffDir()}: only a message that had to cut lines writes one`);
                process.exitCode = 1;
                return;
            }

            out.println(readFileSync(path, "utf8"));
        });

    diffCommand
        .command("log")
        .description(
            "What the diff hook decided per Bash call, told against the call: --extended reads the transcript for the command, what the message showed, and Claude Code's own diff"
        )
        .option("--session <id>", "Only this session (a prefix is enough)")
        .option("--since <duration>", "How far back, e.g. 30m, 6h, 2d", "24h")
        .option(
            "--decision <list>",
            "Comma list of emitted, noted, failed, silent, skip; `all` for every one",
            "emitted,noted,failed"
        )
        .option("-n, --lines <count>", "At most this many calls, the newest", "50")
        .option("--extended", "Join each call with its Claude transcript")
        .option("--full-command", "Print each command whole, in a fence (implies --extended, which reads the command)")
        .option("--json", "The entries as JSON")
        .action(
            (options: {
                session?: string;
                since?: string;
                decision?: string;
                lines?: string;
                extended?: boolean;
                fullCommand?: boolean;
                json?: boolean;
            }) => {
                const count = Number(options.lines ?? "50");
                let horizonMs: number;

                try {
                    horizonMs = parseHorizon(options.since ?? "24h");
                } catch (err) {
                    logger.debug({ err, since: options.since }, "Rejected a diff log horizon");
                    ui.err(`--since takes a duration like 30m, 6h or 2d, not ${options.since}`);
                    process.exitCode = 1;
                    return;
                }

                if (!Number.isInteger(count) || count < 1) {
                    ui.err(`--lines must be a positive integer, got ${options.lines}`);
                    process.exitCode = 1;
                    return;
                }

                const wanted = new Set((options.decision ?? "").split(",").map((name) => name.trim()));
                const all = readDiffLog({
                    logPath: loadHooksConfig().logPath,
                    since: Date.now() - horizonMs,
                    session: options.session,
                });
                const entries = all.filter((entry) => wanted.has("all") || wanted.has(entry.decision)).slice(-count);

                // The command comes from the transcript, so asking for it whole is asking for --extended.
                const extended = options.extended === true || options.fullCommand === true;

                if (extended) {
                    extendFromTranscripts(entries);
                }

                if (options.json) {
                    out.result(entries);
                    return;
                }

                const colours = pc.createColors(process.stdout.isTTY === true);

                for (const entry of entries) {
                    const lines = formatEntry(entry, {
                        extended,
                        fullCommand: options.fullCommand === true,
                        colours,
                    });

                    out.println(lines.join("\n"));
                    out.println("");
                }

                const totals = [...decisionCounts(all)].map(([decision, total]) => `${decision} ${total}`).join(", ");
                out.println(
                    pc.dim(
                        `${entries.length} shown of ${all.length} calls in the last ${options.since ?? "24h"}: ${totals}`
                    )
                );
            }
        );

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

/**
 * `hooks mods`: the Claude Code mods of this repository (the `genesis-tools-mods` plugin). They share the
 * hooks file: `mods.diff.fullDiff` switches the full-diff mod, which reads the diff hook's `hook-diffs` notes, and
 * `mods.idleCompact` the idle-compaction mod.
 */
function registerMods(hooks: Command): void {
    const mods = hooks
        .command("mods")
        .description(
            `Claude Code mods (${MODS_PLUGIN}): status, enable, disable, install, uninstall. Settings: mods.* in the hooks config`
        );

    mods.command("status", { isDefault: true })
        .description("Whether the mods plugin is installed and enabled, and what the hooks config sets for it")
        .action(() => {
            const list = claudePlugin(["list", "--json"]);

            if (!list.ok) {
                ui.err(`claude plugin list failed: ${list.stderr.trim() || list.stdout.trim()}`);
                process.exitCode = 1;
                return;
            }

            const state = modsPluginState(list.stdout);
            const config = loadHooksConfig();
            const fullDiff = diffFor(config, "claude").fullDiff;

            ui.raw(
                `${pc.bold(MODS_PLUGIN)}: ${state.installed ? (state.enabled ? pc.green("installed, enabled") : pc.yellow("installed, disabled")) : pc.red("not installed")}`
            );

            if (state.installed) {
                ui.raw(
                    pc.dim(
                        `  scope ${state.scope ?? "?"} · version ${state.version ?? "?"} · read from ${state.readFrom ?? "its install copy"}`
                    )
                );
            }

            const onOff = (on: boolean) => (on ? pc.green("on") : pc.dim("off"));
            const mods = config.mods;
            const rows: [string, boolean, string][] = [
                ["mods.diff.fullDiff", mods.diff.fullDiff, ""],
                ["mods.diff.collapseGitSync", mods.diff.collapseGitSync, ""],
                [
                    "mods.idleCompact",
                    mods.idleCompact.enabled,
                    `after ${mods.idleCompact.minutes} min · floor ${mods.idleCompact.minTokens} tokens`,
                ],
                ["mods.agentModel", mods.agentModel.enabled, `format ${mods.agentModel.format}`],
                ["mods.agentRow", mods.agentRow.enabled, `agents panel rows · format ${mods.agentRow.format}`],
                [
                    "mods.decisions",
                    mods.decisions.enabled,
                    `chip ${mods.decisions.chip} · open ${mods.decisions.expand}`,
                ],
                ["mods.inbox", mods.inbox.enabled, `chip ${mods.inbox.chip} · open ${mods.inbox.expand}`],
                ["mods.links", mods.links.enabled, ""],
                [
                    "mods.git",
                    mods.git.enabled,
                    `labels ${mods.git.labels} · up to ${mods.git.checkouts} checkouts · own folder ${mods.git.cwd} · open ${mods.git.expand} · names ${mods.git.name} · earlier work ${mods.git.earlier}`,
                ],
                ["mods.askRow", mods.askRow.enabled, ""],
                ["mods.spinner", mods.spinner.enabled, ""],
                [
                    "mods.cacheBand",
                    mods.cacheBand.enabled,
                    `yellow under ${mods.cacheBand.cautionMinutes} min · red under ${mods.cacheBand.warnMinutes} min · others ${mods.cacheBand.others ? "on" : "off"}`,
                ],
                ["mods.tmpUsage", mods.tmpUsage.enabled, `every ${mods.tmpUsage.minutes} min`],
                ["mods.agentsBand", mods.agentsBand.enabled, `red past ${mods.agentsBand.warnMinutes} min`],
                ["mods.hooks.tokens", mods.hooks.tokens, ""],
                ["mods.hooks.dedupe", mods.hooks.dedupe, ""],
                [
                    "mods.sidebar.hints",
                    mods.sidebar.hints,
                    `feedback ${mods.sidebar.feedback} · takes the keys ${mods.sidebar.focus === "command" ? "when a command opens it" : mods.sidebar.focus}`,
                ],
                [
                    "mods.stall",
                    mods.stall.enabled,
                    mods.stall.action === "auto"
                        ? `continues by itself after ${mods.stall.minutes} min`
                        : "a continue button",
                ],
            ];

            for (const [name, on, detail] of rows) {
                ui.raw(`${name}: ${onOff(on)}${detail ? pc.dim(` · ${detail}`) : ""}`);
            }

            if (mods.diff.fullDiff && fullDiff === "off") {
                ui.raw(pc.yellow(`diff.fullDiff is off, so no call has a full-diff note for the mod to draw.`));
            }

            const settingsPath = claudeUserSettingsPath();
            const watched = modsWatchState(settingsPath);
            const hotReload =
                watched === undefined
                    ? pc.yellow(`unknown (${settingsPath} could not be read)`)
                    : watched
                      ? pc.green(`on (${PLUGIN_DIRS_VAR} in the settings env)`)
                      : pc.dim(`off: ${toolCommand("agents hooks mods watch", "--write")}`);

            ui.raw(`hot reload: ${hotReload}`);

            if (!state.installed && watched === false) {
                ui.raw(`Install: ${toolCommand("agents hooks mods install", "--write")}`);
            }
        });

    mods.command("watch")
        .description(
            `Load the mods from this checkout in every new session and reload them on each save (${PLUGIN_DIRS_VAR} in the Claude settings env)`
        )
        .option("--off", "Stop: take the folder out of the settings env")
        .option("--write", "Actually change the settings; without it this is a dry run")
        .action((options: { off?: boolean; write?: boolean }) => {
            const path = claudeUserSettingsPath();
            const folder = join(repoRoot(), "plugins", "genesis-tools-mods");
            const before = readSettings(path);
            const after = withModsWatch(before, folder, !options.off);
            const changed = SafeJSON.stringify(after) !== SafeJSON.stringify(before);

            ui.raw(`${PLUGIN_DIRS_VAR}: ${pluginDirsOf(after).join(", ") || "(unset)"}`);

            if (!changed) {
                ui.raw(pc.dim(`${path} already says so.`));
                return;
            }

            if (!options.write) {
                ui.raw(pc.yellow(`dry run: ${path} was not changed. Pass --write to apply.`));
                return;
            }

            writeJsonFile(path, after);
            ui.raw(pc.green(`wrote ${path}`));
            ui.raw(
                pc.dim(
                    "A session started from now on loads the folder and reloads the mod on each save. A running session keeps what it loaded until it restarts."
                )
            );
        });

    for (const on of [true, false]) {
        const verb = on ? "enable" : "disable";

        mods.command(verb)
            .description(`Turn mods ${on ? "on" : "off"} by name, or all: ${Object.keys(MOD_SWITCHES).join(", ")}`)
            .argument("[names...]", "The mods to switch")
            .option(
                "--replace-subagent-line",
                "agentRow: replace a subagentStatusLine of someone else's; disable puts it back"
            )
            .option("--write", "Actually write; without it this is a dry run")
            .action((names: string[], options: { write?: boolean; replaceSubagentLine?: boolean }) => {
                switchMods({
                    names,
                    on,
                    write: Boolean(options.write),
                    replaceSubagentLine: Boolean(options.replaceSubagentLine),
                });
            });
    }

    mods.command("install")
        .description("Install the mods plugin from this repository's marketplace")
        .option("--scope <scope>", `Where Claude Code records it: ${MODS_SCOPES.join(", ")}`, "user")
        .option("--write", "Actually install; without it this is a dry run")
        .action((options: { scope: string; write?: boolean }) => {
            const scope = MODS_SCOPES.find((candidate): candidate is ModsScope => candidate === options.scope);

            if (!scope) {
                ui.raw(suggestEnumFlag("tools agents hooks mods install", "--scope", MODS_SCOPES));
                process.exitCode = 1;
                return;
            }

            runPluginCommand({ args: ["install", MODS_PLUGIN, "--scope", scope], write: Boolean(options.write) });
        });

    mods.command("uninstall")
        .description("Uninstall the mods plugin")
        .option("--write", "Actually uninstall; without it this is a dry run")
        .action((options: { write?: boolean }) => {
            runPluginCommand({ args: ["uninstall", MODS_PLUGIN], write: Boolean(options.write) });
        });
}

/** What happened to `subagentStatusLine`, for `mods enable|disable agentRow` and `install`. */
function subagentLineSaid(plan: SubagentLinePlan, write: boolean): string {
    const will = (done: string, planned: string): string => (write ? done : planned);
    const held = readSettings().subagentStatusLine;
    const command =
        typeof held === "object" && held !== null && "command" in held
            ? String(held.command)
            : SafeJSON.stringify(held);
    const said: Record<SubagentLinePlan, string> = {
        added: will("wired", "would be wired"),
        updated: will("rewired", "would be rewired"),
        replaced: will(
            "replaced; the command it held is kept and comes back on disable",
            "would replace the command it holds, keeping it for disable to restore"
        ),
        removed: will("removed", "would be removed"),
        restored: will("back to the command it held before", "would go back to the command it held before"),
        unchanged: "already wired",
        absent: "not ours, nothing to do",
        theirs: `holds another command (${command}), so the agents panel rows stay the engine's. Replace it (kept, and restored on disable): ${suggestCommand("tools agents", { replaceCommand: ["hooks", "mods", "enable", "agentRow", "--replace-subagent-line", "--write"] })}`,
    };

    return said[plan];
}

/** `hooks mods enable|disable <names...>`: one `config set` per switch key of the named mods. */
function switchMods({
    names,
    on,
    write,
    replaceSubagentLine,
}: {
    names: string[];
    on: boolean;
    write: boolean;
    replaceSubagentLine?: boolean;
}): void {
    const { keys, unknown } = modSwitchKeys(names);
    const verb = on ? "enable" : "disable";

    if (names.length === 0 || unknown.length > 0) {
        if (unknown.length > 0) {
            ui.err(`No such mod: ${unknown.join(", ")}`);
        }

        ui.raw(`Mods: all, ${Object.keys(MOD_SWITCHES).join(", ")}`);
        ui.raw(
            suggestCommand("tools agents", { replaceCommand: ["hooks", "mods", verb, "git", "agentsBand", "--write"] })
        );
        process.exitCode = 1;
        return;
    }

    for (const key of keys) {
        try {
            setHooksConfig(key, String(on), { write });
        } catch (err) {
            logger.debug({ err, key }, "Rejected a mods switch");
            ui.err(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
            return;
        }

        ui.raw(`${pc.bold(key)} → ${on}`);
    }

    ui.raw(pc.dim(hooksConfigPath()));

    if (keys.includes("mods.agentRow.enabled")) {
        // The agents panel rows are Claude Code's `subagentStatusLine`, a setting of its own, not a hook of the plugin.
        const plan = wireSubagentLine({ on, write, replace: replaceSubagentLine });

        ui.raw(`${pc.bold("subagentStatusLine")} ${subagentLineSaid(plan, write)} ${pc.dim(claudeSettingsPath())}`);
    }

    if (!write) {
        ui.raw(pc.yellow("dry run: nothing was written. Pass --write to apply."));
        return;
    }

    ui.raw(pc.dim("A running session reads the change at its next turn; a band redraws on its next refresh."));
}

function runPluginCommand({ args, write }: { args: string[]; write: boolean }): void {
    const shown = `claude plugin ${args.join(" ")}`;

    if (!write) {
        ui.raw(`would run: ${shown}`);
        ui.raw(pc.yellow("dry run: nothing was changed. Pass --write to apply."));
        return;
    }

    const run = claudePlugin(args);
    const said = `${run.stdout}${run.stderr}`.trim();

    if (!run.ok) {
        ui.err(`${shown} failed${said ? `: ${said}` : ""}`);
        process.exitCode = 1;
        return;
    }

    ui.raw(said || `${shown}: done`);
    ui.raw(
        pc.dim("A running Claude Code session picks it up after /reload-plugins; a new session loads it by itself.")
    );
}
