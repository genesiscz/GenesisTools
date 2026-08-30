import { buildLaunchCommand, paneTitle } from "@app/claude/lib/cmux/command";
import { findCandidate } from "@app/claude/lib/cmux/sessions";
import type { PlannedSession } from "@app/claude/lib/cmux/types";
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
 * Resume a session at a chosen level of the cmux hierarchy:
 *
 * - window    → new workspace in that window
 * - workspace → new pane (split) in that workspace
 * - pane      → new surface (tab) in that pane
 * - surface   → type the resume command into that surface as-is
 *
 * The launch command comes from the same builder restore uses, so the session
 * resumes under the account and auth mode it was pinned to.
 */
export type OpenSessionTarget =
    | { kind: "window"; windowRef: string }
    | { kind: "workspace"; workspaceRef: string }
    | { kind: "pane"; workspaceRef: string; paneRef: string }
    | { kind: "surface"; workspaceRef: string; surfaceRef: string };

export interface OpenSessionResult {
    sessionId: string;
    command: string;
    workspaceRef: string;
    surfaceRef: string;
    target: OpenSessionTarget["kind"];
}

export async function openSessionAt(
    sessionId: string,
    target: OpenSessionTarget,
    opts: { enter?: boolean } = {}
): Promise<OpenSessionResult> {
    const prof = profiler.scope("claude-cmux-open");
    const candidate = await prof.measureAsync("candidate", () => findCandidate(sessionId));

    if (!candidate) {
        throw new Error(`No local session matches "${sessionId}" (need a full id or an 8+ char prefix)`);
    }

    const planned: PlannedSession = { candidate, account: candidate.account, model: candidate.model };
    const command = buildLaunchCommand(planned);

    const placed = await prof.measureAsync("place", async (): Promise<{ workspaceRef: string; surfaceRef: string }> => {
        switch (target.kind) {
            case "window": {
                const created = await createWorkspaceWithName({
                    name: candidate.project,
                    cwd: candidate.cwd,
                    window: target.windowRef,
                });
                const anchor = await pickAnchorSurface(created.workspace_ref);
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

    // A surface created for the session gets its tab named; an existing surface
    // (kind "surface") keeps whatever title its owner gave it.
    if (target.kind !== "surface") {
        // Best-effort: a session that opened fine must not fail because its tab
        // kept the default name. Swallowing it silently, though, is how "tab
        // renaming stopped working" becomes unexplainable (PR #332 review t8).
        await renameSurfaceTab(placed.workspaceRef, placed.surfaceRef, paneTitle(planned)).catch((err: unknown) => {
            log.debug({ err, surface: placed.surfaceRef }, "could not rename the surface tab");
        });
    }

    const payload = `${command}${(opts.enter ?? true) ? "\n" : ""}`;
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
    prof.summary("open-session");

    return {
        sessionId: candidate.sessionId,
        command,
        workspaceRef: placed.workspaceRef,
        surfaceRef: placed.surfaceRef,
        target: target.kind,
    };
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
