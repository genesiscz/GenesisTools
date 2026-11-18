import { connect } from "node:net";
import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { identifyCmux } from "@genesiscz/utils/cmux/lib/place";
import { isCmuxUuid, sameCmuxId } from "@genesiscz/utils/cmux/lib/target";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

interface JsonRpcResponse<T> {
    id: string;
    ok: boolean;
    result?: T;
    error?: { code: string; message: string };
}

let cachedSocketPath: string | null = null;

export async function getSocketPath(): Promise<string> {
    if (cachedSocketPath) {
        return cachedSocketPath;
    }
    const identify = await identifyCmux();
    if (!identify.socketPath) {
        logger.error({ identify }, "[socket] cmux identify returned no socket_path");
        throw new Error("cmux identify did not return a socket_path. Is cmux running?");
    }
    cachedSocketPath = identify.socketPath;
    logger.debug({ path: cachedSocketPath }, "[socket] resolved cmux socket path");
    return cachedSocketPath;
}

export function resetSocketPathCache(): void {
    cachedSocketPath = null;
}

let requestCounter = 0;

/** cmux refused a call: `code` is its own (`not_found` for a surface or workspace that is gone). */
export class CmuxRpcError extends Error {
    constructor(
        readonly method: string,
        readonly code: string,
        readonly detail: string
    ) {
        super(`cmux RPC ${method} failed: ${code} ${detail}`.trim());
        this.name = "CmuxRpcError";
    }
}

/**
 * The socket itself failed (cmux did not answer in time, or the connection broke). Unlike a
 * `CmuxRpcError`, it says nothing about whether the target exists, so a caller must not read it
 * as "the pane is gone".
 */
export class CmuxTransportError extends Error {
    constructor(
        readonly method: string,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "CmuxTransportError";
    }
}

export function isCmuxTransportError(err: unknown): err is CmuxTransportError {
    return err instanceof CmuxTransportError;
}

/** The target (a surface, pane or workspace) no longer exists in cmux. */
export function isCmuxNotFound(err: unknown): boolean {
    return err instanceof CmuxRpcError && err.code === "not_found";
}

export async function rpc<TResult = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {}
): Promise<TResult> {
    const path = await getSocketPath();
    const id = `cmux-${Date.now()}-${++requestCounter}`;
    const payload = `${SafeJSON.stringify({ id, method, params })}\n`;
    const timeoutMs = opts.timeoutMs ?? 5_000;

    return await new Promise<TResult>((resolve, reject) => {
        const sock = connect(path);
        let buffer = "";
        let settled = false;

        const settle = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                sock.destroy();
            } catch {
                // ignore
            }
            fn();
        };

        const timer = setTimeout(() => {
            settle(() => reject(new CmuxTransportError(method, `cmux RPC ${method} timed out after ${timeoutMs}ms`)));
        }, timeoutMs);

        sock.on("error", (error) => {
            clearTimeout(timer);
            settle(() =>
                reject(
                    new CmuxTransportError(method, `cmux RPC ${method} socket error: ${error.message}`, {
                        cause: error,
                    })
                )
            );
        });

        sock.on("connect", () => {
            sock.write(payload);
        });

        sock.on("data", (chunk) => {
            buffer += chunk.toString();
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) {
                return;
            }
            const line = buffer.slice(0, newlineIndex);
            clearTimeout(timer);
            try {
                const parsed = SafeJSON.parse(line) as JsonRpcResponse<TResult>;
                if (!parsed.ok) {
                    // Debug, not error: the caller decides what a refusal means. A stale surface
                    // answers not_found, and the console line reached the hub as a raw error banner.
                    logger.debug({ method, params, error: parsed.error }, "[socket] RPC error");
                    settle(() =>
                        reject(new CmuxRpcError(method, parsed.error?.code ?? "unknown", parsed.error?.message ?? ""))
                    );
                    return;
                }
                settle(() => resolve(parsed.result as TResult));
            } catch (error) {
                settle(() => reject(new Error(`Failed to parse cmux RPC response: ${error}\nLine: ${line}`)));
            }
        });
    });
}

export interface PaneListPane {
    /** Pane UUID; what every command names the pane by. */
    id: string;
    /** `pane:N`, for display: cmux renumbers it at every relaunch. */
    ref: string;
    index: number;
    surface_count: number;
    /** Surface UUIDs, in tab order. */
    surface_ids: string[];
    surface_refs: string[];
    selected_surface_id: string;
    selected_surface_ref: string;
    focused: boolean;
    /**
     * Cell geometry is ABSENT for a pane cmux has not rendered yet — a freshly split
     * pane reports only `pixel_frame` for the first ~150ms, until the pty resize lands.
     * Verified on cmux 0.63.2. Treating these as numbers produced `resize-pane
     * --amount NaN` on every split. `pixel_frame` is always present, so prefer it.
     */
    columns?: number;
    rows?: number;
    cell_width_px?: number;
    cell_height_px?: number;
    pixel_frame: { x: number; y: number; width: number; height: number };
    /**
     * Set only on a Dock pane (the right sidebar terminals cmux builds from `dock.json`), which `paneList` drops.
     * cmux 0.65.1 lists it beside the splits with no geometry and no tabs, and reports it as the focused pane.
     */
    dock_scope?: string;
}

export interface PaneListResponse {
    /** Echoed only under `--id-format both`, which `paneList` passes. */
    workspace_id?: string;
    workspace_ref: string;
    window_id?: string;
    window_ref: string;
    panes: PaneListPane[];
    container_frame: { width: number; height: number };
}

/**
 * Read the split panes of a workspace through the CLI and reject a response belonging to another workspace.
 *
 * Dock panes are dropped: they are not splits, so nothing here can measure, split or rebuild one, and cmux rebuilds
 * the Dock from its config by itself. On 2026-11-18 an empty global Dock pane without `pixel_frame` crashed
 * `restore-after-restart`'s live capture, and as the focused pane it would have taken a launch's anchor.
 */
export async function paneList(workspace: string): Promise<PaneListResponse> {
    // Raw pane.list can ignore workspace and return the focused workspace. The
    // CLI honors the target and now preserves the geometry used by restore.
    // `--id-format both` makes it echo the workspace UUID, so a UUID request is checkable too.
    const raw = await runCmuxJSON<PaneListResponse>(["--id-format", "both", "list-panes", "--workspace", workspace]);
    assertLayoutIsFor(workspace, raw);

    const docks = raw.panes.filter((pane) => pane.dock_scope !== undefined);
    if (docks.length === 0) {
        return raw;
    }

    logger.debug(
        {
            workspace,
            docks: docks.map((pane) => ({ ref: pane.ref, scope: pane.dock_scope, tabs: pane.surface_count })),
        },
        "[socket] list-panes: dropped Dock panes, which are not splits"
    );

    return { ...raw, panes: raw.panes.filter((pane) => pane.dock_scope === undefined) };
}

/**
 * cmux answers `pane.list` for a workspace it cannot resolve (one created but never shown) with
 * the ACTIVE workspace's panes instead of an error. Verified 2026-08-31: `list-panes --workspace
 * workspace:999` returned workspace:3's layout. Trusting that answer types into whichever terminal
 * the user is sitting in, so the echoed workspace must match the one asked about: by UUID when the
 * request was a UUID, by ref when it was a ref. A bare index cannot be checked.
 */
export function assertLayoutIsFor(
    workspace: string,
    layout: Pick<PaneListResponse, "workspace_id" | "workspace_ref">
): void {
    const byUuid = isCmuxUuid(workspace);
    if (!byUuid && !workspace.startsWith("workspace:")) {
        return;
    }

    const echoed = byUuid ? layout.workspace_id : layout.workspace_ref;
    if (!echoed || !sameCmuxId(echoed, workspace)) {
        throw new Error(
            `cmux answered pane.list for ${layout.workspace_ref || echoed || "(missing workspace identity)"} when asked about ${workspace} — ` +
                `select the workspace before asking for its panes`
        );
    }
}

export interface WindowEntry {
    ref: string;
    id: string;
    index: number;
    visible: boolean;
    key: boolean;
    workspace_count: number;
    selected_workspace_ref?: string;
}

export async function windowList(): Promise<WindowEntry[]> {
    const result = await rpc<{ windows: WindowEntry[] }>("window.list", {});
    return result.windows;
}

export interface WorkspaceEntry {
    ref: string;
    id: string;
    index: number;
    title?: string;
    selected?: boolean;
    pinned?: boolean;
    current_directory?: string;
}

export interface WorkspaceListResponse {
    window_ref: string;
    window_id: string;
    workspaces: WorkspaceEntry[];
}

export async function workspaceList(windowId?: string): Promise<WorkspaceListResponse> {
    const params: Record<string, unknown> = {};
    if (windowId) {
        params.window_id = windowId;
    }
    return rpc<WorkspaceListResponse>("workspace.list", params);
}

export interface WorkspaceCreateResult {
    workspace_ref: string;
    workspace_id: string;
    window_ref: string;
    window_id: string;
    /** The new workspace's first terminal. cmux 0.65 answers with it; older versions may not. */
    surface_id?: string;
}

export async function workspaceCreate(
    opts: { name?: string; description?: string; cwd?: string; command?: string; window?: string } = {}
): Promise<WorkspaceCreateResult> {
    const params: Record<string, unknown> = {};
    if (opts.name) {
        params.name = opts.name;
    }
    if (opts.description) {
        params.description = opts.description;
    }
    if (opts.cwd) {
        params.cwd = opts.cwd;
    }
    if (opts.command) {
        params.command = opts.command;
    }
    if (opts.window) {
        params.window_id = opts.window;
    }
    return rpc<WorkspaceCreateResult>("workspace.create", params);
}

/** `new-split` and `new-surface` answer with the UUID and the ref of each object they touched. */
export interface SurfaceSplitResult {
    pane_id: string;
    pane_ref: string;
    surface_id: string;
    surface_ref: string;
    type: string;
    workspace_id: string;
    workspace_ref: string;
    window_id: string;
    window_ref: string;
}

export async function surfaceSplit(
    direction: "left" | "right" | "up" | "down",
    surfaceRef: string,
    workspaceRef: string
): Promise<SurfaceSplitResult> {
    return rpc<SurfaceSplitResult>("surface.split", {
        direction,
        surface: surfaceRef,
        workspace: workspaceRef,
    });
}

export async function browserUrl(surfaceRef: string): Promise<string | null> {
    try {
        const result = await rpc<{ url?: string } | string>("browser.url.get", { surface: surfaceRef });
        if (typeof result === "string") {
            return result;
        }
        return result?.url ?? null;
    } catch (error) {
        logger.debug({ error, surfaceRef }, "[socket] browser.url.get failed");
        return null;
    }
}
