import type { PublishedNote } from "@app/dev-dashboard/config";
import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";
import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { SafeJSON } from "@app/utils/json";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${url} -> ${res.status}: ${text}`);
    }

    return (await res.json()) as T;
}

export const ttydApi = {
    list: () => jsonFetch<{ sessions: TtydSession[] }>("/api/ttyd/list"),
    spawn: (body: { command?: string; cwd?: string } = {}) =>
        jsonFetch<{ session: TtydSession }>("/api/ttyd/spawn", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    kill: (id: string) =>
        jsonFetch<{ ok: boolean }>("/api/ttyd/kill", {
            method: "POST",
            body: SafeJSON.stringify({ id }),
        }),
};

export const cmuxApi = {
    snapshot: () => jsonFetch<{ snapshot: CmuxSnapshot }>("/api/cmux/snapshot"),
    attach: (body: { workspaceId: string; paneId: string }) =>
        jsonFetch<{ ok: boolean }>("/api/cmux/attach", {
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
