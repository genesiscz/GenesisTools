import type { PublishedNote } from "@app/dev-dashboard/config";
import type {
    AttachTmuxResult,
    CmuxLayoutTree,
    CmuxSnapshot,
    DashboardSendTarget,
} from "@app/dev-dashboard/lib/cmux/types";
import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { SafeJSON } from "@app/utils/json";

export interface TmuxHubSession {
    name: string;
    attached: number;
    windows: number;
    ttydTabIds: string[];
    canAttachInTtyd: boolean;
    cmuxSurfaces: Array<{ workspaceId: string; surfaceId: string; title: string }>;
    inCmux: boolean;
}

/**
 * Shared fetch primitive for the dashboard UI: enforces `res.ok` and parses the
 * body through strict `SafeJSON` (responses are an external boundary). Reused by
 * every query/mutation so JSON handling is consistent in one place.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${url} -> ${res.status}: ${text}`);
    }

    return SafeJSON.parse(await res.text(), { strict: true }) as T;
}

function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
    return fetchJson<T>(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
}

export const ttydApi = {
    list: () => jsonFetch<{ sessions: TtydSession[] }>("/api/ttyd/list"),
    spawn: (body: { command?: string; cwd?: string; tmuxSessionName?: string } = {}) =>
        jsonFetch<{ session: TtydSession }>("/api/ttyd/spawn", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    kill: (id: string, killTmux = false) =>
        jsonFetch<{ ok: boolean }>("/api/ttyd/kill", {
            method: "POST",
            body: SafeJSON.stringify({ id, killTmux }),
        }),
    rename: (id: string, name: string) =>
        jsonFetch<{ ok: boolean }>("/api/ttyd/rename", {
            method: "POST",
            body: SafeJSON.stringify({ id, name }),
        }),
};

export const tmuxApi = {
    sessions: () => jsonFetch<{ sessions: TmuxHubSession[] }>("/api/tmux/sessions"),
    create: (body: { name?: string; cwd?: string; command?: string } = {}) =>
        jsonFetch<{ sessionName: string; cwd: string; command: string }>("/api/tmux/create", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    rename: (body: { from: string; to: string }) =>
        jsonFetch<{ sessionName: string }>("/api/tmux/rename", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
};

export const cmuxApi = {
    snapshot: () => jsonFetch<{ snapshot: CmuxSnapshot }>("/api/cmux/snapshot"),
    layout: () => jsonFetch<{ layout: CmuxLayoutTree }>("/api/cmux/layout"),
    attach: (body: { workspaceId: string; paneId: string }) =>
        jsonFetch<{ ok: boolean }>("/api/cmux/attach", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    createTerminal: (body: { cwd?: string } = {}) =>
        jsonFetch<{ result: AttachTmuxResult }>("/api/cmux/create-terminal", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    createWorkspace: (body: { windowId: string; name?: string; cwd?: string }) =>
        jsonFetch<{ result: { workspaceId: string; windowId: string } }>("/api/cmux/create-workspace", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    sendSession: (body: { tmuxSessionName: string; target: DashboardSendTarget; cwd?: string }) =>
        jsonFetch<{ result: AttachTmuxResult }>("/api/cmux/send-session", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    removeSession: (body: { tmuxSessionName: string }) =>
        jsonFetch<{ removed: number }>("/api/cmux/remove-session", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    rename: (body: { workspaceId: string; surfaceId?: string; title: string }) =>
        jsonFetch<{ ok: boolean }>("/api/cmux/rename", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
};

export const obsidianApi = {
    tree: () => jsonFetch<{ entries: VaultEntry[] }>("/api/obsidian/tree"),
    note: (path: string) =>
        jsonFetch<{ source: string; html: string; publishedSlug: string | null }>(
            `/api/obsidian/note?path=${encodeURIComponent(path)}`
        ),
    publish: (path: string) =>
        jsonFetch<{ note: PublishedNote }>("/api/obsidian/publish", {
            method: "POST",
            body: SafeJSON.stringify({ path }),
        }),
    unpublish: (slug: string) =>
        jsonFetch<{ remaining: PublishedNote[] }>("/api/obsidian/unpublish", {
            method: "POST",
            body: SafeJSON.stringify({ slug }),
        }),
};
