import type { PublishedNote } from "@app/dev-dashboard/config";
import type {
    AttachTmuxResult,
    CmuxLayoutTree,
    CmuxSnapshot,
    DashboardSendTarget,
} from "@app/dev-dashboard/lib/cmux/types";
import type {
    AttentionRes,
    CommandsRes,
    ProcessesRes,
    TmuxPresetRestoreRes,
    TmuxPresetSaveRes,
    TmuxPresetsRes,
} from "@app/dev-dashboard/contract/endpoints";
import type { SavedCommand, SavedCommandInput } from "@app/dev-dashboard/lib/commands/types";
import type { KillPortResult, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import type { ProcessSort } from "@app/dev-dashboard/lib/system/types";
import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { SafeJSON } from "@app/utils/json";
import type { TmuxScrollState } from "@app/utils/tmux/sessions";

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
    scrollState: (id: string) =>
        jsonFetch<{ state: TmuxScrollState | null }>(`/api/ttyd/scroll-state?id=${encodeURIComponent(id)}`),
    scrollTo: (id: string, fraction: number) =>
        jsonFetch<{ ok: boolean }>("/api/ttyd/scroll-to", {
            method: "POST",
            body: SafeJSON.stringify({ id, fraction }),
        }),
};

export const tmuxApi = {
    /**
     * Pass `includeCmux: true` ONLY when the caller reads `cmuxSurfaces`/`inCmux`.
     * The default skips the ~150ms cmux layout fetch — without it `cmuxSurfaces`
     * is `[]` and `inCmux` is `false` for every session.
     */
    sessions: (opts: { includeCmux?: boolean } = {}) => {
        const qs = opts.includeCmux ? "?include=cmux" : "";
        return jsonFetch<{ sessions: TmuxHubSession[] }>(`/api/tmux/sessions${qs}`);
    },
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

export const presetsApi = {
    list: () => jsonFetch<TmuxPresetsRes>("/api/tmux/presets"),
    save: (body: { name: string; note?: string; prefix?: string }) =>
        jsonFetch<TmuxPresetSaveRes>("/api/tmux/presets/save", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    restore: (name: string) =>
        jsonFetch<TmuxPresetRestoreRes>("/api/tmux/presets/restore", {
            method: "POST",
            body: SafeJSON.stringify({ name }),
        }),
    remove: (name: string) =>
        jsonFetch<{ removed: boolean }>("/api/tmux/presets", {
            method: "DELETE",
            body: SafeJSON.stringify({ name }),
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

export const processesApi = {
    list: (sort: ProcessSort = "rss", limit?: number) => {
        const params = new URLSearchParams({ sort });

        if (limit) {
            params.set("limit", String(limit));
        }

        return jsonFetch<ProcessesRes>(`/api/processes?${params.toString()}`);
    },
    kill: (pid: number) =>
        jsonFetch<{ ok: boolean }>("/api/processes/kill", {
            method: "POST",
            body: SafeJSON.stringify({ pid }),
        }),
};

export const attentionApi = {
    list: () => jsonFetch<AttentionRes>("/api/attention"),
    /** Mark a QA action entry read so it drops out of the attention queue (reuses /api/qa/read). */
    read: (ids: string[]) =>
        jsonFetch<{ ok: boolean; updated: number }>("/api/qa/read", {
            method: "POST",
            body: SafeJSON.stringify({ ids, unread: false }),
        }),
};

export const portsApi = {
    list: () => jsonFetch<PortsResult>("/api/ports"),
    kill: (pid: number, expectedCommand?: string) =>
        jsonFetch<KillPortResult>("/api/ports/kill", {
            method: "POST",
            body: SafeJSON.stringify({ pid, expectedCommand }),
        }),
};

export const commandsApi = {
    list: () => jsonFetch<CommandsRes>("/api/commands"),
    create: (body: SavedCommandInput) =>
        jsonFetch<{ command: SavedCommand }>("/api/commands", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    remove: (id: string) =>
        jsonFetch<{ removed: number }>("/api/commands", {
            method: "DELETE",
            body: SafeJSON.stringify({ id }),
        }),
};
