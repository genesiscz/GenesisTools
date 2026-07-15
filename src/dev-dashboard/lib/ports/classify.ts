import type { PortInfo, PortKind, PortVisibility } from "@app/dev-dashboard/lib/ports/types";
import {
    matchRegistryProcess,
    registryEntryForPort,
    registryNameForPort,
    registryNameForProcess,
} from "@app/utils/ui/dashboards";

/** Ephemeral / dynamic port range — IDE extension hosts love these. */
const EPHEMERAL_PORT_MIN = 49152;

const SYSTEM_COMMAND_RE =
    /^(ControlCe|ControlCenter|rapportd|sharingd|AirPlayXPCHelper|mDNSResponder|identityservicesd|bluetoothd|coreaudiod|WindowServer|SystemUIServer|loginwindow|launchd|configd|syslogd|notifyd|distnoted|cfprefsd|UserEventAgent|secd|trustd|locationd|airportd|powerd|sysmond)$/i;

const SYSTEM_PATH_RE = /\/System\/Library\/|\/usr\/libexec\/|\/usr\/sbin\//;

const IDE_JUNK_RE = /\b(Cursor Helper|Cursor$|Code Helper|Code - |Visual Studio Code|VSCodium|Electron)\b/i;

const TERMINAL_JUNK_RE = /\/Warp\.app\/|\/Applications\/Warp|Ghostty|iTerm2|Hyper\.app/i;

/** Consumer apps that open random high ports (local APIs / IPC) — not dev servers. */
const CONSUMER_JUNK_RE = /\b(Spotify|Discord|Slack|Figma|Zoom|Notion|Linear|1Password|Dropbox)\b/i;

/**
 * True when this listening port is a verified GenesisTools registry entry
 * (DASHBOARDS or WEB_SERVICES) whose matchProcess accepts the live process.
 */
export function isVerifiedGenesisTools(port: number, fullCommand?: string, cwd?: string, command = ""): boolean {
    return (
        matchRegistryProcess({
            port,
            command,
            fullCommand,
            cwd,
        }) !== null
    );
}

/** @deprecated Prefer registryNameForPort / registryNameForProcess — kept for enrich re-exports. */
export function dashboardNameForPort(port: number): string | null {
    return registryNameForPort(port);
}

export function deriveVisibility(input: {
    port: number;
    command: string;
    fullCommand?: string;
    cwd?: string;
}): PortVisibility {
    const cmd = input.fullCommand ?? input.command;
    const short = input.command;

    if (SYSTEM_COMMAND_RE.test(short) || SYSTEM_COMMAND_RE.test(cmd.split(/\s+/)[0] ?? "")) {
        return "system";
    }

    if (SYSTEM_PATH_RE.test(cmd)) {
        return "system";
    }

    if (IDE_JUNK_RE.test(cmd) || IDE_JUNK_RE.test(short)) {
        return "junk";
    }

    if (TERMINAL_JUNK_RE.test(cmd) || (/\/stable\b/i.test(cmd) && /Warp/i.test(cmd))) {
        return "junk";
    }

    if (CONSUMER_JUNK_RE.test(cmd) || CONSUMER_JUNK_RE.test(short)) {
        return "junk";
    }

    if (input.port >= EPHEMERAL_PORT_MIN && isLikelyIdeOrBrowserHelper(cmd, short)) {
        return "junk";
    }

    return "normal";
}

function isLikelyIdeOrBrowserHelper(full: string, short: string): boolean {
    return (
        IDE_JUNK_RE.test(full) ||
        IDE_JUNK_RE.test(short) ||
        /\b(Chrome Helper|Brave Helper|Firefox|Slack Helper|Discord)\b/i.test(full)
    );
}

/**
 * Friendly title: matched registry name wins, then Cursor label, package name, command.
 */
export function deriveTitle(input: {
    port: number;
    command: string;
    fullCommand?: string;
    cwd?: string;
    packageName?: string | null;
}): string {
    const full = input.fullCommand ?? input.command;
    const matchedName = registryNameForProcess({
        port: input.port,
        command: input.command,
        fullCommand: input.fullCommand,
        cwd: input.cwd,
    });

    if (matchedName) {
        return matchedName;
    }

    const cursor = parseCursorWorkspace(full);
    if (cursor) {
        return cursor;
    }

    if (/ControlCenter/i.test(full) || /^ControlCe/i.test(input.command)) {
        return "Control Center (AirPlay Receiver)";
    }

    if (/\/Warp\.app\/|Warp\.app/i.test(full)) {
        return "Warp";
    }

    if (input.packageName && input.packageName.toLowerCase() !== "genesis-tools") {
        return input.packageName;
    }

    // Registered port but process didn't match — still hint the expected name.
    const hint = registryNameForPort(input.port);
    if (hint) {
        return hint;
    }

    if (input.packageName) {
        return input.packageName;
    }

    return input.command;
}

/** `Cursor Helper (Plugin): extension-host (user) GenesisPlayground [3-14]` → `Cursor · GenesisPlayground [3-14]`. */
export function parseCursorWorkspace(fullCommand: string): string | null {
    if (!/Cursor/i.test(fullCommand)) {
        return null;
    }

    const extHost = fullCommand.match(/extension-host\s*\([^)]*\)\s+(.+?)\s*$/i);
    if (extHost?.[1]) {
        return `Cursor · ${extHost[1].trim()}`;
    }

    const plugin = fullCommand.match(/Cursor Helper[^:]*:\s*(.+)$/i);
    if (plugin?.[1]) {
        return `Cursor · ${plugin[1].trim()}`;
    }

    if (/^Cursor(\s|$)/i.test(fullCommand.trim()) || /\bCursor\b/i.test(fullCommand)) {
        return "Cursor";
    }

    return null;
}

export interface ProbeClassification {
    kind: PortKind;
    isWebapp: boolean;
    titleFromHtml?: string | null;
}

/**
 * Map HTTP probe result → kind. GenesisTools registry match overrides the kind label.
 */
export function kindFromProbe(input: {
    isGenesisTools: boolean;
    http: boolean;
    contentClass: "html" | "json" | "text" | "other" | "none";
}): ProbeClassification {
    if (input.isGenesisTools) {
        return {
            kind: "genesis-tools",
            isWebapp: input.contentClass === "html" || input.http,
        };
    }

    if (input.contentClass === "html") {
        return { kind: "web", isWebapp: true };
    }

    if (input.contentClass === "json" || input.contentClass === "text") {
        return { kind: "api", isWebapp: false };
    }

    if (input.http) {
        return { kind: "other", isWebapp: false };
    }

    return { kind: "other", isWebapp: false };
}

/** Multiselect filter. `all` alone (or with others) means every non-hidden row of the given visibility set. */
export type PortFilterId = "all" | "web" | "apis" | "genesis-tools";

/**
 * Apply kind filters. Rules:
 * - If selection includes `all` (or is empty), keep everything in `ports`.
 * - Otherwise OR across selected kinds. Web + Apis ≠ All.
 * - GenesisTools is known from registry match before HTTP probe.
 * - Web/Apis still pending: keep those rows while classifying.
 */
export function filterPortsByKind(ports: PortInfo[], selected: PortFilterId[]): PortInfo[] {
    const set = new Set(selected.length === 0 ? (["all"] as PortFilterId[]) : selected);

    if (set.has("all")) {
        return ports;
    }

    return ports.filter((p) => {
        if (set.has("genesis-tools") && (p.kind === "genesis-tools" || p.isGenesisTools === true)) {
            return true;
        }

        if (set.has("web") && (p.kind === "web" || p.isWebapp === true)) {
            return true;
        }

        if (set.has("apis") && p.kind === "api") {
            return true;
        }

        if (p.probeStatus === "pending" && (set.has("web") || set.has("apis"))) {
            return true;
        }

        return false;
    });
}

export type PortSortKey = "age" | "name" | "port";
export type PortSortDir = "asc" | "desc";

export function sortPorts(ports: PortInfo[], key: PortSortKey, dir: PortSortDir): PortInfo[] {
    const mult = dir === "asc" ? 1 : -1;
    return [...ports].sort((a, b) => {
        let cmp = 0;
        if (key === "port") {
            cmp = a.port - b.port || a.proto.localeCompare(b.proto);
        } else if (key === "name") {
            const an = (a.title ?? a.command).toLowerCase();
            const bn = (b.title ?? b.command).toLowerCase();
            cmp = an.localeCompare(bn) || a.port - b.port;
        } else {
            const am = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
            const bm = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY;
            cmp = am - bm || a.port - b.port;
        }

        return cmp * mult;
    });
}

export function splitVisibility(ports: PortInfo[]): {
    normal: PortInfo[];
    hidden: PortInfo[];
} {
    const normal: PortInfo[] = [];
    const hidden: PortInfo[] = [];

    for (const p of ports) {
        if (p.visibility === "system" || p.visibility === "junk") {
            hidden.push(p);
        } else {
            normal.push(p);
        }
    }

    return { normal, hidden };
}

/** Collapse tcp4/tcp6 pairs for one port (prefer IPv4). PURE for UI + server. */
export function collapseDualStack(ports: PortInfo[]): PortInfo[] {
    const byPort = new Map<number, PortInfo>();

    for (const p of ports) {
        const existing = byPort.get(p.port);
        if (!existing || (existing.proto === "tcp6" && p.proto === "tcp4")) {
            byPort.set(p.port, p);
        }
    }

    return [...byPort.values()];
}

/** Whether this port number is claimed in the registry (dashboard or service). */
export function isRegisteredPort(port: number): boolean {
    return registryEntryForPort(port) !== null;
}
