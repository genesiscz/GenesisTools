import { HOST_COMMANDS, type HostCommand, type HostResponse } from "../../lib/host/messages";
import { ext } from "../chrome";

/** Messages the extension's own pages and content script send to the background worker. */
export type BackgroundMessage =
    | { type: "host"; command: HostCommand; params?: Record<string, unknown> }
    | { type: "gitlab.sync" }
    | { type: "router.bypass"; url: string };

/** Background -> content script: a context-menu entry was clicked on this tab. */
export interface MenuMessage {
    type: "menu";
    item: MenuItem;
    selectionText?: string;
}

export type MenuItem = "open-file" | "open-terminal" | "explain" | "review";

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHostCommand(value: unknown): value is HostCommand {
    return typeof value === "string" && (HOST_COMMANDS as readonly string[]).includes(value);
}

export function isHostResponse(value: unknown): value is HostResponse {
    return isRecord(value) && (value.ok === true || (value.ok === false && typeof value.error === "string"));
}

export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
    if (!isRecord(value)) {
        return false;
    }

    if (value.type === "host") {
        return isHostCommand(value.command) && (value.params === undefined || isRecord(value.params));
    }

    return value.type === "gitlab.sync" || (value.type === "router.bypass" && typeof value.url === "string");
}

export function isMenuMessage(value: unknown): value is MenuMessage {
    return (
        isRecord(value) &&
        value.type === "menu" &&
        (value.item === "open-file" ||
            value.item === "open-terminal" ||
            value.item === "explain" ||
            value.item === "review")
    );
}

/** One host command through the background worker; a transport failure comes back as `ok: false`. */
export async function callHost<T = unknown>(
    command: HostCommand,
    params: Record<string, unknown> = {}
): Promise<HostResponse<T>> {
    const message: BackgroundMessage = { type: "host", command, params };

    try {
        const reply = await ext.runtime.sendMessage(message);

        if (isHostResponse(reply)) {
            return reply as HostResponse<T>;
        }

        return { ok: false, code: "failed", error: "the background worker gave no answer" };
    } catch (error) {
        return { ok: false, code: "unavailable", error: error instanceof Error ? error.message : String(error) };
    }
}
