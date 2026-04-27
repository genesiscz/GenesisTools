import { captureProfile, getCmuxVersion, type SnapshotOptions } from "@app/cmux/lib/snapshot";
import { ProfileExistsError, ProfileStore } from "@app/cmux/lib/store";
import type { ProfileScope, Window } from "@app/cmux/lib/types";
import logger from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface SaveFlags {
    scope?: string;
    workspace?: string;
    window?: string;
    cwd?: boolean;
    screen?: boolean;
    history?: boolean;
    note?: string;
    force?: boolean;
}

export function registerSaveCommand(parent: Command): void {
    parent
        .command("save [name]")
        .description("Capture a cmux layout into a named profile (~/.genesis-tools/cmux/profiles/)")
        .option("-s, --scope <scope>", "all | window | workspace")
        .option("--workspace <ref>", "Target workspace (only with --scope workspace)")
        .option("--window <ref>", "Target window (only with --scope window)")
        .option("--no-cwd", "Skip per-pane cwd capture")
        .option(
            "--no-screen",
            "Skip per-pane visible-screen capture (default on: each terminal pane's rendered content is captured so restore can paint it back)",
        )
        .option(
            "--no-history",
            "Skip per-pane last-shell-command capture (default on: scrollback is parsed for the most recent shell prompt+command, e.g. `claude --resume <id>`, and that command is pre-typed at the new prompt on restore)",
        )
        .option("--note <text>", "Free-form note stored on the profile")
        .option("-f, --force", "Overwrite an existing profile of the same name")
        .action(async (name: string | undefined, flags: SaveFlags) => {
            await runSave(name, flags);
        });
}

async function runSave(rawName: string | undefined, flags: SaveFlags): Promise<void> {
    const interactive = isInteractive();
    let forceWrite = !!flags.force;

    const scope = await resolveScope(flags, interactive);
    rejectIncompatibleScopeFlags(scope, flags);
    const { captureCwd, captureScreen, captureHistory } = await resolveCaptureFlags(flags, interactive);
    const name = await resolveName(rawName, scope, interactive);

    const store = new ProfileStore();
    if (store.exists(name) && !forceWrite) {
        if (!interactive) {
            console.error(`Profile "${name}" already exists. Use --force to overwrite.`);
            console.error(suggestCommand("tools cmux profiles save", { add: ["--force"] }));
            process.exitCode = 1;
            return;
        }
        const overwrite = await withCancel(
            p.confirm({ message: `Profile "${name}" exists. Overwrite?`, initialValue: false })
        );
        if (!overwrite) {
            p.cancel("Save aborted.");
            return;
        }
        forceWrite = true;
    }

    p.intro(pc.bgCyan(pc.black(" cmux profiles save ")));

    const cmuxVersion = await getCmuxVersion();

    const options: SnapshotOptions = {
        name,
        scope,
        targetWindowRef: flags.window,
        targetWorkspaceRef: flags.workspace,
        captureCwd,
        captureScreen,
        captureHistory,
        note: flags.note,
        cmuxVersion,
    };

    const spinner = p.spinner();
    spinner.start("Capturing cmux state…");
    const startedAt = Date.now();

    try {
        const profile = await captureProfile(options, {
            onWorkspaceStart: ({ title, index, total }) => {
                spinner.message(`Capturing workspace ${index}/${total}: ${title}`);
            },
        });

        const path = store.write(name, profile, { force: forceWrite });
        spinner.stop(`Captured ${countWorkspaces(profile.windows)} workspace(s) in ${Date.now() - startedAt} ms`);

        const summary = store.summarize(profile);
        const lines = [
            `${pc.bold("name:")}      ${pc.cyan(summary.name)}`,
            `${pc.bold("scope:")}     ${summary.scope}`,
            `${pc.bold("counts:")}    ${summary.windows} window(s) · ${summary.workspaces} workspace(s) · ${summary.panes} pane(s) · ${summary.surfaces} surface(s)`,
            `${pc.bold("file:")}      ${pc.dim(path)}`,
        ];
        if (summary.note) {
            lines.push(`${pc.bold("note:")}      ${summary.note}`);
        }
        p.note(lines.join("\n"), "Profile saved");

        const restoreHint = `tools cmux profiles restore ${name}`;
        p.outro(`Restore later with ${pc.cyan(restoreHint)}`);
    } catch (error) {
        spinner.stop("Capture failed.");
        if (error instanceof ProfileExistsError) {
            p.cancel(error.message);
            process.exitCode = 1;
            return;
        }
        logger.error({ error }, "[cmux save] failed");
        throw error;
    }
}

async function resolveScope(flags: SaveFlags, interactive: boolean): Promise<ProfileScope> {
    if (flags.scope) {
        if (flags.scope !== "all" && flags.scope !== "window" && flags.scope !== "workspace") {
            throw new Error(`--scope must be one of all|window|workspace, got ${flags.scope}`);
        }
        return flags.scope;
    }
    if (!interactive) {
        console.error("Non-interactive mode requires --scope <all|window|workspace>.");
        console.error(suggestCommand("tools cmux profiles save", { add: ["--scope", "all"] }));
        process.exit(1);
    }
    const choice = await withCancel(
        p.select<ProfileScope>({
            message: "What should be saved?",
            options: [
                { value: "all", label: "All windows", hint: "every window, every workspace" },
                { value: "window", label: "Current window", hint: "all workspaces in this window" },
                { value: "workspace", label: "Current workspace only", hint: "just the focused workspace" },
            ],
            initialValue: "all",
        })
    );
    return choice;
}

interface CaptureFlags {
    captureCwd: boolean;
    captureScreen: boolean;
    captureHistory: boolean;
}

/**
 * After scope is picked, ask which per-pane data to capture: cwd, visible screen,
 * last shell command. CLI flags (`--no-cwd`/`--no-screen`/`--no-history`) win — they
 * skip the prompt and force-include in non-interactive mode. Otherwise default-on,
 * displayed as a multiselect so the user can deselect what they don't want.
 */
async function resolveCaptureFlags(flags: SaveFlags, interactive: boolean): Promise<CaptureFlags> {
    const flagOverrides: CaptureFlags = {
        captureCwd: flags.cwd !== false,
        captureScreen: flags.screen !== false,
        captureHistory: flags.history !== false,
    };
    const anyExplicitlyDisabled = flags.cwd === false || flags.screen === false || flags.history === false;
    if (!interactive || anyExplicitlyDisabled) {
        return flagOverrides;
    }

    type CaptureKey = "cwd" | "screen" | "history";
    const initial: CaptureKey[] = [];
    if (flagOverrides.captureCwd) {
        initial.push("cwd");
    }
    if (flagOverrides.captureScreen) {
        initial.push("screen");
    }
    if (flagOverrides.captureHistory) {
        initial.push("history");
    }

    const picked = await withCancel(
        p.multiselect<CaptureKey>({
            message: "What should be captured per pane?",
            options: [
                {
                    value: "cwd",
                    label: "Working directory",
                    hint: "from each pane's tab title — replays as `cd <path>` on restore",
                },
                {
                    value: "screen",
                    label: "Visible screen contents",
                    hint: "the saved scrollback is printed back into the new pane (monochrome)",
                },
                {
                    value: "history",
                    label: "Last shell command",
                    hint: "pre-typed (NOT auto-executed) at the new prompt — e.g. `claude --resume <id>`",
                },
            ],
            initialValues: initial,
            required: false,
        })
    );

    const set = new Set(picked);
    return {
        captureCwd: set.has("cwd"),
        captureScreen: set.has("screen"),
        captureHistory: set.has("history"),
    };
}

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateProfileName(input: string): string {
    const value = input.trim();
    if (!value) {
        throw new Error("Profile name cannot be empty");
    }
    if (!NAME_PATTERN.test(value)) {
        throw new Error("Profile name must only contain letters, digits, dots, underscores, or dashes");
    }
    return value;
}

async function resolveName(rawName: string | undefined, scope: ProfileScope, interactive: boolean): Promise<string> {
    if (rawName) {
        return validateProfileName(rawName);
    }
    if (!interactive) {
        console.error("Profile name required as the first positional argument in non-interactive mode.");
        console.error(suggestCommand("tools cmux profiles save", { add: ["<name>"] }));
        process.exit(1);
    }
    const value = await withCancel(
        p.text({
            message: "Profile name",
            placeholder: defaultName(scope),
            defaultValue: defaultName(scope),
            validate: (input) => {
                if (!input || !input.trim()) {
                    return "Name cannot be empty";
                }
                if (!NAME_PATTERN.test(input)) {
                    return "Use letters, digits, dots, underscores, or dashes only";
                }
                return undefined;
            },
        })
    );
    return validateProfileName(value);
}

function rejectIncompatibleScopeFlags(scope: ProfileScope, flags: SaveFlags): void {
    if (flags.window && flags.workspace) {
        throw new Error("Use only one of --window or --workspace, not both");
    }
    if (flags.window && scope !== "window") {
        throw new Error("--window requires --scope window");
    }
    if (flags.workspace && scope !== "workspace") {
        throw new Error("--workspace requires --scope workspace");
    }
}

function defaultName(scope: ProfileScope): string {
    if (scope === "all") {
        return "all";
    }
    if (scope === "window") {
        return "window";
    }
    return "workspace";
}

function countWorkspaces(windows: Window[]): number {
    let total = 0;
    for (const window of windows) {
        total += window.workspaces.length;
    }
    return total;
}
