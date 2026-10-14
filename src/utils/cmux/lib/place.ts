import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";

/**
 * Every id and ref of one place in cmux, read at once: a window, a workspace in it, a pane, a surface (a tab).
 * The ids are UUIDs: they survive a cmux relaunch, and every cmux call names a place by them. The refs
 * (`surface:12`) are renumbered at every relaunch, so they are display text only.
 *
 * Code used to read `identify` or the tree by hand, one field at a time, and each reader knew a different subset:
 * the refs in one place, the UUIDs in another, so a ref ended up compared with a UUID (the caller tab was never
 * excluded from `tools claude cmux focus`).
 */
export interface CmuxPlace {
    windowId?: string;
    windowRef?: string;
    workspaceId?: string;
    workspaceRef?: string;
    paneId?: string;
    paneRef?: string;
    surfaceId?: string;
    surfaceRef?: string;
    /** `terminal` or `browser`, where cmux says. */
    surfaceType?: string;
}

/** What `cmux identify` answers: where the caller runs, what has focus, and the app behind the socket. */
export interface CmuxIdentity {
    caller: CmuxPlace;
    focused: CmuxPlace;
    socketPath?: string;
    /** The app's bundle id, for `open -b` to raise it. */
    bundleId?: string;
}

function text(record: object, key: string): string | undefined {
    const value: unknown = Reflect.get(record, key);
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A cmux JSON record's snake_case ids and refs (`window_id`, `surface_ref`, …: the caller or focused record of
 * `identify`, a `new-split` answer) as a place. Fields cmux did not name stay unset.
 */
export function placeOf(record: unknown): CmuxPlace {
    if (typeof record !== "object" || record === null) {
        return {};
    }

    const place: CmuxPlace = {
        windowId: text(record, "window_id"),
        windowRef: text(record, "window_ref"),
        workspaceId: text(record, "workspace_id"),
        workspaceRef: text(record, "workspace_ref"),
        paneId: text(record, "pane_id"),
        paneRef: text(record, "pane_ref"),
        surfaceId: text(record, "surface_id"),
        surfaceRef: text(record, "surface_ref"),
        surfaceType: text(record, "surface_type"),
    };

    return Object.fromEntries(Object.entries(place).filter(([, value]) => value !== undefined));
}

/** The parsed answer of `cmux --json --id-format both identify`. */
export function identityOf(raw: unknown): CmuxIdentity {
    if (typeof raw !== "object" || raw === null) {
        return { caller: {}, focused: {} };
    }

    return {
        caller: placeOf(Reflect.get(raw, "caller")),
        focused: placeOf(Reflect.get(raw, "focused")),
        socketPath: text(raw, "socket_path"),
        bundleId: text(raw, "bundle_identifier"),
    };
}

/**
 * `cmux identify` with both id forms, so every place carries its UUIDs and its refs. `workspace` (a UUID or a ref)
 * asks about that workspace: `caller` then describes it and its window instead of the calling tab. Reads only; it
 * never changes focus.
 */
export async function identifyCmux(options: { workspace?: string; timeoutMs?: number } = {}): Promise<CmuxIdentity> {
    const args = ["--id-format", "both", "identify", ...(options.workspace ? ["--workspace", options.workspace] : [])];
    const raw = options.timeoutMs
        ? await runCmuxJSON<unknown>(args, { timeoutMs: options.timeoutMs })
        : await runCmuxJSON<unknown>(args);

    return identityOf(raw);
}
