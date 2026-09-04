import { prepareProfileForRestore } from "@app/cmux/lib/agent-replay";
import { readAutosaveSession, readPreviousAutosaveSession } from "@app/cmux/lib/autosave";
import { renderProfileCommandDetail, renderProfileTree } from "@app/cmux/lib/format";
import { buildOfflineProfile } from "@app/cmux/lib/offline-snapshot";
import { buildPlan, type RestoreOptions, reportWaitingPrompts, restoreProfile } from "@app/cmux/lib/restore";
import {
    ALL_RESTORE_AGENTS,
    filterReplayByAgents,
    isMissingEnumFlag,
    parseAgentList,
    parseRestoreSource,
    type RestoreRestartSource,
} from "@app/cmux/lib/restore-after-restart";
import { captureProfile, getCmuxVersion } from "@app/cmux/lib/snapshot";
import { ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";
import type { Profile } from "@app/cmux/lib/types";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ensureCmuxResponsive } from "@genesiscz/utils/cmux/lib/health";
import { logger, out } from "@genesiscz/utils/logger";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
import type { Command } from "commander";
import pc from "picocolors";

interface RestartFlags {
    source?: string | true;
    profile?: string;
    agents?: string | true;
    enter?: boolean;
    replay?: boolean;
    prefix?: string;
    list?: boolean;
    dryRun?: boolean;
    yes?: boolean;
}

const SOURCES: RestoreRestartSource[] = ["previous", "live", "profile"];

async function captureLiveProfile(): Promise<Profile> {
    try {
        return await captureProfile({
            name: "restart-live",
            scope: "all",
            captureCwd: true,
            captureScreen: true,
            captureHistory: true,
            note: "live capture for restore-after-restart",
            cmuxVersion: await getCmuxVersion(),
        });
    } catch (error) {
        logger.warn({ error }, "[restore-after-restart] live capture failed, using current autosave");
        const session = readAutosaveSession();
        return buildOfflineProfile(
            session,
            { ttyCommands: new Map(), surfaceSessions: new Map() },
            { name: "restart-live", note: "autosave fallback for restore-after-restart" }
        );
    }
}

function capturePreviousProfile(): Profile {
    const session = readPreviousAutosaveSession();
    return buildOfflineProfile(
        session,
        { ttyCommands: new Map(), surfaceSessions: new Map() },
        { name: "restart-previous", note: "previous autosave (pre-restart)" }
    );
}

async function resolveSource(
    flags: RestartFlags
): Promise<{ source: RestoreRestartSource; profileName?: string } | undefined> {
    const sourceRaw = typeof flags.source === "string" ? flags.source : undefined;
    let source = parseRestoreSource(sourceRaw);
    if (!source) {
        if (!isInteractive()) {
            out.error(
                suggestEnumFlag("tools cmux restore-after-restart", "--source", SOURCES, {
                    given: isMissingEnumFlag(flags.source) ? undefined : sourceRaw,
                })
            );
            process.exitCode = 1;
            return undefined;
        }

        source = await withCancel(
            p.select({
                message: "Restore from which layout?",
                options: [
                    { value: "previous", label: "previous autosave (what cmux had before last launch)" },
                    { value: "live", label: "live cmux (current panes)" },
                    { value: "profile", label: "a named saved profile" },
                ],
                initialValue: "previous",
            })
        );
    }

    if (source !== "profile") {
        return { source };
    }

    let profileName = flags.profile?.trim();
    if (!profileName) {
        if (!isInteractive()) {
            out.error(
                `--source profile needs --profile <name>. ${suggestCommand("tools cmux restore-after-restart --source profile --profile crash-20260902-1238")}`
            );
            process.exitCode = 1;
            return undefined;
        }

        const names = new ProfileStore().list().map((row) => row.name);
        if (names.length === 0) {
            throw new Error("No saved profiles.");
        }

        profileName = await withCancel(
            p.select({
                message: "Which profile?",
                options: names.map((name) => ({ value: name, label: name })),
            })
        );
    }

    return { source, profileName };
}

async function loadProfile(source: RestoreRestartSource, profileName?: string): Promise<Profile> {
    if (source === "previous") {
        return capturePreviousProfile();
    }

    if (source === "live") {
        return captureLiveProfile();
    }

    const store = new ProfileStore();
    try {
        return store.read(profileName ?? "");
    } catch (error) {
        if (error instanceof ProfileNotFoundError) {
            throw new Error(error.message);
        }

        throw error;
    }
}

export function registerRestoreAfterRestartCommand(program: Command): void {
    program
        .command("restore-after-restart")
        .description(
            "Restore cmux panes after a restart: previous autosave, live capture, or a named profile, with Claude/Grok/Codex resume inference"
        )
        .option("--source [source]", "previous | live | profile")
        .option("--profile <name>", "Named profile (with --source profile)")
        .option("--agents [list]", "Comma list: claude,grok,codex (default all)")
        .option("--enter", "Press Enter after typing each resume command")
        .option("--no-replay", "Only cd into cwd, do not type resume commands")
        .option("--prefix <str>", "Workspace name prefix (default restart-)")
        .option("--list", "Print the layout and inferred commands, then exit")
        .option("--dry-run", "Print the restore plan without modifying cmux")
        .option("-y, --yes", "Do not ask for confirmation")
        .action(async (flags: RestartFlags) => {
            await runRestoreAfterRestart(flags);
        });
}

async function runRestoreAfterRestart(flags: RestartFlags): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" cmux restore-after-restart ")));

    const resolved = await resolveSource(flags);
    if (!resolved) {
        return;
    }
    const { source, profileName } = resolved;
    if (isMissingEnumFlag(flags.agents)) {
        if (!isInteractive()) {
            out.error(suggestEnumFlag("tools cmux restore-after-restart", "--agents", ALL_RESTORE_AGENTS));
            process.exitCode = 1;
            return;
        }
        flags.agents = undefined;
    }

    let agents = [...ALL_RESTORE_AGENTS];
    if (typeof flags.agents === "string") {
        try {
            agents = parseAgentList(flags.agents);
        } catch {
            out.error(
                suggestEnumFlag("tools cmux restore-after-restart", "--agents", ALL_RESTORE_AGENTS, {
                    given: flags.agents,
                })
            );
            process.exitCode = 1;
            return;
        }
    }

    if (isInteractive() && !flags.agents && !flags.yes && !flags.list && !flags.dryRun) {
        agents = await withCancel(
            p.multiselect({
                message: "Which agents should get resume commands?",
                options: [
                    { value: "claude", label: "Claude Code" },
                    { value: "grok", label: "Grok" },
                    { value: "codex", label: "Codex" },
                ],
                initialValues: ["claude", "grok", "codex"],
                required: true,
            })
        );
    }

    let enter = Boolean(flags.enter);
    if (isInteractive() && flags.enter === undefined && !flags.yes && !flags.list && !flags.dryRun) {
        enter = await withCancel(p.confirm({ message: "Execute resume commands now (--enter)?", initialValue: false }));
    }

    const raw = await loadProfile(source, profileName);
    const inferred = filterReplayByAgents(await prepareProfileForRestore(raw), agents);

    if (flags.list) {
        out.println(renderProfileTree(inferred));
        const detail = renderProfileCommandDetail(inferred);
        if (detail.length > 0) {
            p.note(detail.join("\n"), "Panes · commands · drift");
        }
        p.outro(pc.dim("List only — nothing changed."));
        return;
    }

    const opts: RestoreOptions = {
        prefix: flags.prefix !== undefined ? flags.prefix : "restart-",
        replay: flags.replay !== false,
        enter: enter && flags.replay !== false,
        yes: Boolean(flags.yes),
        dryRun: Boolean(flags.dryRun),
    };

    const plan = buildPlan(inferred, opts);
    const planLines = plan.workspaces.map(
        (ws) => `  ${pc.cyan(ws.targetTitle)} ${pc.dim(`(${ws.paneCount} pane(s), ${ws.surfaceCount} surface(s))`)}`
    );
    p.note(
        planLines.join("\n") || "(empty profile)",
        `Restore plan (${source}${profileName ? `: ${profileName}` : ""})`
    );
    const detail = renderProfileCommandDetail(inferred);
    if (detail.length > 0) {
        p.note(detail.join("\n"), "Panes · commands · drift");
    }

    if (opts.dryRun) {
        p.outro(pc.dim("Dry run — nothing changed."));
        return;
    }

    if (!opts.yes) {
        if (!isInteractive()) {
            out.error(
                `Pass --yes to skip confirmation. ${suggestCommand("tools cmux restore-after-restart --source previous --yes")}`
            );
            process.exitCode = 1;
            return;
        }

        const proceed = await withCancel(
            p.confirm({ message: `Create ${plan.workspaces.length} workspace(s)?`, initialValue: true })
        );
        if (!proceed) {
            p.cancel("Aborted.");
            return;
        }
    }

    await ensureCmuxResponsive("restore-after-restart");
    const spinner = p.spinner();
    spinner.start("Recreating workspaces…");
    const startedAt = Date.now();

    try {
        const outcome = await restoreProfile(inferred, opts, {
            onWorkspaceStart: ({ title, index, total }) => {
                spinner.message(`Restoring ${index}/${total}: ${title}`);
            },
        });
        spinner.stop(`Restored ${outcome.workspaces.length} workspace(s) in ${Date.now() - startedAt} ms`);
        p.outro(pc.green("Done."));
        if (opts.enter) {
            await reportWaitingPrompts(
                outcome.workspaces.map((w) => w.ref),
                "Restore"
            );
        }
    } catch (error) {
        spinner.stop("Restore failed.");
        logger.error({ error }, "[restore-after-restart] failed");
        throw error;
    }
}
