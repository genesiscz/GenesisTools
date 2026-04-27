import { connect } from "node:net";
import logger from "@app/logger";
import { runCmuxJSON } from "@app/cmux/lib/cli";

interface IdentifyResponse {
    socket_path: string;
}

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
    const identify = await runCmuxJSON<IdentifyResponse>(["identify"]);
    if (!identify.socket_path) {
        logger.error({ identify }, "[socket] cmux identify returned no socket_path");
        throw new Error("cmux identify did not return a socket_path. Is cmux running?");
    }
    cachedSocketPath = identify.socket_path;
    logger.debug({ path: cachedSocketPath }, "[socket] resolved cmux socket path");
    return cachedSocketPath;
}

export function resetSocketPathCache(): void {
    cachedSocketPath = null;
}

let requestCounter = 0;

export async function rpc<TResult = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
): Promise<TResult> {
    const path = await getSocketPath();
    const id = `cmux-${Date.now()}-${++requestCounter}`;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
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
            settle(() => reject(new Error(`cmux RPC ${method} timed out after ${timeoutMs}ms`)));
        }, timeoutMs);

        sock.on("error", (error) => {
            clearTimeout(timer);
            settle(() => reject(error));
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
                const parsed = JSON.parse(line) as JsonRpcResponse<TResult>;
                if (!parsed.ok) {
                    logger.error({ method, params, error: parsed.error }, "[socket] RPC error");
                    settle(() =>
                        reject(
                            new Error(
                                `cmux RPC ${method} failed: ${parsed.error?.code ?? "unknown"} ${parsed.error?.message ?? ""}`.trim(),
                            ),
                        ),
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
    ref: string;
    index: number;
    surface_count: number;
    surface_refs: string[];
    selected_surface_ref: string;
    focused: boolean;
    columns: number;
    rows: number;
    cell_width_px: number;
    cell_height_px: number;
    pixel_frame: { x: number; y: number; width: number; height: number };
}

export interface PaneListResponse {
    workspace_ref: string;
    window_ref: string;
    panes: PaneListPane[];
    container_frame: { width: number; height: number };
}

export async function paneList(workspaceRef: string): Promise<PaneListResponse> {
    return rpc<PaneListResponse>("pane.list", { workspace: workspaceRef });
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

export async function workspaceList(windowRef?: string): Promise<WorkspaceListResponse> {
    const params: Record<string, unknown> = {};
    if (windowRef) {
        params.window = windowRef;
    }
    return rpc<WorkspaceListResponse>("workspace.list", params);
}

export interface WorkspaceCreateResult {
    workspace_ref: string;
    workspace_id: string;
    window_ref: string;
    window_id: string;
}

export async function workspaceCreate(opts: {
    name?: string;
    description?: string;
    cwd?: string;
    command?: string;
    window?: string;
} = {}): Promise<WorkspaceCreateResult> {
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
        params.window = opts.window;
    }
    return rpc<WorkspaceCreateResult>("workspace.create", params);
}

export interface SurfaceSplitResult {
    pane_ref: string;
    surface_ref: string;
    type: string;
    workspace_ref: string;
    window_ref: string;
}

export async function surfaceSplit(
    direction: "left" | "right" | "up" | "down",
    surfaceRef: string,
    workspaceRef: string,
): Promise<SurfaceSplitResult> {
    return rpc<SurfaceSplitResult>("surface.split", {
        direction,
        surface: surfaceRef,
        workspace: workspaceRef,
    });
}

export interface SurfaceCreateResult {
    pane_ref: string;
    surface_ref: string;
    type: string;
    workspace_ref: string;
    window_ref: string;
}

export async function surfaceCreate(opts: {
    pane?: string;
    workspace?: string;
    type?: "terminal" | "browser";
    url?: string;
}): Promise<SurfaceCreateResult> {
    const params: Record<string, unknown> = {};
    if (opts.pane) {
        params.pane = opts.pane;
    }
    if (opts.workspace) {
        params.workspace = opts.workspace;
    }
    if (opts.type) {
        params.type = opts.type;
    }
    if (opts.url) {
        params.url = opts.url;
    }
    return rpc<SurfaceCreateResult>("surface.create", params);
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
