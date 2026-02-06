import { spawn, ChildProcess } from "child_process";
import { Command } from "commander";
import { select, checkbox } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger, { consoleLog } from "@app/logger";
import { handleReadmeFlag } from "@app/utils/readme";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

// ============================================================================
// TypeScript Types based on ESLogger Swift types
// See: https://github.com/nubcoxyz/ESLogger/blob/main/Sources/ESLogger/ESFTypes.swift
// ============================================================================

interface AuditToken {
    pid: number;
    pidversion: number;
    auid: number;
    euid: number;
    egid: number;
    ruid: number;
    rgid: number;
}

interface ESFile {
    path: string;
    path_truncated?: boolean;
    stat?: {
        st_dev: number;
        st_ino: number;
        st_mode: number;
        st_nlink: number;
        st_uid: number;
        st_gid: number;
        st_size: number;
        st_atime: string;
        st_mtime: string;
        st_ctime: string;
    };
}

interface ESProcess {
    audit_token: AuditToken;
    ppid: number;
    original_ppid: number;
    group_id: number;
    session_id: number;
    codesigning_flags: number;
    is_platform_binary: boolean;
    is_es_client: boolean;
    cdhash: string;
    signing_id?: string;
    team_id?: string;
    executable: ESFile;
    tty?: ESFile;
    start_time: string;
    responsible_audit_token: AuditToken;
    parent_audit_token?: AuditToken;
}

interface ESEvent_exec {
    target: ESFile;
    args?: string[];
    env?: string[];
    cwd?: ESFile;
    script?: ESFile;
}

interface ESEvent_fork {
    child: ESProcess;
}

interface ESEvent_open {
    fflag: number;
    file: ESFile;
}

interface ESEvent_close {
    modified: boolean;
    target: ESFile;
    was_mapped_writable?: boolean;
}

interface ESEvent_write {
    target: ESFile;
}

interface ESEvent_exit {
    stat: number;
}

interface ESEvent_rename {
    source: ESFile;
    destination_type: string;
    destination: {
        existing_file?: ESFile;
        new_path?: {
            dir: ESFile;
            filename: string;
        };
    };
}

interface ESEvent_authentication {
    success: boolean;
    type: string;
}

interface ESEvent_sudo {
    success?: boolean;
    reject_info?: string;
    has_tty?: boolean;
    command?: string;
}

interface ESEvent_signal {
    sig: number;
    target: ESProcess;
}

interface ESLoggerEvent {
    event_type: string;
    process: ESProcess;
    event:
        | ESEvent_exec
        | ESEvent_fork
        | ESEvent_open
        | ESEvent_close
        | ESEvent_write
        | ESEvent_exit
        | ESEvent_authentication
        | ESEvent_sudo
        | ESEvent_signal
        | ESEvent_rename
        | any;
}

// ============================================================================
// Event Type Enum Mapping (from Swift ESLogger EventType enum)
// ============================================================================

const EVENT_TYPE_MAP: Record<number, string> = {
    0: "ES_EVENT_TYPE_AUTH_EXEC",
    1: "ES_EVENT_TYPE_AUTH_OPEN",
    2: "ES_EVENT_TYPE_AUTH_KEXTLOAD",
    3: "ES_EVENT_TYPE_AUTH_MMAP",
    4: "ES_EVENT_TYPE_AUTH_MPROTECT",
    5: "ES_EVENT_TYPE_AUTH_MOUNT",
    6: "ES_EVENT_TYPE_AUTH_RENAME",
    7: "ES_EVENT_TYPE_AUTH_SIGNAL",
    8: "ES_EVENT_TYPE_AUTH_UNLINK",
    9: "ES_EVENT_TYPE_NOTIFY_EXEC",
    10: "ES_EVENT_TYPE_NOTIFY_OPEN",
    11: "ES_EVENT_TYPE_NOTIFY_FORK",
    12: "ES_EVENT_TYPE_NOTIFY_CLOSE",
    13: "ES_EVENT_TYPE_NOTIFY_CREATE",
    14: "ES_EVENT_TYPE_NOTIFY_EXCHANGEDATA",
    15: "ES_EVENT_TYPE_NOTIFY_EXIT",
    16: "ES_EVENT_TYPE_NOTIFY_GET_TASK",
    17: "ES_EVENT_TYPE_NOTIFY_KEXTLOAD",
    18: "ES_EVENT_TYPE_NOTIFY_KEXTUNLOAD",
    19: "ES_EVENT_TYPE_NOTIFY_LINK",
    20: "ES_EVENT_TYPE_NOTIFY_MMAP",
    21: "ES_EVENT_TYPE_NOTIFY_MPROTECT",
    22: "ES_EVENT_TYPE_NOTIFY_MOUNT",
    23: "ES_EVENT_TYPE_NOTIFY_UNMOUNT",
    24: "ES_EVENT_TYPE_NOTIFY_IOKIT_OPEN",
    25: "ES_EVENT_TYPE_NOTIFY_RENAME",
    26: "ES_EVENT_TYPE_NOTIFY_SETATTRLIST",
    27: "ES_EVENT_TYPE_NOTIFY_SETEXTATTR",
    28: "ES_EVENT_TYPE_NOTIFY_SETFLAGS",
    29: "ES_EVENT_TYPE_NOTIFY_SETMODE",
    30: "ES_EVENT_TYPE_NOTIFY_SETOWNER",
    31: "ES_EVENT_TYPE_NOTIFY_SIGNAL",
    32: "ES_EVENT_TYPE_NOTIFY_UNLINK",
    33: "ES_EVENT_TYPE_NOTIFY_WRITE",
    34: "ES_EVENT_TYPE_AUTH_FILE_PROVIDER_MATERIALIZE",
    35: "ES_EVENT_TYPE_NOTIFY_FILE_PROVIDER_MATERIALIZE",
    36: "ES_EVENT_TYPE_AUTH_FILE_PROVIDER_UPDATE",
    37: "ES_EVENT_TYPE_NOTIFY_FILE_PROVIDER_UPDATE",
    38: "ES_EVENT_TYPE_AUTH_READLINK",
    39: "ES_EVENT_TYPE_NOTIFY_READLINK",
    40: "ES_EVENT_TYPE_AUTH_TRUNCATE",
    41: "ES_EVENT_TYPE_NOTIFY_TRUNCATE",
    42: "ES_EVENT_TYPE_AUTH_LINK",
    43: "ES_EVENT_TYPE_NOTIFY_LOOKUP",
    44: "ES_EVENT_TYPE_AUTH_CREATE",
    45: "ES_EVENT_TYPE_AUTH_SETATTRLIST",
    46: "ES_EVENT_TYPE_AUTH_SETEXTATTR",
    47: "ES_EVENT_TYPE_AUTH_SETFLAGS",
    48: "ES_EVENT_TYPE_AUTH_SETMODE",
    49: "ES_EVENT_TYPE_AUTH_SETOWNER",
    50: "ES_EVENT_TYPE_AUTH_CHDIR",
    51: "ES_EVENT_TYPE_NOTIFY_CHDIR",
    52: "ES_EVENT_TYPE_AUTH_GETATTRLIST",
    53: "ES_EVENT_TYPE_NOTIFY_GETATTRLIST",
    54: "ES_EVENT_TYPE_NOTIFY_STAT",
    55: "ES_EVENT_TYPE_NOTIFY_ACCESS",
    56: "ES_EVENT_TYPE_AUTH_CHROOT",
    57: "ES_EVENT_TYPE_NOTIFY_CHROOT",
    58: "ES_EVENT_TYPE_AUTH_UTIMES",
    59: "ES_EVENT_TYPE_NOTIFY_UTIMES",
    60: "ES_EVENT_TYPE_AUTH_CLONE",
    61: "ES_EVENT_TYPE_NOTIFY_CLONE",
    62: "ES_EVENT_TYPE_NOTIFY_FCNTL",
    63: "ES_EVENT_TYPE_AUTH_GETEXTATTR",
    64: "ES_EVENT_TYPE_NOTIFY_GETEXTATTR",
    65: "ES_EVENT_TYPE_AUTH_LISTEXTATTR",
    66: "ES_EVENT_TYPE_NOTIFY_LISTEXTATTR",
    67: "ES_EVENT_TYPE_AUTH_READDIR",
    68: "ES_EVENT_TYPE_NOTIFY_READDIR",
    69: "ES_EVENT_TYPE_AUTH_DELETEEXTATTR",
    70: "ES_EVENT_TYPE_NOTIFY_DELETEEXTATTR",
    71: "ES_EVENT_TYPE_AUTH_FSGETPATH",
    72: "ES_EVENT_TYPE_NOTIFY_FSGETPATH",
    73: "ES_EVENT_TYPE_NOTIFY_DUP",
    74: "ES_EVENT_TYPE_AUTH_SETTIME",
    75: "ES_EVENT_TYPE_NOTIFY_SETTIME",
    76: "ES_EVENT_TYPE_NOTIFY_UIPC_BIND",
    77: "ES_EVENT_TYPE_AUTH_UIPC_BIND",
    78: "ES_EVENT_TYPE_NOTIFY_UIPC_CONNECT",
    79: "ES_EVENT_TYPE_AUTH_UIPC_CONNECT",
    80: "ES_EVENT_TYPE_AUTH_EXCHANGEDATA",
    81: "ES_EVENT_TYPE_AUTH_SETACL",
    82: "ES_EVENT_TYPE_NOTIFY_SETACL",
    83: "ES_EVENT_TYPE_NOTIFY_PTY_GRANT",
    84: "ES_EVENT_TYPE_NOTIFY_PTY_CLOSE",
    85: "ES_EVENT_TYPE_AUTH_PROC_CHECK",
    86: "ES_EVENT_TYPE_NOTIFY_PROC_CHECK",
    87: "ES_EVENT_TYPE_AUTH_GET_TASK",
    88: "ES_EVENT_TYPE_AUTH_SEARCHFS",
    89: "ES_EVENT_TYPE_NOTIFY_SEARCHFS",
    90: "ES_EVENT_TYPE_AUTH_FCNTL",
    91: "ES_EVENT_TYPE_AUTH_IOKIT_OPEN",
    92: "ES_EVENT_TYPE_AUTH_PROC_SUSPEND_RESUME",
    93: "ES_EVENT_TYPE_NOTIFY_PROC_SUSPEND_RESUME",
    94: "ES_EVENT_TYPE_NOTIFY_CS_INVALIDATED",
    95: "ES_EVENT_TYPE_NOTIFY_GET_TASK_NAME",
    96: "ES_EVENT_TYPE_NOTIFY_TRACE",
    97: "ES_EVENT_TYPE_NOTIFY_REMOTE_THREAD_CREATE",
    98: "ES_EVENT_TYPE_AUTH_REMOUNT",
    99: "ES_EVENT_TYPE_NOTIFY_REMOUNT",
    100: "ES_EVENT_TYPE_AUTH_GET_TASK_READ",
    101: "ES_EVENT_TYPE_NOTIFY_GET_TASK_READ",
    102: "ES_EVENT_TYPE_NOTIFY_GET_TASK_INSPECT",
    103: "ES_EVENT_TYPE_NOTIFY_SETUID",
    104: "ES_EVENT_TYPE_NOTIFY_SETGID",
    105: "ES_EVENT_TYPE_NOTIFY_SETEUID",
    106: "ES_EVENT_TYPE_NOTIFY_SETEGID",
    107: "ES_EVENT_TYPE_NOTIFY_SETREUID",
    108: "ES_EVENT_TYPE_NOTIFY_SETREGID",
    109: "ES_EVENT_TYPE_AUTH_COPYFILE",
    110: "ES_EVENT_TYPE_NOTIFY_COPYFILE",
    111: "ES_EVENT_TYPE_NOTIFY_AUTHENTICATION",
    112: "ES_EVENT_TYPE_NOTIFY_XP_MALWARE_DETECTED",
    113: "ES_EVENT_TYPE_NOTIFY_XP_MALWARE_REMEDIATED",
    114: "ES_EVENT_TYPE_NOTIFY_LW_SESSION_LOGIN",
    115: "ES_EVENT_TYPE_NOTIFY_LW_SESSION_LOGOUT",
    116: "ES_EVENT_TYPE_NOTIFY_LW_SESSION_LOCK",
    117: "ES_EVENT_TYPE_NOTIFY_LW_SESSION_UNLOCK",
    118: "ES_EVENT_TYPE_NOTIFY_SCREENSHARING_ATTACH",
    119: "ES_EVENT_TYPE_NOTIFY_SCREENSHARING_DETACH",
    120: "ES_EVENT_TYPE_NOTIFY_OPENSSH_LOGIN",
    121: "ES_EVENT_TYPE_NOTIFY_OPENSSH_LOGOUT",
    122: "ES_EVENT_TYPE_NOTIFY_LOGIN_LOGIN",
    123: "ES_EVENT_TYPE_NOTIFY_LOGIN_LOGOUT",
    124: "ES_EVENT_TYPE_NOTIFY_BTM_LAUNCH_ITEM_ADD",
    125: "ES_EVENT_TYPE_NOTIFY_BTM_LAUNCH_ITEM_REMOVE",
    126: "ES_EVENT_TYPE_NOTIFY_PROFILE_ADD",
    127: "ES_EVENT_TYPE_NOTIFY_PROFILE_REMOVE",
    128: "ES_EVENT_TYPE_NOTIFY_SU",
    129: "ES_EVENT_TYPE_NOTIFY_AUTHORIZATION_PETITION",
    130: "ES_EVENT_TYPE_NOTIFY_AUTHORIZATION_JUDGEMENT",
    131: "ES_EVENT_TYPE_NOTIFY_SUDO",
    132: "ES_EVENT_TYPE_NOTIFY_OD_GROUP_ADD",
    133: "ES_EVENT_TYPE_NOTIFY_OD_GROUP_REMOVE",
    134: "ES_EVENT_TYPE_NOTIFY_OD_GROUP_SET",
    135: "ES_EVENT_TYPE_NOTIFY_OD_MODIFY_PASSWORD",
    136: "ES_EVENT_TYPE_NOTIFY_OD_DISABLE_USER",
    137: "ES_EVENT_TYPE_NOTIFY_OD_ENABLE_USER",
    138: "ES_EVENT_TYPE_NOTIFY_OD_ATTRIBUTE_VALUE_ADD",
    139: "ES_EVENT_TYPE_NOTIFY_OD_ATTRIBUTE_VALUE_REMOVE",
    140: "ES_EVENT_TYPE_NOTIFY_OD_ATTRIBUTE_SET",
    141: "ES_EVENT_TYPE_NOTIFY_OD_CREATE_USER",
    142: "ES_EVENT_TYPE_NOTIFY_OD_CREATE_GROUP",
    143: "ES_EVENT_TYPE_NOTIFY_OD_DELETE_USER",
    144: "ES_EVENT_TYPE_NOTIFY_OD_DELETE_GROUP",
    145: "ES_EVENT_TYPE_NOTIFY_XPC_CONNECT",
    146: "ES_EVENT_TYPE_LAST",
    90210: "ES_EVENT_TYPE_NOTIFY_NETWORKFLOW",
};

/**
 * Converts numeric event_type to event type string name
 */
function getEventTypeName(eventType: string | number): string {
    if (typeof eventType === "number") {
        return EVENT_TYPE_MAP[eventType] || `UNKNOWN_EVENT_TYPE_${eventType}`;
    }
    // If it's already a string, return as-is
    return eventType;
}

/**
 * Extracts short event name from full event type name (e.g., "ES_EVENT_TYPE_NOTIFY_EXEC" -> "exec")
 * This mimics the Swift shortName() function which splits by "_" and takes elements from index 4 onwards
 */
function getShortEventName(eventTypeName: string): string {
    const parts = eventTypeName.toLowerCase().split("_");
    // Take elements from index 4 onwards (skipping "ES", "EVENT", "TYPE", and "AUTH"/"NOTIFY")
    if (parts.length > 4) {
        return parts.slice(4).join("_");
    }
    // Fallback: just remove the prefix
    return eventTypeName.toLowerCase().replace(/^es_event_type_(auth_|notify_)/, "");
}

// ============================================================================
// Event Type Categories (using short aliases)
// ============================================================================

const EVENT_CATEGORIES = {
    process: ["exec", "fork", "exit"],
    file: ["open", "close", "create", "write", "unlink", "rename"],
    network: ["uipc_bind", "uipc_connect"],
    security: ["authentication", "sudo", "su", "setuid", "setgid", "seteuid", "setegid", "xp_malware_detected"],
    session: [
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
    auth: ["authorization_judgement", "authorization_petition", "tcc_modify"],
};

// All available events from eslogger --list-events
const ALL_EVENTS = [
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

// ============================================================================
// Event Filtering
// ============================================================================

/**
 * Evaluate a JSON path expression against an event object
 * Supports basic dot notation and regex matching
 * Example: '.event.fork.child.executable.path == ".*Cursor.*"'
 */
function evaluateFilterExpression(event: ESLoggerEvent, expression: string): boolean {
    try {
        // Parse expression like: '.event.fork.child.executable.path == ".*Cursor.*"'
        const match = expression.trim().match(/^([^=!<>~]+)\s*([=!<>~]+)\s*(.+)$/);
        if (!match) {
            consoleLog.warn(`Invalid filter expression: ${expression}`);
            return true; // Don't filter if expression is invalid
        }

        const [_, path, operator, value] = match;
        const actualValue = getValueByPath(event, path.trim());

        // Remove quotes from the expected value
        const expectedValue = value.trim().replace(/^["']|["']$/g, "");

        switch (operator) {
            case "==":
            case "=":
                // Check if expectedValue contains regex special characters
                if (isRegexPattern(expectedValue)) {
                    try {
                        const regex = new RegExp(expectedValue);
                        return regex.test(String(actualValue || ""));
                    } catch (regexError) {
                        consoleLog.warn(`Invalid regex pattern "${expectedValue}": ${regexError}`);
                        return false;
                    }
                }
                return String(actualValue || "") === expectedValue;

            case "!=":
                if (isRegexPattern(expectedValue)) {
                    try {
                        const regex = new RegExp(expectedValue);
                        return !regex.test(String(actualValue || ""));
                    } catch (regexError) {
                        consoleLog.warn(`Invalid regex pattern "${expectedValue}": ${regexError}`);
                        return true;
                    }
                }
                return String(actualValue || "") !== expectedValue;

            case "=~":
                try {
                    const regex = new RegExp(expectedValue);
                    return regex.test(String(actualValue || ""));
                } catch (regexError) {
                    consoleLog.warn(`Invalid regex pattern "${expectedValue}": ${regexError}`);
                    return false;
                }

            case "!~":
                try {
                    const negRegex = new RegExp(expectedValue);
                    return !negRegex.test(String(actualValue || ""));
                } catch (regexError) {
                    consoleLog.warn(`Invalid regex pattern "${expectedValue}": ${regexError}`);
                    return true;
                }

            default:
                consoleLog.warn(`Unsupported operator: ${operator}`);
                return true;
        }
    } catch (error) {
        consoleLog.warn(`Error evaluating filter expression "${expression}": ${error}`);
        return true; // Don't filter on error
    }
}

/**
 * Get value from object using dot notation path
 * Example: getValueByPath(event, '.event.fork.child.executable.path')
 */
function getValueByPath(obj: any, path: string): any {
    // Remove leading dot if present
    const cleanPath = path.replace(/^\./, "");

    // Split by dots, but handle escaped dots if needed
    const parts = cleanPath.split(".");

    let current = obj;
    for (const part of parts) {
        if (current == null) return undefined;
        current = current[part];
    }

    return current;
}

/**
 * Check if a string contains regex special characters that indicate it should be treated as a regex pattern
 */
function isRegexPattern(str: string): boolean {
    // Check for common regex special characters
    // Note: * is included but must be properly positioned (not at start unless escaped)
    const regexChars = /[.*+?^${}()|[\]\\]/;
    return regexChars.test(str);
}

// ============================================================================
// Event Formatters
// ============================================================================

function formatExecEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const execEvent = event.event as ESEvent_exec;
    const args = execEvent.args ? execEvent.args.join(" ") : "";
    const cwd = execEvent.cwd?.path || "N/A";
    return (
        `[exec] PID: ${proc.audit_token.pid.toString().padEnd(6)} ` +
        `PPID: ${proc.ppid.toString().padEnd(6)} ` +
        `UID: ${proc.audit_token.euid.toString().padEnd(5)} ` +
        `CWD: ${cwd.padEnd(10)} ` +
        `${proc.executable.path} ${args}`
    );
}

function formatForkEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const forkEvent = event.event as ESEvent_fork | any;

    // Fork events from eslogger: process field contains the child process
    // Parent info is in parent_audit_token or ppid
    const childPid = proc.audit_token.pid;
    const parentPid = proc.parent_audit_token?.pid || proc.ppid;

    // Try to get child info from event.child if available (for API compatibility)
    // Otherwise use process field (which is how eslogger actually structures it)
    const childPidDisplay = forkEvent?.child?.audit_token?.pid || childPid;

    return (
        `[FORK] Parent PID: ${parentPid.toString().padEnd(6)} ` +
        `Child PID: ${childPidDisplay.toString().padEnd(6)} ` +
        `${proc.executable.path}`
    );
}

function formatOpenEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const openEvent = event.event as ESEvent_open;

    return (
        `[OPEN] PID: ${proc.audit_token.pid.toString().padEnd(6)} ` +
        `File: ${openEvent.file.path} ` +
        `by ${proc.executable.path}`
    );
}

function formatCloseEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const closeEvent = event.event as ESEvent_close;

    return (
        `[CLOSE] PID: ${proc.audit_token.pid.toString().padEnd(6)} ` +
        `Modified: ${closeEvent.modified ? "YES" : "NO"} ` +
        `File: ${closeEvent.target.path}`
    );
}

function formatWriteEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const writeEvent = event.event as ESEvent_write;

    return (
        `[WRITE] PID: ${proc.audit_token.pid.toString().padEnd(6)} ` +
        `File: ${writeEvent.target.path} ` +
        `by ${proc.executable.path}`
    );
}

function formatRenameEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const renameEvent = event.event as ESEvent_rename;

    let dest = "";
    if (renameEvent.destination.existing_file) {
        dest = renameEvent.destination.existing_file.path;
    } else if (renameEvent.destination.new_path) {
        dest = `${renameEvent.destination.new_path.dir.path}/${renameEvent.destination.new_path.filename}`;
    }

    return (
        `[RENAME] PID: ${proc.audit_token.pid.toString().padEnd(6)} ` + `From: ${renameEvent.source.path} → To: ${dest}`
    );
}

function formatAuthenticationEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const authEvent = event.event as ESEvent_authentication;

    return (
        `[AUTH] ${authEvent.success ? "✓ SUCCESS" : "✗ FAILED"} ` +
        `Type: ${authEvent.type} ` +
        `PID: ${proc.audit_token.pid}`
    );
}

function formatSudoEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const sudoEvent = event.event as ESEvent_sudo;

    return (
        `[SUDO] ${sudoEvent.success ? "✓ SUCCESS" : "✗ FAILED"} ` +
        `Command: ${sudoEvent.command || "N/A"} ` +
        `UID: ${proc.audit_token.euid}`
    );
}

function formatSignalEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const sigEvent = event.event as ESEvent_signal;

    return (
        `[SIGNAL] PID: ${proc.audit_token.pid.toString().padEnd(6)} ` +
        `Signal: ${sigEvent.sig} ` +
        `Target PID: ${sigEvent.target.audit_token.pid}`
    );
}

function formatGenericEvent(event: ESLoggerEvent): string {
    const proc = event.process;
    const eventTypeName = getEventTypeName(event.event_type);
    const shortName = getShortEventName(eventTypeName);

    return (
        `[${shortName.toUpperCase()}] ` +
        `PID: ${proc.audit_token.pid.toString().padEnd(6)} ` +
        `${proc.executable.path}`
    );
}

function formatEvent(event: ESLoggerEvent): string {
    const eventTypeName = getEventTypeName(event.event_type);
    const shortName = getShortEventName(eventTypeName).toLowerCase();

    if (shortName.includes("exec")) {
        return formatExecEvent(event);
    } else if (shortName.includes("fork")) {
        return formatForkEvent(event);
    } else if (shortName.includes("open")) {
        return formatOpenEvent(event);
    } else if (shortName.includes("close")) {
        return formatCloseEvent(event);
    } else if (shortName.includes("write")) {
        return formatWriteEvent(event);
    } else if (shortName.includes("rename")) {
        return formatRenameEvent(event);
    } else if (shortName.includes("authentication")) {
        return formatAuthenticationEvent(event);
    } else if (shortName.includes("sudo")) {
        return formatSudoEvent(event);
    } else if (shortName.includes("signal")) {
        return formatSignalEvent(event);
    } else {
        return formatGenericEvent(event);
    }
}

// ============================================================================
// CLI Options and Help
// ============================================================================

// Show help message
function showHelp() {
    console.log(`
${chalk.bold("macOS ESLogger Monitor")}

Monitor macOS Endpoint Security events in real-time using eslogger.

${chalk.bold("USAGE:")}
  tools macos-eslogger [options]

${chalk.bold("ARGUMENTS:")}
  -e, --events <list>     Comma-separated list of event types to monitor
  -c, --category <cat>    Monitor all events in a category
  -o, --output <file>     Write output to file instead of stdout
  -v, --verbose           Enable verbose logging
  -s, --silent            Suppress non-error messages
  -d, --dry-run           Show what would be monitored without running eslogger
  --debug                 Show raw JSON for each event (useful for debugging)
  --include-fork          Automatically include 'fork' events when monitoring 'exec'
  --filter-event <expr>   Filter events using JSON path expression (e.g., '.event.target.executable.path == ".*Cursor.*"')
  -?, --help-full         Show this help message

${chalk.bold("EVENT CATEGORIES:")}
  ${Object.keys(EVENT_CATEGORIES).join(", ")}

${chalk.bold("POPULAR EVENTS:")}
  exec, fork, exit, open, write, authentication, sudo

${chalk.bold("EXAMPLES:")}
  tools macos-eslogger                          # Interactive mode
  tools macos-eslogger -c process               # Monitor process events
  tools macos-eslogger -e exec,fork,open        # Monitor specific events
  tools macos-eslogger -o events.log            # Save to file
  tools macos-eslogger -e exec --filter-event '.event.target.path == ".*Cursor.*"'  # Filter Cursor exec events

${chalk.bold("NOTE:")}
  This tool requires sudo privileges to run eslogger.
  Use Ctrl+C to stop monitoring.

${chalk.bold("FILTER SYNTAX:")}
  JSON path expressions using dot notation:
  • .event.target.path == ".*Cursor.*"               # Regex match (exec events)
  • .event.target.path == "/bin/bash"                # Exact match (exec events)
  • .process.audit_token.pid == "1234"               # Numeric comparison
  • .event.child.executable.path =~ "bash|zsh"       # Regex match for fork events (=~)
  • .event.target.path !~ "bash|zsh"                 # Regex not match (!~)

${chalk.bold("TROUBLESHOOTING:")}
  • Shell builtins (like 'which' in zsh) don't trigger exec events
    Try: /usr/bin/which playwright (uses external executable)
  • eslogger suppresses events from its own process group
    Run commands in a separate terminal window/session
  • Use --include-fork to also monitor fork events (fork happens before exec)
  • Use --debug to see raw event JSON for troubleshooting
`);
}

// ============================================================================
// Monitor Function
// ============================================================================

function monitorWithESF(
    eventTypes: string[],
    outputPath?: string,
    silent = false,
    dryRun = false,
    debug = false,
    filterExpression?: string
) {
    if (!silent) {
        console.log(chalk.blue("🚀 Starting ESLogger monitor..."));
        console.log(`📊 Monitoring ${eventTypes.length} event type(s):`);

        // Display in columns for better readability
        const columns = 4;
        for (let i = 0; i < eventTypes.length; i += columns) {
            const row = eventTypes.slice(i, i + columns);
            console.log(`   ${row.map((e) => e.padEnd(30)).join("")}`);
        }

        if (filterExpression) {
            console.log(`\n🔍 Filter: ${filterExpression}`);
        }

        if (dryRun) {
            console.log(chalk.green("\n✅ Dry run complete - would monitor the events above."));
            console.log("─".repeat(80));
            return;
        }

        console.log(chalk.yellow("\n⌨️  Press Ctrl+C to stop."));
        console.log("─".repeat(80) + "\n");
    }

    const args = ["eslogger", ...eventTypes];

    const monitor: ChildProcess = spawn("sudo", args);

    let buffer = "";
    let eventCount = 0;
    let outputBuffer = "";

    monitor.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (line.trim() === "") {
                continue;
            }

            try {
                const event: ESLoggerEvent = JSON.parse(line);
                eventCount++;

                if (debug) {
                    console.log(chalk.gray("--- RAW EVENT ---"));
                    console.log(JSON.stringify(event, null, 2));
                    console.log(chalk.gray("--- END RAW ---"));
                }

                // Apply filter if specified
                if (filterExpression && !evaluateFilterExpression(event, filterExpression)) {
                    continue; // Skip this event if it doesn't match the filter
                }

                try {
                    const formatted = formatEvent(event);

                    if (outputPath) {
                        outputBuffer += formatted + "\n";
                    } else {
                        console.log(formatted);
                    }
                } catch (formatErr: any) {
                    // Formatting error - event parsed but couldn't format it
                    if (!silent) {
                        const eventTypeName = getEventTypeName(event.event_type);
                        consoleLog.warn(`[FORMAT_ERROR] Failed to format ${eventTypeName}: ${formatErr.message}`);
                        if (debug) {
                            consoleLog.warn(`Event data: ${JSON.stringify(event, null, 2)}`);
                        }
                    }
                }
            } catch (err: any) {
                // JSON parsing error
                if (!silent) {
                    consoleLog.warn(`[JSON_PARSE_ERROR] ${err.message}`);
                    consoleLog.warn(`Line: ${line.substring(0, 1000)}...`);
                }
            }
        }
    });

    monitor.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        // Only show stderr if it's not just eslogger startup messages
        if (!msg.includes("Launched") && !msg.includes("endpoint")) {
            logger.error(`[ESLOGGER_STDERR] ${msg}`);
        }
    });

    monitor.on("close", async (code) => {
        if (outputPath && outputBuffer) {
            try {
                await Bun.write(outputPath, outputBuffer);
                consoleLog.info(`✔ Output written to ${outputPath}`);
            } catch (err) {
                logger.error(`Failed to write output file: ${err}`);
            }
        }

        if (!silent) {
            consoleLog.info("\n" + "─".repeat(80));
            consoleLog.info(`📈 Total events captured: ${eventCount}`);
            if (code !== 0) {
                logger.warn(`⚠️  Monitor process exited with code ${code}.`);
            } else {
                consoleLog.info(chalk.green("✓ Process monitor stopped."));
            }
        }
    });

    process.on("SIGINT", () => {
        if (!silent) {
            consoleLog.info(chalk.red("\n\n🛑 Stopping eslogger monitor..."));
        }
        monitor.kill("SIGINT");
        setTimeout(() => process.exit(0), 500);
    });
}

// ============================================================================
// Interactive Mode Functions
// ============================================================================

async function getEventTypesInteractively(): Promise<string[]> {
    consoleLog.info(chalk.cyan("🔍 macOS ESLogger Real-time Event Monitor\n"));

    const mode = await select({
        message: "Choose monitoring mode:",
        choices: [
            { value: "category", name: "📂 Category (pre-defined event groups)" },
            { value: "custom", name: "🎯 Custom (select specific events)" },
            { value: "popular", name: "🔥 Popular (most commonly monitored)" },
        ],
    });

    if (mode === "popular") {
        return ["exec", "fork", "exit", "open", "write", "authentication", "sudo"];
    } else if (mode === "category") {
        const categories = await checkbox({
            message: "Select event categories to monitor:",
            choices: Object.keys(EVENT_CATEGORIES).map((cat) => ({
                value: cat,
                name: `${cat.charAt(0).toUpperCase() + cat.slice(1)} (${
                    EVENT_CATEGORIES[cat as keyof typeof EVENT_CATEGORIES].length
                } events)`,
                checked: cat === "process", // Default select process
            })),
        });

        if (!categories || categories.length === 0) {
            consoleLog.info("No categories selected. Exiting.");
            process.exit(0);
        }

        const eventTypes: string[] = [];
        categories.forEach((cat: string) => {
            eventTypes.push(...EVENT_CATEGORIES[cat as keyof typeof EVENT_CATEGORIES]);
        });
        return eventTypes;
    } else {
        // Custom event selection
        const events = await checkbox({
            message: "Select events to monitor (type to filter):",
            choices: ALL_EVENTS.map((evt) => ({
                value: evt,
                name: evt,
                checked: evt === "exec", // Default select exec
            })),
        });

        if (!events || events.length === 0) {
            consoleLog.info("No events selected. Exiting.");
            process.exit(0);
        }

        return events;
    }
}

// ============================================================================
// Main Function
// ============================================================================

async function main() {
    // Parse command line arguments
    const program = new Command()
        .name("macos-eslogger")
        .option("-e, --events <list>", "Comma-separated list of event types to monitor")
        .option("-c, --category <cat>", "Monitor all events in a category")
        .option("-o, --output <file>", "Write output to file instead of stdout")
        .option("-v, --verbose", "Enable verbose logging")
        .option("-s, --silent", "Suppress non-error messages")
        .option("-d, --dry-run", "Show what would be monitored without running eslogger")
        .option("--debug", "Show raw JSON for each event (useful for debugging)")
        .option("--include-fork", "Automatically include 'fork' events when monitoring 'exec'")
        .option("--filter-event <expr>", "Filter events using JSON path expression")
        .option("-?, --help-full", "Show this help message")
        .parse();

    const options = program.opts();

    // Show help if requested
    if (options.helpFull) {
        showHelp();
        process.exit(0);
    }

    let eventTypes: string[] = [];

    // Check if events were provided via command line
    if (options.events) {
        eventTypes = options.events.split(",").map((e: string) => e.trim());

        // Validate event types
        const invalid = eventTypes.filter((e) => !ALL_EVENTS.includes(e));
        if (invalid.length > 0) {
            console.log(`❌ Unknown event type(s): ${invalid.join(", ")}`);
            console.log("\n💡 Use one of the following event types:");
            console.log(ALL_EVENTS.join(", "));
            process.exit(1);
        }
    } else if (options.category) {
        const category = options.category.toLowerCase();
        if (EVENT_CATEGORIES[category as keyof typeof EVENT_CATEGORIES]) {
            eventTypes = EVENT_CATEGORIES[category as keyof typeof EVENT_CATEGORIES];
        } else {
            console.log(`❌ Unknown category: ${category}`);
            console.log(`📚 Available categories: ${Object.keys(EVENT_CATEGORIES).join(", ")}`);
            process.exit(1);
        }
    } else {
        // Interactive mode
        try {
            eventTypes = await getEventTypesInteractively();
        } catch (error: any) {
            if (error instanceof ExitPromptError) {
                logger.info("\nOperation cancelled by user.");
                process.exit(0);
            }
            throw error;
        }
    }

    if (eventTypes.length === 0) {
        console.log("❌ No event types specified.");
        showHelp();
        process.exit(1);
    }

    // Remove duplicates
    eventTypes = [...new Set(eventTypes)];

    // If include-fork is set and exec is in the list, add fork
    if (options.includeFork && eventTypes.includes("exec") && !eventTypes.includes("fork")) {
        eventTypes.push("fork");
        if (!options.silent) {
            consoleLog.info(chalk.yellow("ℹ️  Added 'fork' event monitoring (fork happens before exec)"));
        }
    }

    // Warn about shell builtins if monitoring exec
    if (eventTypes.includes("exec") && !options.silent) {
        consoleLog.info(chalk.yellow("💡 Tip: Shell builtins (like 'which' in zsh) don't trigger exec events."));
        consoleLog.info(chalk.yellow("   Use external executables like /usr/bin/which or add --include-fork"));
    }

    // Start monitoring
    monitorWithESF(eventTypes, options.output, options.silent, options.dryRun, options.debug, options.filterEvent);
}

// Run the tool
main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
