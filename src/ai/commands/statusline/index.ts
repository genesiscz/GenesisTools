import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeCodeStatusline } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/statusline";
import { isolatedPreviewCache, type StatuslineCache } from "@genesiscz/utils/ai/statusline/cache";
import {
    formatStatuslineInstallCommand,
    isStatuslineInstallCommand,
    loadStatuslineConfig,
    PREVIEW_SESSION_ID,
    previewRenderConfig,
    rememberPreviousCommand,
    saveStatuslineConfig,
    statuslineConfigPath,
    statuslineInstalledHotEntryPath,
} from "@genesiscz/utils/ai/statusline/config";
import { renderStatusline } from "@genesiscz/utils/ai/statusline/render";
import type { StatuslineConfig, StatuslineFeature } from "@genesiscz/utils/ai/statusline/types";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { stripAnsi } from "@genesiscz/utils/string";
import type { Command } from "commander";
import { featureFor, runStatusline, type StatuslineHost } from "./run";

/**
 * `tools ai statusline`: the door onto the renderer in `@genesiscz/utils/ai/statusline`.
 *
 * `run` is the same code the host executes per render; the hot entry `run.ts` beside this file is
 * what `install` writes into the host's settings, because it skips this whole command tree.
 */
const RUN_ENTRY = join(import.meta.dir, "run.ts");

interface HostFlags {
    claude?: boolean;
    codex?: boolean;
    grok?: boolean;
}

function hostFrom(flags: HostFlags): StatuslineHost {
    if (flags.codex) {
        return "codex";
    }

    if (flags.grok) {
        return "grok";
    }

    return "claude";
}

function requireFeature(host: StatuslineHost): StatuslineFeature {
    const feature = featureFor(host);

    if (!feature) {
        throw new Error(`${host} has no statusline hook yet; only Claude Code renders one today`);
    }

    return feature;
}

/** Copy a trampoline to a stable data-dir path so host settings never point at a worktree. */
function writeHotEntryTrampoline(): string {
    const dest = statuslineInstalledHotEntryPath();
    mkdirSync(dirname(dest), { recursive: true });
    const sourceUrl = pathToFileURL(RUN_ENTRY).href;
    writeFileSync(
        dest,
        `#!/usr/bin/env bun\nconst { main } = await import(${SafeJSON.stringify(sourceUrl, { strict: true })});\nawait main(Bun.argv.slice(2));\n`
    );

    return dest;
}

/** The command `install` writes: the hot entry directly, or the ordinary door when asked. */
function installCommand(host: StatuslineHost, viaTools: boolean): string {
    return formatStatuslineInstallCommand({
        host,
        viaTools,
        bunPath: process.execPath,
        entryPath: statuslineInstalledHotEntryPath(),
    });
}

function isOurs(command: string | null): boolean {
    return isStatuslineInstallCommand(command);
}

/**
 * A payload for `preview` and the wizard: the newest transcript of this checkout's Claude Code
 * project, so model, session title and last-message time are real, with synthetic context usage.
 */
function samplePayload(cwd: string): Record<string, unknown> {
    const claudeDir = env.paths.getClaudeConfigDir() ?? join(homedir(), ".claude");
    const projectDir = join(claudeDir, "projects", cwd.replace(/\//g, "-"));
    let transcriptPath: string | null = null;

    if (existsSync(projectDir)) {
        let newest = 0;

        for (const name of readdirSync(projectDir)) {
            if (!name.endsWith(".jsonl")) {
                continue;
            }

            const path = join(projectDir, name);
            const mtime = statSync(path).mtimeMs;

            if (mtime > newest) {
                newest = mtime;
                transcriptPath = path;
            }
        }
    }

    return {
        workspace: { current_dir: cwd, project_dir: cwd },
        cwd,
        session_id: PREVIEW_SESSION_ID,
        transcript_path: transcriptPath,
        model: { display_name: "Claude" },
        context_window: {
            context_window_size: 200_000,
            current_usage: {
                input_tokens: 12_000,
                cache_creation_input_tokens: 3_000,
                cache_read_input_tokens: 41_000,
            },
        },
    };
}

async function previewLines(
    config: StatuslineConfig,
    feature: StatuslineFeature,
    columns: number,
    cache: StatuslineCache
): Promise<string[]> {
    const result = await renderStatusline(samplePayload(process.cwd()), {
        feature,
        config: previewRenderConfig(config),
        cache,
        columns,
    });

    return result.lines;
}

async function configureInteractively(host: StatuslineHost): Promise<void> {
    const feature = requireFeature(host);
    const previewCache = isolatedPreviewCache();
    const previewFeature = claudeCodeStatusline(previewCache);
    let config = await loadStatuslineConfig();
    const columns = process.stdout.columns ?? config.fallbackColumns;
    const showPreview = async () => {
        const lines = await previewLines(config, previewFeature, columns, previewCache);
        p.note(lines.join("\n") || "(nothing to show)", "preview");
    };

    p.intro(`${feature.host} statusline`);
    await showPreview();

    while (true) {
        const installed = await feature.readInstalledCommand();
        const choice = await p.select({
            message: "What do you want to change?",
            options: [
                { value: "toggles", label: "Segments", hint: "delta, session, account, git, graft line, metrics post" },
                { value: "gitTtl", label: "Git cache", hint: `${config.gitTtlMs} ms between git status calls` },
                {
                    value: "extends",
                    label: "Extend another statusline script",
                    hint: config.extends ? `${config.extends.position}: ${config.extends.command}` : "off",
                },
                { value: "preview", label: "Show the preview again" },
                {
                    value: "install",
                    label: isOurs(installed) ? "Installed: keep it" : "Install as the statusline command",
                    hint: installed ?? "nothing installed",
                },
                { value: "save", label: "Save and exit" },
                { value: "discard", label: "Exit without saving" },
            ],
        });

        if (p.isCancel(choice) || choice === "discard") {
            p.cancel("Nothing saved.");
            return;
        }

        if (choice === "save") {
            await saveStatuslineConfig(config);
            p.outro(`Saved ${statuslineConfigPath()}`);
            return;
        }

        if (choice === "toggles") {
            const picked = await p.multiselect({
                message: "Segments to show",
                options: [
                    { value: "showDelta", label: "Token delta since the last render" },
                    { value: "showSession", label: "Session title or id, and last message time" },
                    { value: "showAccount", label: "Account and cached usage" },
                    { value: "showGit", label: "Branch and dirty count" },
                    { value: "graft", label: "graft graph line (checkouts with a graph)" },
                    { value: "metricsPost", label: "Post the payload to the local metrics sink" },
                ],
                initialValues: [
                    ...(config.showDelta ? ["showDelta"] : []),
                    ...(config.showSession ? ["showSession"] : []),
                    ...(config.showAccount ? ["showAccount"] : []),
                    ...(config.showGit ? ["showGit"] : []),
                    ...(config.graft.enabled ? ["graft"] : []),
                    ...(config.metricsPost.enabled ? ["metricsPost"] : []),
                ],
            });

            if (p.isCancel(picked)) {
                continue;
            }

            const on = new Set(picked.map(String));
            config = {
                ...config,
                showDelta: on.has("showDelta"),
                showSession: on.has("showSession"),
                showAccount: on.has("showAccount"),
                showGit: on.has("showGit"),
                graft: { ...config.graft, enabled: on.has("graft") },
                metricsPost: { ...config.metricsPost, enabled: on.has("metricsPost") },
            };
            await showPreview();
            continue;
        }

        if (choice === "gitTtl") {
            const ms = await p.number({
                message: "Milliseconds between git status calls",
                initialValue: config.gitTtlMs,
            });

            if (!p.isCancel(ms)) {
                config = { ...config, gitTtlMs: Math.max(0, ms) };
            }

            continue;
        }

        if (choice === "extends") {
            const command = await p.text({
                message: "Command to run with the payload on stdin (empty to turn off)",
                initialValue: config.extends?.command ?? "",
            });

            if (p.isCancel(command)) {
                continue;
            }

            if (!command.trim()) {
                config = { ...config, extends: null };
                await showPreview();
                continue;
            }

            const position = await p.select({
                message: "Where do its lines go?",
                options: [
                    { value: "after", label: "After ours" },
                    { value: "before", label: "Before ours" },
                ],
            });

            if (p.isCancel(position)) {
                continue;
            }

            config = {
                ...config,
                extends: {
                    command: command.trim(),
                    position: position === "before" ? "before" : "after",
                    timeoutMs: 2_000,
                },
            };
            await showPreview();
            continue;
        }

        if (choice === "preview") {
            await showPreview();
            continue;
        }

        if (choice === "install") {
            const command = installCommand(host, false);
            const ok = await p.confirm({
                message: `Write "${command}" into ${feature.settingsPath()}? The current value is kept for uninstall.`,
                initialValue: false,
            });

            if (p.isCancel(ok) || !ok) {
                continue;
            }

            config = await installStatusline(host, false, config);
            p.note(`Installed. Run "tools ai statusline uninstall" to put the previous command back.`, "installed");
        }
    }
}

async function installStatusline(
    host: StatuslineHost,
    viaTools: boolean,
    existing?: StatuslineConfig
): Promise<StatuslineConfig> {
    const feature = requireFeature(host);
    let config = existing ?? (await loadStatuslineConfig());
    const current = await feature.readInstalledCommand();

    if (!viaTools) {
        writeHotEntryTrampoline();
    }

    const command = installCommand(host, viaTools);

    if (current === command) {
        out.log.info(`${feature.host} already runs ${command}`);
        return config;
    }

    config = rememberPreviousCommand(config, current, isOurs(current));
    await saveStatuslineConfig(config);
    await feature.writeInstalledCommand(command);
    out.log.success(`${feature.host} statusline is now ${command}`);
    logger.info({ host, command, previous: current }, "statusline installed");

    return config;
}

async function uninstallStatusline(host: StatuslineHost): Promise<void> {
    const feature = requireFeature(host);
    const config = await loadStatuslineConfig();
    const current = await feature.readInstalledCommand();

    if (!isOurs(current)) {
        out.log.info(`${feature.host} runs ${current ?? "no statusline"}, which is not ours; nothing to undo`);
        return;
    }

    await feature.writeInstalledCommand(config.previousCommand);
    await saveStatuslineConfig({ ...config, previousCommand: null });
    out.log.success(
        config.previousCommand
            ? `${feature.host} statusline restored to ${config.previousCommand}`
            : `${feature.host} statusline removed`
    );
}

async function showStatus(host: StatuslineHost): Promise<void> {
    const feature = requireFeature(host);
    const config = await loadStatuslineConfig();
    const installed = await feature.readInstalledCommand();
    out.println(`host:      ${feature.host}`);
    out.println(`settings:  ${feature.settingsPath()}`);
    out.println(`installed: ${installed ?? "(none)"}${isOurs(installed) ? "  (ours)" : ""}`);
    out.println(`previous:  ${config.previousCommand ?? "(none)"}`);
    out.println(`config:    ${statuslineConfigPath()}`);
    out.println(`hot entry: ${statuslineInstalledHotEntryPath()}`);
}

export function registerStatuslineCommands(program: Command): void {
    const statusline = program
        .command("statusline")
        .description("Render, preview, configure and install the coding-agent statusline");
    const addHostFlags = (command: Command) =>
        command
            .option("--claude", "Claude Code (default)")
            .option("--codex", "Codex (no statusline hook yet)")
            .option("--grok", "Grok (no statusline hook yet)");

    addHostFlags(
        statusline
            .command("run")
            .description("Render one statusline from the host payload on stdin (what the host runs per refresh)")
            .option("--stdin-file <path>", "read the payload from a file instead of stdin")
            .option("--columns <n>", "terminal width to pack into")
            .option("--timings", "print per-step timings to stderr")
    ).action(async (opts: HostFlags & { stdinFile?: string; columns?: string; timings?: boolean }) => {
        const columns = opts.columns === undefined ? undefined : Number.parseInt(opts.columns, 10);
        const { lines } = await runStatusline({
            host: hostFrom(opts),
            ...(opts.stdinFile === undefined ? {} : { stdinFile: opts.stdinFile }),
            ...(columns === undefined || Number.isNaN(columns) ? {} : { columns }),
            timings: opts.timings === true,
        });
        out.print(lines.join("\n"));
        await out.flush();
    });

    addHostFlags(
        statusline
            .command("preview")
            .description("Render a sample from this checkout's newest transcript, with synthetic context usage")
            .option("--plain", "strip colours")
            .option("--json", "print the lines and timings as JSON")
    ).action(async (opts: HostFlags & { plain?: boolean; json?: boolean }) => {
        const host = hostFrom(opts);
        const previewCache = isolatedPreviewCache();
        const feature = featureFor(host, previewCache);

        if (!feature) {
            throw new Error(`${host} has no statusline hook yet; only Claude Code renders one today`);
        }

        const config = await loadStatuslineConfig();
        const result = await renderStatusline(samplePayload(process.cwd()), {
            feature,
            config: previewRenderConfig(config),
            cache: previewCache,
        });
        const lines = opts.plain ? result.lines.map(stripAnsi) : result.lines;

        if (opts.json) {
            out.result(SafeJSON.stringify({ lines: lines, timings: result.timings }, { strict: true }));
            return;
        }

        out.print(lines.join("\n"));
    });

    addHostFlags(statusline.command("configure").description("Interactive setup with a live preview")).action(
        async (opts: HostFlags) => {
            if (!isInteractive()) {
                logger.error("configure needs a terminal");
                logger.info(suggestCommand("tools ai statusline", { replaceCommand: ["install"] }));
                process.exitCode = 1;
                return;
            }

            await configureInteractively(hostFrom(opts));
        }
    );

    addHostFlags(
        statusline
            .command("install")
            .description("Make the host run this statusline; the previous command is kept for uninstall")
            .option("--via-tools", "install the `tools ai statusline run` form instead of the direct entry")
    ).action(async (opts: HostFlags & { viaTools?: boolean }) => {
        await installStatusline(hostFrom(opts), opts.viaTools === true);
    });

    addHostFlags(statusline.command("uninstall").description("Put the previous statusline command back")).action(
        async (opts: HostFlags) => {
            await uninstallStatusline(hostFrom(opts));
        }
    );

    addHostFlags(statusline.command("status").description("What the host runs now, and where the config lives")).action(
        async (opts: HostFlags) => {
            await showStatus(hostFrom(opts));
        }
    );
}
