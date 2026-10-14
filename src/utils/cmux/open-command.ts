import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { type CmuxPlace, identifyCmux } from "@genesiscz/utils/cmux/lib/place";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import {
    createWorkspaceWithName,
    openSplitInWorkspace,
    openSurfaceInPane,
    pickAnchorSurface,
    renameSurfaceTab,
} from "@genesiscz/utils/cmux/workspace";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

const log = logger.child({ component: "claude:cmux-open" });

/**
 * Where a command opens, at one level of the cmux hierarchy:
 *
 * - window    → new workspace in that window
 * - workspace → new pane (split) in that workspace
 * - pane      → new surface (tab) in that pane
 * - surface   → type the command into that surface as-is
 *
 * Every id is the cmux UUID: cmux renumbers `window:N`, `workspace:N`, `pane:N` and `surface:N`
 * at each relaunch. A ref a human typed on the command line still works, since cmux takes both.
 */
export type OpenSessionTarget =
    | { kind: "window"; windowId: string }
    | { kind: "workspace"; workspaceId: string }
    | { kind: "pane"; workspaceId: string; paneId: string }
    | { kind: "surface"; workspaceId: string; surfaceId: string };

export interface OpenCommandOptions {
    /** One shell line, typed into the terminal. */
    command: string;
    target: OpenSessionTarget;
    /** Tab title for a surface created here; an existing surface keeps its own. */
    title: string;
    /** Name and folder of a workspace created for a `window` target. */
    workspaceName?: string;
    cwd?: string;
    /** Press Enter after typing. Default true. */
    enter?: boolean;
}

/** Workspace and surface UUIDs of the terminal a command was opened in. */
export interface OpenedPlace {
    workspaceId: string;
    surfaceId: string;
}

/**
 * Opens a terminal at `target` (a new workspace, split or tab, or an existing surface), names its
 * tab, types `command` and raises the window. Resuming a session and `tools cmux launch --open`
 * both go through here.
 */
export async function openCommandAt(options: OpenCommandOptions): Promise<OpenedPlace> {
    const prof = profiler.scope("claude-cmux-open");
    const { target } = options;
    const placed = await prof.measureAsync("place", async (): Promise<OpenedPlace> => {
        switch (target.kind) {
            case "window": {
                const created = await createWorkspaceWithName({
                    name: options.workspaceName,
                    cwd: options.cwd,
                    window: target.windowId,
                });
                const anchor = await showThenPickAnchor(created.workspace_id);
                return { workspaceId: created.workspace_id, surfaceId: anchor.surfaceId };
            }
            case "workspace": {
                const split = await openSplitInWorkspace(target.workspaceId);
                return { workspaceId: split.workspaceId, surfaceId: split.surfaceId };
            }
            case "pane": {
                const created = await openSurfaceInPane(target.workspaceId, target.paneId);
                return { workspaceId: target.workspaceId, surfaceId: created.surfaceId };
            }
            case "surface":
                return { workspaceId: target.workspaceId, surfaceId: target.surfaceId };
        }
    });

    // A surface created here gets its tab named; an existing surface (kind "surface") keeps
    // whatever title its owner gave it.
    if (target.kind !== "surface") {
        // Best-effort: a terminal that opened fine must not fail because its tab kept the default
        // name. Swallowing it silently, though, is how "tab renaming stopped working" becomes
        // unexplainable (PR #332 review t8).
        await renameSurfaceTab(placed.workspaceId, placed.surfaceId, options.title).catch((err: unknown) => {
            log.debug({ err, surface: placed.surfaceId }, "could not rename the surface tab");
        });
    }

    const payload = `${options.command}${(options.enter ?? true) ? "\n" : ""}`;
    await prof.measureAsync("raise-then-send", () =>
        raiseThenSend(
            {
                workspaceId: placed.workspaceId,
                surfaceId: placed.surfaceId,
                payload,
                windowId: target.kind === "window" ? target.windowId : undefined,
            },
            livePlacementIO()
        )
    );

    return placed;
}

/**
 * Where a `--surface new|split|workspace` launch goes: a new tab in the focused pane, a split in
 * the focused workspace, or a new workspace in the focused window.
 */
export function launchTarget(
    surface: "new" | "split" | "workspace" | undefined,
    focused: CmuxPlace
): OpenSessionTarget {
    if (surface === "workspace") {
        if (!focused.windowId) {
            throw new Error("cmux reported no focused window to open a workspace in");
        }

        return { kind: "window", windowId: focused.windowId };
    }

    if (!focused.workspaceId) {
        throw new Error("cmux reported no focused workspace; is cmux running?");
    }

    if (surface === "split") {
        return { kind: "workspace", workspaceId: focused.workspaceId };
    }

    if (!focused.paneId) {
        throw new Error("cmux reported no focused pane to open a tab in");
    }

    return { kind: "pane", workspaceId: focused.workspaceId, paneId: focused.paneId };
}

/** The focused window, workspace and pane, every id and ref at once. */
export async function focusedPlace(): Promise<CmuxPlace> {
    return (await identifyCmux()).focused;
}

/**
 * A workspace that has never been shown does not resolve for `pane.list`: cmux
 * answers with the ACTIVE workspace's panes rather than an error. Asking before
 * the first select therefore returned the CALLER's own surface, and the resume
 * command was typed into the terminal the user was sitting in — observed
 * 2026-08-31, where a new workspace:13 sent its command to surface:179 in
 * workspace:3. Show the workspace first, then ask it for its anchor.
 *
 * raiseThenSend selects the same workspace again a moment later, which is a
 * no-op, so the extra select costs one call and no flicker.
 */
async function showThenPickAnchor(workspaceId: string): Promise<{ paneId: string; surfaceId: string }> {
    await runCmuxOk(["select-workspace", "--workspace", workspaceId]);
    await new Promise((resolve) => setTimeout(resolve, PLACEMENT_SETTLE_MS));
    return pickAnchorSurface(workspaceId);
}

/** cmux needs this pause after select-workspace before the new PTY accepts keys. */
export const PLACEMENT_SETTLE_MS = 400;

/** Every id passed through here is a cmux UUID. */
export interface PlacementIO {
    selectWorkspace: (workspaceId: string) => Promise<void>;
    send: (workspaceId: string, surfaceId: string, payload: string) => Promise<void>;
    focusWindow: (windowId: string) => Promise<void>;
    identifyWindow?: (workspaceId: string) => Promise<string | undefined>;
    activateApp?: () => Promise<void>;
    sleep: (ms: number) => Promise<void>;
}

/**
 * Select the new workspace so its surface actually renders, wait for the PTY,
 * type the resume command, then raise the window.
 *
 * Send-before-select is a silent no-op on a workspace that has never been shown
 * (`in_window=false` until the first select — Cmux.md sending-input).
 */
export async function raiseThenSend(
    args: { workspaceId: string; surfaceId: string; payload: string; windowId?: string },
    io: PlacementIO
): Promise<void> {
    await io.selectWorkspace(args.workspaceId);
    await io.sleep(PLACEMENT_SETTLE_MS);
    await io.send(args.workspaceId, args.surfaceId, args.payload);

    const window = args.windowId ?? (await io.identifyWindow?.(args.workspaceId));
    if (window) {
        await io.focusWindow(window);
    }
    await io.activateApp?.();
}

/**
 * The real cmux-backed IO. Exported so a test can assert the ARGV it builds:
 * the injected `PlacementIO` in `open-session.test.ts` proves the ordering of
 * raiseThenSend, but it cannot see the flags, and the flags are where a stale
 * `--workspace` beside a surface UUID reintroduces "Surface is not a terminal".
 */
export function livePlacementIO(): PlacementIO {
    return {
        selectWorkspace: async (workspaceId) => {
            await runCmuxOk(["select-workspace", "--workspace", workspaceId]);
        },
        send: async (workspaceId, surfaceId, payload) => {
            await runCmuxOk(["send", ...surfaceTargetArgs(surfaceId, workspaceId), payload]);
        },
        focusWindow: async (windowId) => {
            try {
                await runCmuxOk(["focus-window", "--window", windowId]);
            } catch (err) {
                log.debug({ err, windowId }, "could not focus window after open");
            }
        },
        identifyWindow: async (workspaceId) => {
            try {
                return (await identifyCmux({ workspace: workspaceId })).caller.windowId;
            } catch (err) {
                log.debug({ err, workspaceId }, "could not resolve window after open");
                return undefined;
            }
        },
        activateApp: async () => {
            if (process.platform !== "darwin") {
                return;
            }
            try {
                const { bundleId } = await identifyCmux();
                if (!bundleId) {
                    return;
                }
                const proc = Bun.spawn(["open", "-b", bundleId], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
                const code = await proc.exited;

                // A nonzero exit resolves rather than throwing, so without this
                // a failed raise was silent (PR #343 review t14).
                if (code !== 0) {
                    log.debug({ code, bundleId }, "could not raise the cmux app after open");
                }
            } catch (err) {
                log.debug({ err }, "could not raise the cmux app after open");
            }
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
}
