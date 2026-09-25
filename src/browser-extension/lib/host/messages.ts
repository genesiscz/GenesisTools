/**
 * The native-messaging contract, shared by the extension (types only) and the host. The host
 * accepts exactly these commands; anything else is refused before any code runs.
 */
export const HOST_COMMANDS = [
    "ping",
    "config.get",
    "config.set",
    "checkout.resolve",
    "open.file",
    "open.terminal",
    "hunk.explain",
    "review.start",
    "action.run",
    "router.explain",
    "router.route",
] as const;

/**
 * Commands only the extension's own pages (popup, options, route) may send. A content script runs
 * inside a web page, so it gets the page-scoped commands and nothing that writes config, runs a
 * configured action or triggers a router route.
 */
export const EXTENSION_PAGE_COMMANDS: readonly HostCommand[] = [
    "config.get",
    "config.set",
    "action.run",
    "router.explain",
    "router.route",
];

export type HostCommand = (typeof HOST_COMMANDS)[number];

/** Commands that run an agent, a configured action or a routed tool; the host bounds each one itself. */
const LONG_HOST_COMMANDS: readonly HostCommand[] = ["hunk.explain", "review.start", "action.run", "router.route"];

/**
 * How long the extension waits for a reply before it drops the port. It is a backstop above the
 * host's own timeouts (the headless agent defaults to 3 min, an action to 2 min), so a host that
 * stays connected but never answers cannot keep a request, and the MV3 worker, pending forever.
 */
export function hostReplyDeadlineMs(command: HostCommand): number {
    return LONG_HOST_COMMANDS.includes(command) ? 30 * 60_000 : 60_000;
}

export interface HostRequest {
    command: HostCommand;
    params?: Record<string, unknown>;
}

export type HostErrorCode = "invalid" | "no-checkout" | "unavailable" | "failed" | "unknown-command" | "too-large";

export type HostResponse<T = unknown> = { ok: true; data: T } | { ok: false; code: HostErrorCode; error: string };

export interface PingData {
    host: "genesis-tools";
    version: string;
    pid: number;
    configPath: string;
}

/** Native messaging's own limit for a host -> browser message. */
export const MAX_REPLY_BYTES = 1024 * 1024;
/** Browser -> host messages may be up to 64 MiB; this host has no use for more than 4 MiB. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** The name the browser looks the host up by: lowercase letters, digits, `_` and `.`. */
export const NATIVE_HOST_NAME = "com.genesiscz.genesistools.browser_extension";
