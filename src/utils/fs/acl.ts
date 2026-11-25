import { CString, dlopen, FFIType } from "bun:ffi";

/** `acl_get_link_np`: the list of the entry itself, never of what a symbolic link names. */
const ACL_TYPE_EXTENDED = 0x100;

type AclCalls = ReturnType<typeof openAclCalls>;
let calls: AclCalls | null | undefined;

function openAclCalls() {
    return dlopen("/usr/lib/libSystem.B.dylib", {
        /** `acl_t acl_get_link_np(const char *path, acl_type_t type)`: null when the entry has no list. */
        acl_get_link_np: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
        /** `char *acl_to_text(acl_t acl, ssize_t *len)`: one line per entry; freed with `acl_free`. */
        acl_to_text: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
        acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
}

/**
 * Whether an access control list of `path` allows anybody anything, on macOS. Such an entry can let another
 * account write to a file or change a folder while the mode bits say that only the owner can, so a path that has to
 * be private is not proven private by its owner and mode alone. An entry that denies (macOS puts "everyone deny
 * delete" on a home folder) takes nothing away from that. `null`: the list could not be read, so nothing is
 * proven. Other systems answer false: a POSIX access control list shows in the group bits of the mode.
 *
 * The first call opens libSystem through `bun:ffi` (about 1 ms, measured 2026-11-20); a call after that takes
 * about 2 microseconds. This file does not use `defineSystemLibrary`, because it is read on every start of a tool
 * and that module costs 10 ms to load.
 */
export function aclAllows(path: string): boolean | null {
    if (process.platform !== "darwin") {
        return false;
    }

    if (calls === undefined) {
        try {
            calls = openAclCalls();
        } catch {
            calls = null;
        }
    }

    if (calls === null) {
        return null;
    }

    const acl = calls.acl_get_link_np(Buffer.from(`${path}\0`), ACL_TYPE_EXTENDED);

    if (acl === null) {
        return false;
    }

    try {
        const text = calls.acl_to_text(acl, null);

        if (text === null) {
            return null;
        }

        try {
            // "user:<uuid>:<name>:<id>:allow[,flags]:<permissions>", after a "!#acl 1" line.
            return new CString(text)
                .toString()
                .split("\n")
                .some((line) => line.split(":")[4]?.startsWith("allow") === true);
        } finally {
            calls.acl_free(text);
        }
    } finally {
        calls.acl_free(acl);
    }
}
