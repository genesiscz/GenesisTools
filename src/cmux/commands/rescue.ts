import { renderProfileCommandDetail } from "@app/cmux/lib/format";
import { captureOfflineProfile } from "@app/cmux/lib/offline-snapshot";
import {
    cleanRelaunchEnv,
    collectReplayEntries,
    killApp,
    mayReplayIntoSurface,
    type ReplayEntry,
} from "@app/cmux/lib/rescue";
import { scanForInteractivePrompts } from "@app/cmux/lib/restore";
import { ProfileExistsError, ProfileStore } from "@app/cmux/lib/store";
import type { Profile } from "@app/cmux/lib/types";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { probeCmuxHealth } from "@genesiscz/utils/cmux/lib/health";
import { paneList, workspaceList } from "@genesiscz/utils/cmux/lib/socket";
import { logger, out } from "@genesiscz/utils/logger";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * Guided recovery from a cmux UI-thread livelock: offline capture → confirmed
 * kill → CLEAN-ENV relaunch → wait for the app's own session reopen → replay each
 * pane's launch command into the reopened surfaces. The app restores the layout
 * itself, so no duplicate workspace is created.
 *
 * Interaction policy (t9): the only automation is typing each command + Enter.
 * Whatever appears afterwards (account-headroom gate, resume-mode dialog, session
 * picker) is reported, never answered.
 */

interface RescueFlags {
    yes?: boolean;
    dryRun?: boolean;
}

export interface RescueDeps {
    /** Injected so a test can spy on the irreversible call and make it throw. */
    killApp: typeof killApp;
}

const defaultDeps: RescueDeps = { killApp };

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
    const profile = await captureOfflineProfile({ name, note: `rescue capture (cmux was ${health.state})` });

    const detail = renderProfileCommandDetail(profile);
    if (detail.length > 0) {
        p.note(detail.join("\n"), "Commands that will be replayed (with drift)");
    }

    const steps = [
        `  1. kill -TERM ${health.appPid ?? "<cmux pid>"} (escalate to -KILL after 5 s)`,
        "  2. relaunch with a CLEAN env: env -i HOME USER PATH /usr/bin/open -a cmux",
        "  3. wait for the socket to be healthy and the app to reopen its own workspaces",
        "  4. type each pane's command + Enter into the reopened surfaces (order-matched, title-checked)",
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
    } else {
        p.log.warn("No running cmux app found — skipping the kill step.");
    }

    p.log.step("Relaunching cmux with a clean environment…");
    await cleanRelaunch();

    const ready = await waitForHealthy(60_000);
    if (!ready) {
        throw new Error("cmux did not become healthy within 60 s after relaunch — check the app manually.");
    }

    // Give the app a moment to finish reopening its autosaved workspaces.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const entries = collectReplayEntries(profile);
    const workspaceRefs = await replayIntoReopenedSurfaces(profile, entries);

    await new Promise((resolve) => setTimeout(resolve, 4000));
    const waiting = await scanForInteractivePrompts(workspaceRefs).catch(() => []);
    if (waiting.length > 0) {
        const lines = waiting.map((w) => `  ${pc.yellow("⚠")} ${w.workspaceRef} ${w.surfaceRef} — ${w.prompt}`);
        lines.push(pc.dim("  Rescue does not auto-confirm these; answer each pane yourself."));
        p.note(lines.join("\n"), "Panes waiting for you");
    } else {
        p.log.info("No panes are waiting at an interactive prompt.");
    }

    p.outro(pc.green("Rescue complete."));
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

interface LiveSurfaceEntry {
    ref: string;
    title?: string;
    index: number;
}

interface ListPaneSurfacesResponse {
    surfaces: LiveSurfaceEntry[];
}

/**
 * Type each captured command into the matching reopened surface. Surfaces are
 * matched positionally per workspace (the reopen recreates the autosave order —
 * the same order the offline profile was built from) and cross-checked by title;
 * a count mismatch aborts instead of typing into the wrong pane.
 */
async function replayIntoReopenedSurfaces(profile: Profile, entries: ReplayEntry[]): Promise<string[]> {
    const live = await workspaceList();
    const workspaceRefs: string[] = [];
    // cmux titles derive from directories/branches, so two workspaces can share a
    // title — an already-claimed live workspace must never match a second saved one.
    const claimed = new Set<string>();
    const profileWorkspaces = profile.windows.flatMap((w) => w.workspaces);

    for (let wsIndex = 0; wsIndex < profileWorkspaces.length; wsIndex += 1) {
        const saved = profileWorkspaces[wsIndex];
        const positional = live.workspaces[wsIndex];
        const liveWs =
            live.workspaces.find((ws) => !claimed.has(ws.ref) && ws.title === saved.title) ??
            (positional && !claimed.has(positional.ref) ? positional : undefined);
        if (!liveWs) {
            p.log.warn(`No reopened workspace matches "${saved.title}" — skipped.`);
            continue;
        }

        claimed.add(liveWs.ref);
        workspaceRefs.push(liveWs.ref);
        const wsEntries = entries.filter((e) => e.workspaceIndex === wsIndex);

        const liveSurfaces: LiveSurfaceEntry[] = [];
        const layout = await paneList(liveWs.ref);
        for (const pane of layout.panes) {
            const response = await runCmuxJSON<ListPaneSurfacesResponse>([
                "list-pane-surfaces",
                "--workspace",
                liveWs.ref,
                "--pane",
                pane.ref,
            ]);
            liveSurfaces.push(...[...response.surfaces].sort((a, b) => a.index - b.index));
        }

        if (liveSurfaces.length !== wsEntries.length) {
            p.log.error(
                `Workspace "${saved.title}": ${liveSurfaces.length} reopened surface(s) vs ${wsEntries.length} saved — refusing to type into a mismatched layout.`
            );
            continue;
        }

        let sent = 0;
        let skipped = 0;
        for (let i = 0; i < wsEntries.length; i += 1) {
            const entry = wsEntries[i];
            const target = liveSurfaces[i];
            if (!entry.command) {
                continue;
            }

            // The contract says surfaces are title-checked, and equal surface
            // COUNTS do not prove the panes still correspond. Replaying by
            // position into a renamed surface types a captured command into a
            // different terminal than the reviewed plan showed, so a real
            // mismatch refuses this surface exactly as a count mismatch does.
            const titleMatches = mayReplayIntoSurface(entry, target);
            if (!titleMatches) {
                logger.debug(
                    { saved: entry.title, live: target.title, surface: target.ref },
                    "[rescue] title mismatch — refusing to type into this surface"
                );
                p.log.warn(
                    `  skipped ${target.ref}: saved "${entry.title}" but the reopened surface is "${target.title}".`
                );
                skipped += 1;
                continue;
            }

            await runCmuxOk(["send", "--workspace", liveWs.ref, "--surface", target.ref, `${entry.command}\n`]);
            sent += 1;
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        p.log.info(
            `Workspace "${saved.title}": replayed ${sent} command(s) into ${wsEntries.length} surface(s)${skipped ? `, skipped ${skipped} on a title mismatch` : ""}.`
        );
    }

    return workspaceRefs;
}
