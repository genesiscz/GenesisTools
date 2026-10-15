import { prepareProfileForRestore } from "@app/cmux/lib/agent-replay";
import { renderProfileCommandDetail } from "@app/cmux/lib/format";
import { captureOfflineProfile } from "@app/cmux/lib/offline-snapshot";
import { cleanRelaunchEnv, killApp } from "@app/cmux/lib/rescue";
import { reportWaitingPrompts } from "@app/cmux/lib/restore";
import { planInPlaceSettled, renderInPlaceStep, runInPlaceRestore } from "@app/cmux/lib/restore-in-place";
import { ProfileExistsError, ProfileStore } from "@app/cmux/lib/store";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { probeCmuxHealth } from "@genesiscz/utils/cmux/lib/health";
import { out } from "@genesiscz/utils/logger";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * Guided recovery from a cmux UI-thread livelock: offline capture → confirmed
 * kill → CLEAN-ENV relaunch → wait for the app's own session reopen → the
 * `--in-place` restore of `restore-after-restart` into the reopened tabs. The app
 * restores the layout itself, so no duplicate workspace is created, and cmux keeps
 * every surface UUID across the relaunch, so each tab is paired by its UUID.
 *
 * Interaction policy (t9): the only automation is typing each command + Enter,
 * into an idle shell tab, on recorded evidence. Whatever appears afterwards
 * (account-headroom gate, resume-mode dialog, session picker) is reported, never
 * answered.
 */

interface RescueFlags {
    yes?: boolean;
    dryRun?: boolean;
}

export interface RescueDeps {
    /** Injected so a test can spy on the irreversible call and make it throw. */
    killApp: typeof killApp;
    /** Same reason: `open -a cmux` must never fire from a test run. */
    relaunch: () => Promise<void>;
}

const defaultDeps: RescueDeps = { killApp, relaunch: cleanRelaunch };

export function registerRescueCommand(parent: Command): void {
    parent
        .command("rescue [name]")
        .description(
            "Recover from a livelocked cmux: offline profile save, confirmed kill, clean-env relaunch, replay of each pane's command into the reopened surfaces"
        )
        .option("-y, --yes", "Do not ask for confirmation before killing cmux")
        .option("--dry-run", "Print the full plan (steps + per-pane commands and drift) without touching anything")
        .action(async (name: string | undefined, flags: RescueFlags) => {
            await runRescue(name ?? "rescue", flags);
        });
}

export async function runRescue(name: string, flags: RescueFlags, deps: RescueDeps = defaultDeps): Promise<void> {
    p.intro(pc.bgRed(pc.white(" cmux rescue ")));

    const health = await probeCmuxHealth({ full: true, identifyTimeoutMs: 5000 });
    p.log.info(
        `cmux state: ${pc.bold(health.state)}${health.appPid ? ` (pid ${health.appPid}, ${health.appCpu}% CPU)` : ""}`
    );

    if (health.state === "healthy") {
        p.log.warn("cmux looks healthy — rescue will still kill and relaunch it if you continue.");
    }

    p.log.step("Capturing offline profile (autosave + process table)…");
    // The same preparation the restore applies: title inference, one tab per session, no model pins.
    const profile = await prepareProfileForRestore(
        await captureOfflineProfile({ name, note: `rescue capture (cmux was ${health.state})` })
    );

    const detail = renderProfileCommandDetail(profile);
    if (detail.length > 0) {
        p.note(detail.join("\n"), "Commands that will be replayed (with drift)");
    }

    const steps = [
        `  1. kill -TERM ${health.appPid ?? "<cmux pid>"} (escalate to -KILL after 5 s)`,
        "  2. relaunch with a CLEAN env: env -i HOME USER PATH /usr/bin/open -a cmux",
        "  3. wait for the socket to be healthy and the app to reopen its own workspaces",
        "  4. restore in place: each tab's resume or command + Enter into the reopened tab with the same surface UUID (idle shell tabs only, on recorded evidence)",
        "  5. report panes stopped at interactive prompts — rescue never answers them",
    ];
    p.note(steps.join("\n"), "Plan");

    if (flags.dryRun) {
        p.outro(pc.dim("Dry run — nothing changed."));
        return;
    }

    // Persist the capture BEFORE the kill (and before the confirm, so an abort
    // still leaves it recoverable). Never clobber an existing profile: `name` is
    // user-supplied and may collide with a hand-curated save.
    const store = new ProfileStore();
    let profilePath: string;

    try {
        profilePath = store.write(name, profile);
    } catch (error) {
        if (!(error instanceof ProfileExistsError)) {
            throw error;
        }

        const stamped = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        p.log.warn(`Profile "${name}" already exists — saving as "${stamped}" instead.`);
        profilePath = store.write(stamped, profile);
    }

    p.log.info(`Profile saved: ${pc.dim(profilePath)}`);

    if (!flags.yes) {
        if (!isInteractive()) {
            out.error(
                `Pass --yes to confirm the kill in non-interactive mode. ${suggestCommand(`tools cmux rescue ${name} --yes`)}`
            );
            process.exitCode = 1;
            return;
        }
        const proceed = await withCancel(
            p.confirm({ message: "Kill cmux and run the rescue now?", initialValue: false })
        );
        if (!proceed) {
            p.cancel("Aborted — the offline profile stays saved.");
            return;
        }
    }

    if (health.appPid) {
        const outcome = await deps.killApp(health.appPid, { onStep: (message) => p.log.step(message) });
        p.log.info(
            `Sent ${outcome.signals.join(" then ") || "no signal"}; cmux ${outcome.exited ? "exited" : "may still be alive"}.`
        );

        // Relaunching now would `open -a cmux` onto the STILL-RUNNING app, the
        // health wait below would pass against that old instance, and replay
        // would type every captured command into the livelocked surfaces. The
        // profile is already on disk, so stopping here costs nothing.
        if (!outcome.exited) {
            throw new Error(
                `cmux (pid ${health.appPid}) did not terminate — refusing to relaunch or replay into it. Quit the app yourself, then re-run the rescue. The profile is saved at ${profilePath}.`
            );
        }
    } else {
        p.log.warn("No running cmux app found — skipping the kill step.");
    }

    p.log.step("Relaunching cmux with a clean environment…");
    await deps.relaunch();

    const ready = await waitForHealthy(60_000);
    if (!ready) {
        throw new Error("cmux did not become healthy within 60 s after relaunch — check the app manually.");
    }

    // Give the app a moment to finish reopening its autosaved workspaces.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const tabs = await planInPlaceSettled(profile);
    p.note(tabs.map(renderInPlaceStep).join("\n") || "(no terminal tabs)", "In-place plan (reopened tabs)");
    // A rescue runs what each pane ran (an ssh logs back in), as it always did; the plan already holds back every
    // tab that is busy, unreadable, or has no evidence for its session.
    const failures = await runInPlaceRestore(tabs, { enter: true, replay: true, runCommands: true });

    if (failures.length > 0) {
        process.exitCode = 1;
        p.note(failures.join("\n"), "Tabs not resumed");
    }

    const workspaceIds = tabs.flatMap((step) =>
        !step.skip && step.live ? [step.live.workspaceId ?? step.live.workspaceRef] : []
    );
    await reportWaitingPrompts([...new Set(workspaceIds)], "Rescue");

    p.outro(
        failures.length > 0 ? pc.yellow("Rescue finished; some tabs were not resumed.") : pc.green("Rescue complete.")
    );
}

async function cleanRelaunch(): Promise<void> {
    const proc = Bun.spawn(["/usr/bin/open", "-a", "cmux"], {
        env: cleanRelaunchEnv(),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
    });
    const code = await proc.exited;

    if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Relaunch failed (open exit ${code}): ${stderr.trim()}`);
    }
}

async function waitForHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const health = await probeCmuxHealth({ pingTimeoutMs: 1000, identifyTimeoutMs: 2500 });
        if (health.state === "healthy") {
            return true;
        }
    }

    return false;
}
