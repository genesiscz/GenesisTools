import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
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
 */
export type OpenSessionTarget =
    | { kind: "window"; windowRef: string }
    | { kind: "workspace"; workspaceRef: string }
    | { kind: "pane"; workspaceRef: string; paneRef: string }
    | { kind: "surface"; workspaceRef: string; surfaceRef: string };

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

/**
 * Opens a terminal at `target` (a new workspace, split or tab, or an existing surface), names its
 * tab, types `command` and raises the window. Resuming a session and `tools cmux launch --open`
 * both go through here.
 */
export async function openCommandAt(
    options: OpenCommandOptions
): Promise<{ workspaceRef: string; surfaceRef: string }> {
    const prof = profiler.scope("claude-cmux-open");
    const { target } = options;
    const placed = await prof.measureAsync("place", async (): Promise<{ workspaceRef: string; surfaceRef: string }> => {
        switch (target.kind) {
            case "window": {
                const created = await createWorkspaceWithName({
                    name: options.workspaceName,
                    cwd: options.cwd,
                    window: target.windowRef,
                });
                const anchor = await showThenPickAnchor(created.workspace_ref);
                return { workspaceRef: created.workspace_ref, surfaceRef: anchor.surfaceRef };
            }
            case "workspace": {
                const split = await openSplitInWorkspace(target.workspaceRef);
                return { workspaceRef: target.workspaceRef, surfaceRef: split.surfaceId };
            }
            case "pane": {
                const created = await openSurfaceInPane(target.workspaceRef, target.paneRef);
                return { workspaceRef: target.workspaceRef, surfaceRef: created.surfaceId };
            }
            case "surface":
                return { workspaceRef: target.workspaceRef, surfaceRef: target.surfaceRef };
        }
    });

    // A surface created here gets its tab named; an existing surface (kind "surface") keeps
    // whatever title its owner gave it.
    if (target.kind !== "surface") {
        // Best-effort: a terminal that opened fine must not fail because its tab kept the default
        // name. Swallowing it silently, though, is how "tab renaming stopped working" becomes
        // unexplainable (PR #332 review t8).
        await renameSurfaceTab(placed.workspaceRef, placed.surfaceRef, options.title).catch((err: unknown) => {
            log.debug({ err, surface: placed.surfaceRef }, "could not rename the surface tab");
        });
    }

    const payload = `${options.command}${(options.enter ?? true) ? "\n" : ""}`;
    await prof.measureAsync("raise-then-send", () =>
        raiseThenSend(
            {
                workspaceRef: placed.workspaceRef,
                surfaceRef: placed.surfaceRef,
                payload,
                windowRef: target.kind === "window" ? target.windowRef : undefined,
            },
            livePlacementIO()
        )
    );

    return placed;
}

interface FocusedPlace {
    window_ref?: string;
    workspace_ref?: string;
    pane_ref?: string;
}

/**
 * Where a `--surface new|split|workspace` launch goes: a new tab in the focused pane, a split in
 * the focused workspace, or a new workspace in the focused window.
 */
export function launchTarget(
    surface: "new" | "split" | "workspace" | undefined,
    focused: FocusedPlace
): OpenSessionTarget {
    if (surface === "workspace") {
        if (!focused.window_ref) {
            throw new Error("cmux reported no focused window to open a workspace in");
        }

        return { kind: "window", windowRef: focused.window_ref };
    }

    if (!focused.workspace_ref) {
        throw new Error("cmux reported no focused workspace; is cmux running?");
    }

    if (surface === "split") {
        return { kind: "workspace", workspaceRef: focused.workspace_ref };
    }

    if (!focused.pane_ref) {
        throw new Error("cmux reported no focused pane to open a tab in");
    }

    return { kind: "pane", workspaceRef: focused.workspace_ref, paneRef: focused.pane_ref };
}

/** The focused window, workspace and pane, from `cmux identify`. */
export async function focusedPlace(): Promise<FocusedPlace> {
    const identify = await runCmuxJSON<{ focused?: FocusedPlace }>(["identify"]);
    return identify.focused ?? {};
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
async function showThenPickAnchor(workspaceRef: string): Promise<{ paneRef: string; surfaceRef: string }> {
    await runCmuxOk(["select-workspace", "--workspace", workspaceRef]);
    await new Promise((resolve) => setTimeout(resolve, PLACEMENT_SETTLE_MS));
    return pickAnchorSurface(workspaceRef);
}

interface IdentifyResponse {
    bundle_identifier?: string;
    caller?: { window_ref?: string };
}

/** cmux needs this pause after select-workspace before the new PTY accepts keys. */
export const PLACEMENT_SETTLE_MS = 400;

export interface PlacementIO {
    selectWorkspace: (workspaceRef: string) => Promise<void>;
    send: (workspaceRef: string, surfaceRef: string, payload: string) => Promise<void>;
    focusWindow: (windowRef: string) => Promise<void>;
    identifyWindow?: (workspaceRef: string) => Promise<string | undefined>;
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
    args: { workspaceRef: string; surfaceRef: string; payload: string; windowRef?: string },
    io: PlacementIO
): Promise<void> {
    await io.selectWorkspace(args.workspaceRef);
    await io.sleep(PLACEMENT_SETTLE_MS);
    await io.send(args.workspaceRef, args.surfaceRef, args.payload);

    const window = args.windowRef ?? (await io.identifyWindow?.(args.workspaceRef));
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
        selectWorkspace: async (workspaceRef) => {
            await runCmuxOk(["select-workspace", "--workspace", workspaceRef]);
        },
        send: async (workspaceRef, surfaceRef, payload) => {
            await runCmuxOk(["send", ...surfaceTargetArgs(surfaceRef, workspaceRef), payload]);
        },
        focusWindow: async (windowRef) => {
            try {
                await runCmuxOk(["focus-window", "--window", windowRef]);
            } catch (err) {
                log.debug({ err, windowRef }, "could not focus window after open");
            }
        },
        identifyWindow: async (workspaceRef) => {
            try {
                const identify = await runCmuxJSON<IdentifyResponse>(["identify", "--workspace", workspaceRef]);
                return identify.caller?.window_ref;
            } catch (err) {
                log.debug({ err, workspaceRef }, "could not resolve window after open");
                return undefined;
            }
        },
        activateApp: async () => {
            if (process.platform !== "darwin") {
                return;
            }
            try {
                const identify = await runCmuxJSON<IdentifyResponse>(["identify"]);
                const bundleId = identify.bundle_identifier;
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
