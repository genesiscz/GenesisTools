export const ESLOGGER_PATH = "/usr/bin/eslogger";

/**
 * The short names `eslogger --list-events` prints on macOS 26.3 (checked 2026-10-05). The same 104
 * names are every NOTIFY entry of `es_event_type_t` in the macOS 26.5 SDK. eslogger supports notify
 * events only, never AUTH events. The live list wins whenever `/usr/bin/eslogger` answers.
 */
export const KNOWN_EVENTS: readonly string[] = [
    "access",
    "authentication",
    "authorization_judgement",
    "authorization_petition",
    "btm_launch_item_add",
    "btm_launch_item_remove",
    "chdir",
    "chroot",
    "clone",
    "close",
    "copyfile",
    "create",
    "cs_invalidated",
    "deleteextattr",
    "dup",
    "exchangedata",
    "exec",
    "exit",
    "fcntl",
    "file_provider_materialize",
    "file_provider_update",
    "fork",
    "fsgetpath",
    "gatekeeper_user_override",
    "get_task",
    "get_task_inspect",
    "get_task_name",
    "get_task_read",
    "getattrlist",
    "getextattr",
    "iokit_open",
    "kextload",
    "kextunload",
    "link",
    "listextattr",
    "login_login",
    "login_logout",
    "lookup",
    "lw_session_lock",
    "lw_session_login",
    "lw_session_logout",
    "lw_session_unlock",
    "mmap",
    "mount",
    "mprotect",
    "od_attribute_set",
    "od_attribute_value_add",
    "od_attribute_value_remove",
    "od_create_group",
    "od_create_user",
    "od_delete_group",
    "od_delete_user",
    "od_disable_user",
    "od_enable_user",
    "od_group_add",
    "od_group_remove",
    "od_group_set",
    "od_modify_password",
    "open",
    "openssh_login",
    "openssh_logout",
    "proc_check",
    "proc_suspend_resume",
    "profile_add",
    "profile_remove",
    "pty_close",
    "pty_grant",
    "readdir",
    "readlink",
    "remote_thread_create",
    "remount",
    "rename",
    "screensharing_attach",
    "screensharing_detach",
    "searchfs",
    "setacl",
    "setattrlist",
    "setegid",
    "seteuid",
    "setextattr",
    "setflags",
    "setgid",
    "setmode",
    "setowner",
    "setregid",
    "setreuid",
    "settime",
    "setuid",
    "signal",
    "stat",
    "su",
    "sudo",
    "tcc_modify",
    "trace",
    "truncate",
    "uipc_bind",
    "uipc_connect",
    "unlink",
    "unmount",
    "utimes",
    "write",
    "xp_malware_detected",
    "xp_malware_remediated",
    "xpc_connect",
];

/**
 * `event_type` (an `es_event_type_t` number in every eslogger JSON line) to the short name. NOTIFY
 * values only, compiled from the macOS 26.5 SDK's ESTypes.h: the AUTH values in between never appear
 * in eslogger output. 146 and 147 arrived with macOS 15; 148 to 156 are reserved.
 */
export const EVENT_TYPE_NAMES: Readonly<Record<number, string>> = {
    9: "exec",
    10: "open",
    11: "fork",
    12: "close",
    13: "create",
    14: "exchangedata",
    15: "exit",
    16: "get_task",
    17: "kextload",
    18: "kextunload",
    19: "link",
    20: "mmap",
    21: "mprotect",
    22: "mount",
    23: "unmount",
    24: "iokit_open",
    25: "rename",
    26: "setattrlist",
    27: "setextattr",
    28: "setflags",
    29: "setmode",
    30: "setowner",
    31: "signal",
    32: "unlink",
    33: "write",
    35: "file_provider_materialize",
    37: "file_provider_update",
    39: "readlink",
    41: "truncate",
    43: "lookup",
    51: "chdir",
    53: "getattrlist",
    54: "stat",
    55: "access",
    57: "chroot",
    59: "utimes",
    61: "clone",
    62: "fcntl",
    64: "getextattr",
    66: "listextattr",
    68: "readdir",
    70: "deleteextattr",
    72: "fsgetpath",
    73: "dup",
    75: "settime",
    76: "uipc_bind",
    78: "uipc_connect",
    82: "setacl",
    83: "pty_grant",
    84: "pty_close",
    86: "proc_check",
    89: "searchfs",
    93: "proc_suspend_resume",
    94: "cs_invalidated",
    95: "get_task_name",
    96: "trace",
    97: "remote_thread_create",
    99: "remount",
    101: "get_task_read",
    102: "get_task_inspect",
    103: "setuid",
    104: "setgid",
    105: "seteuid",
    106: "setegid",
    107: "setreuid",
    108: "setregid",
    110: "copyfile",
    111: "authentication",
    112: "xp_malware_detected",
    113: "xp_malware_remediated",
    114: "lw_session_login",
    115: "lw_session_logout",
    116: "lw_session_lock",
    117: "lw_session_unlock",
    118: "screensharing_attach",
    119: "screensharing_detach",
    120: "openssh_login",
    121: "openssh_logout",
    122: "login_login",
    123: "login_logout",
    124: "btm_launch_item_add",
    125: "btm_launch_item_remove",
    126: "profile_add",
    127: "profile_remove",
    128: "su",
    129: "authorization_petition",
    130: "authorization_judgement",
    131: "sudo",
    132: "od_group_add",
    133: "od_group_remove",
    134: "od_group_set",
    135: "od_modify_password",
    136: "od_disable_user",
    137: "od_enable_user",
    138: "od_attribute_value_add",
    139: "od_attribute_value_remove",
    140: "od_attribute_set",
    141: "od_create_user",
    142: "od_create_group",
    143: "od_delete_user",
    144: "od_delete_group",
    145: "xpc_connect",
    146: "gatekeeper_user_override",
    147: "tcc_modify",
};

export function eventNameForType(type: number): string {
    return EVENT_TYPE_NAMES[type] ?? `event_type_${type}`;
}

export interface EventCategory {
    description: string;
    events: readonly string[];
}

export const EVENT_CATEGORIES: Readonly<Record<string, EventCategory>> = {
    process: { description: "process start, fork and exit", events: ["exec", "fork", "exit"] },
    file: {
        description: "file opens, writes and changes (high volume)",
        events: ["open", "close", "create", "write", "unlink", "rename"],
    },
    ipc: {
        description: "Unix-domain sockets and XPC connections (eslogger has no TCP/IP events)",
        events: ["uipc_bind", "uipc_connect", "xpc_connect"],
    },
    security: {
        description: "logins as another user, uid changes, malware and Gatekeeper verdicts",
        events: [
            "authentication",
            "sudo",
            "su",
            "setuid",
            "setgid",
            "seteuid",
            "setegid",
            "setreuid",
            "setregid",
            "xp_malware_detected",
            "xp_malware_remediated",
            "gatekeeper_user_override",
        ],
    },
    session: {
        description: "login window, screen sharing, SSH and login(1) sessions",
        events: [
            "lw_session_login",
            "lw_session_logout",
            "lw_session_lock",
            "lw_session_unlock",
            "screensharing_attach",
            "screensharing_detach",
            "openssh_login",
            "openssh_logout",
            "login_login",
            "login_logout",
        ],
    },
    auth: {
        description: "authorization rights and privacy (TCC) changes",
        events: ["authorization_petition", "authorization_judgement", "tcc_modify"],
    },
    persistence: {
        description: "launch items and configuration profiles added or removed",
        events: ["btm_launch_item_add", "btm_launch_item_remove", "profile_add", "profile_remove"],
    },
};

export const POPULAR_EVENTS: readonly string[] = ["exec", "fork", "exit", "open", "write", "authentication", "sudo"];

export interface EventSelectionInput {
    events?: readonly string[];
    categories?: readonly string[];
    includeFork?: boolean;
    /** What this Mac's eslogger accepts; an event outside it is reported, never passed on. */
    supported: readonly string[];
}

export interface EventSelection {
    events: string[];
    /** Names given as events that this Mac's eslogger does not accept. */
    unknownEvents: string[];
    unknownCategories: string[];
    /** Members of a chosen category that this Mac's eslogger does not accept. They are left out, not refused. */
    skippedEvents: string[];
    /** True when `includeFork` added `fork` beside `exec`. */
    addedFork: boolean;
}

/** Comma- or space-separated names from a flag value: `"exec, fork"` and `"exec fork"` both work. */
export function splitNames(value: string | undefined): string[] {
    if (!value) {
        return [];
    }

    return value
        .split(/[,\s]+/)
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0);
}

export function resolveEventSelection(input: EventSelectionInput): EventSelection {
    const supported = new Set(input.supported);
    const unknownCategories: string[] = [];
    const fromCategories: string[] = [];

    for (const category of input.categories ?? []) {
        if (!Object.hasOwn(EVENT_CATEGORIES, category)) {
            unknownCategories.push(category);
            continue;
        }

        fromCategories.push(...EVENT_CATEGORIES[category].events);
    }

    const named = input.events ?? [];
    const events = [...new Set([...fromCategories, ...named])];
    const unknownEvents = [...new Set(named)].filter((name) => !supported.has(name));
    const skippedEvents = [...new Set(fromCategories)].filter((name) => !supported.has(name) && !named.includes(name));
    let addedFork = false;

    if (input.includeFork && events.includes("exec") && !events.includes("fork") && supported.has("fork")) {
        events.push("fork");
        addedFork = true;
    }

    return {
        events: events.filter((name) => supported.has(name)),
        unknownEvents,
        unknownCategories,
        skippedEvents,
        addedFork,
    };
}

/** The stdout of `eslogger --list-events`: one short name per line. */
export function parseEventList(stdout: string): string[] {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[a-z][a-z0-9_]*$/.test(line));
}

export interface SupportedEvents {
    events: string[];
    source: "eslogger" | "built-in";
}

/**
 * Ask this Mac's eslogger which events it supports (no root needed, about 10 ms), so a new or
 * renamed event in a later macOS is right without a code change. Falls back to {@link KNOWN_EVENTS}
 * when eslogger is missing (macOS 12 and older) or prints nothing usable.
 */
export function supportedEvents(listEvents: () => string | null): SupportedEvents {
    const stdout = listEvents();
    const events = stdout ? parseEventList(stdout) : [];

    if (events.length === 0) {
        return { events: [...KNOWN_EVENTS], source: "built-in" };
    }

    return { events, source: "eslogger" };
}
