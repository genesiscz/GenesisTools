import { constants } from "node:os";
import {
    auditTokenField,
    booleanAt,
    type EsMessage,
    eventNameOf,
    eventPayload,
    isRecord,
    numberAt,
    textAt,
    valueAtPath,
} from "./message";

const SIGNAL_NAMES = new Map<number, string>(
    Object.entries(constants.signals).map(([name, number]): [number, string] => [number, name])
);

/** `es_authentication_type_t` in ESTypes.h. */
const AUTHENTICATION_TYPES = ["od", "touchid", "token", "auto_unlock"];

/** Kernel `fflag` bits of an open: FREAD and FWRITE. */
const FREAD = 0x1;
const FWRITE = 0x2;

/** Shell-style quoting for display: plain words stay bare. */
export function shellQuote(arg: string): string {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** An `es_file_t` as a path; a truncated path is marked, since eslogger cut it. */
function fileAt(payload: unknown, path: string): string | undefined {
    const filePath = textAt(payload, `${path}.path`);

    if (filePath === undefined) {
        return undefined;
    }

    return booleanAt(payload, `${path}.path_truncated`) ? `${filePath}…` : filePath;
}

/** A rename or create destination: either an existing file, or a directory plus a new name. */
function destinationOf(payload: Record<string, unknown>): string | undefined {
    const existing = fileAt(payload, "destination.existing_file");

    if (existing) {
        return existing;
    }

    const dir = fileAt(payload, "destination.new_path.dir");
    const name = textAt(payload, "destination.new_path.filename");

    if (dir && name) {
        return `${dir.replace(/\/$/, "")}/${name}`;
    }

    return name ?? dir;
}

/** `uid` unions such as sudo's `from_uid`: a number, or `{ uid: n }`. */
function uidAt(payload: unknown, path: string): number | undefined {
    return numberAt(payload, path) ?? numberAt(payload, `${path}.uid`);
}

function outcome(payload: unknown): string {
    const success = booleanAt(payload, "success");

    if (success === undefined) {
        return "";
    }

    return success ? "ok" : "FAILED";
}

/** `es_event_exit_t.stat` is a wait(2) status. */
export function describeExitStatus(stat: number): string {
    const low = stat & 0x7f;

    if (low === 0) {
        return `exit code ${(stat >> 8) & 0xff}`;
    }

    const name = SIGNAL_NAMES.get(low);
    return `killed by ${name ?? `signal ${low}`}`;
}

function describeOpenFlags(fflag: number | undefined): string {
    if (fflag === undefined) {
        return "";
    }

    const read = (fflag & FREAD) !== 0;
    const write = (fflag & FWRITE) !== 0;

    if (read && write) {
        return "read+write";
    }

    return write ? "write" : "read";
}

function join(...parts: (string | undefined)[]): string {
    return parts.filter((part) => part !== undefined && part.length > 0).join(" ");
}

function userChange(payload: unknown): string {
    const from = textAt(payload, "from_username") ?? uidAt(payload, "from_uid")?.toString();
    const to = textAt(payload, "to_username") ?? uidAt(payload, "to_uid")?.toString();

    if (!from && !to) {
        return "";
    }

    return `${from ?? "?"} → ${to ?? "?"}`;
}

type DetailFormatter = (payload: Record<string, unknown>) => string;

const DETAIL: Record<string, DetailFormatter> = {
    exec: (payload) => {
        const target = fileAt(payload, "target.executable") ?? textAt(payload, "dyld_exec_path");
        const args = valueAtPath(payload, "args");
        const rest = Array.isArray(args)
            ? args
                  .slice(1)
                  .filter((arg) => typeof arg === "string")
                  .map(shellQuote)
                  .join(" ")
            : "";
        const cwd = fileAt(payload, "cwd");
        return join("→", target, rest, cwd ? `(cwd ${cwd})` : undefined);
    },
    fork: (payload) => {
        const child = auditTokenField(valueAtPath(payload, "child.audit_token"), "pid");
        return child === undefined ? "" : `→ child pid ${child}`;
    },
    exit: (payload) => {
        const stat = numberAt(payload, "stat");
        return stat === undefined ? "" : describeExitStatus(stat);
    },
    open: (payload) => join(describeOpenFlags(numberAt(payload, "fflag")), fileAt(payload, "file")),
    close: (payload) => join(fileAt(payload, "target"), booleanAt(payload, "modified") ? "(modified)" : undefined),
    create: (payload) => destinationOf(payload) ?? "",
    rename: (payload) => join(fileAt(payload, "source"), "→", destinationOf(payload)),
    link: (payload) => {
        const dir = fileAt(payload, "target_dir");
        const name = textAt(payload, "target_filename");
        return join(fileAt(payload, "source"), "→", dir && name ? `${dir.replace(/\/$/, "")}/${name}` : dir);
    },
    copyfile: (payload) => {
        const dir = fileAt(payload, "target_dir");
        const name = textAt(payload, "target_name");
        const target = fileAt(payload, "target_file") ?? (dir && name ? `${dir.replace(/\/$/, "")}/${name}` : dir);
        return join(fileAt(payload, "source"), "→", target);
    },
    signal: (payload) => {
        const sig = numberAt(payload, "sig");
        const name = sig === undefined ? undefined : (SIGNAL_NAMES.get(sig) ?? `signal ${sig}`);
        const pid = auditTokenField(valueAtPath(payload, "target.audit_token"), "pid");
        return join(name, "→", pid === undefined ? undefined : `pid ${pid}`, fileAt(payload, "target.executable"));
    },
    authentication: (payload) => {
        const type = numberAt(payload, "type");
        const typeName = type === undefined ? undefined : (AUTHENTICATION_TYPES[type] ?? `type ${type}`);
        return join(outcome(payload), typeName);
    },
    sudo: (payload) => {
        const command = textAt(payload, "command");
        const who = userChange(payload);
        return join(outcome(payload), command && who ? `${who}:` : who, command);
    },
    su: (payload) => join(outcome(payload), userChange(payload)),
    setuid: (payload) => join("uid", numberAt(payload, "uid")?.toString()),
    seteuid: (payload) => join("euid", numberAt(payload, "euid")?.toString()),
    setgid: (payload) => join("gid", numberAt(payload, "gid")?.toString()),
    setegid: (payload) => join("egid", numberAt(payload, "egid")?.toString()),
    uipc_connect: (payload) => fileAt(payload, "file") ?? "",
    uipc_bind: (payload) => {
        const dir = fileAt(payload, "dir");
        const name = textAt(payload, "filename");
        return dir && name ? `${dir.replace(/\/$/, "")}/${name}` : (dir ?? "");
    },
    xpc_connect: (payload) => textAt(payload, "service_name") ?? "",
    tcc_modify: (payload) => join(textAt(payload, "service"), textAt(payload, "identity")),
    btm_launch_item_add: (payload) =>
        textAt(payload, "item.item_url") ?? textAt(payload, "executable_path") ?? textAt(payload, "item.app_url") ?? "",
    btm_launch_item_remove: (payload) => textAt(payload, "item.item_url") ?? textAt(payload, "item.app_url") ?? "",
    login_login: (payload) => join(outcome(payload), textAt(payload, "username")),
    login_logout: (payload) => textAt(payload, "username") ?? "",
    lw_session_login: (payload) => textAt(payload, "username") ?? "",
    lw_session_logout: (payload) => textAt(payload, "username") ?? "",
    lw_session_lock: (payload) => textAt(payload, "username") ?? "",
    lw_session_unlock: (payload) => textAt(payload, "username") ?? "",
    openssh_login: (payload) => join(outcome(payload), textAt(payload, "username"), textAt(payload, "source_address")),
    openssh_logout: (payload) => join(textAt(payload, "username"), textAt(payload, "source_address")),
    screensharing_attach: (payload) =>
        join(outcome(payload), textAt(payload, "authentication_username"), textAt(payload, "source_address")),
    xp_malware_detected: (payload) => join(textAt(payload, "malware_identifier"), textAt(payload, "detected_path")),
    gatekeeper_user_override: (payload) => fileAt(payload, "file.file") ?? textAt(payload, "file.file_path") ?? "",
};

/** The fields most other events carry, tried in order, so `stat`, `readdir`, `mmap` and friends still show a path. */
const GENERIC_PATHS = ["target", "file", "source"];

function genericDetail(payload: Record<string, unknown>): string {
    for (const key of GENERIC_PATHS) {
        const path = fileAt(payload, key) ?? fileAt(payload, `${key}.executable`);

        if (path) {
            return path;
        }
    }

    return "";
}

export interface FormatOptions {
    /** IANA zone for the time column; defaults to the local zone. Tests pin it. */
    timeZone?: string;
}

/** Building an `Intl.DateTimeFormat` costs far more than using one, and a capture formats every event. */
const timeFormatters = new Map<string | undefined, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
    const cached = timeFormatters.get(timeZone);
    if (cached) {
        return cached;
    }

    const created = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hour12: false,
        timeZone,
    });
    timeFormatters.set(timeZone, created);
    return created;
}

function formatTime(iso: string | undefined, timeZone: string | undefined): string {
    const date = iso ? new Date(iso) : undefined;

    if (!date || Number.isNaN(date.getTime())) {
        return "--:--:--.---";
    }

    return timeFormatter(timeZone).format(date);
}

/**
 * One line per event: local time, short name, the acting process (pid and executable), then what the
 * event did. Never throws: a field eslogger left out shows as missing instead of failing the line.
 */
export function formatEvent(message: EsMessage, options: FormatOptions = {}): string {
    const name = eventNameOf(message);
    const payload = eventPayload(message);
    const process = isRecord(message.process) ? message.process : {};
    const pid = auditTokenField(process.audit_token, "pid");
    const executable = fileAt(process, "executable") ?? "?";
    const detail = (Object.hasOwn(DETAIL, name) ? DETAIL[name] : genericDetail)(payload);

    return join(
        formatTime(textAt(message, "time"), options.timeZone),
        name.padEnd(12),
        `pid ${String(pid ?? "?").padEnd(6)}`,
        executable,
        detail
    );
}
