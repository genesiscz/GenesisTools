import { CString, dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";

/** The curl option numbers this client sets (`CURLOPT(...)` in curl/curl.h: type base + index). */
export const CURLOPT = {
    WRITEDATA: 10001,
    URL: 10002,
    PROXY: 10004,
    WRITEFUNCTION: 20011,
    LOW_SPEED_LIMIT: 19,
    LOW_SPEED_TIME: 20,
    HTTPHEADER: 10023,
    HEADERDATA: 10029,
    COOKIEFILE: 10031,
    CUSTOMREQUEST: 10036,
    POST: 47,
    FOLLOWLOCATION: 52,
    HTTPPROXYTUNNEL: 61,
    CAINFO: 10065,
    MAXREDIRS: 68,
    HEADERFUNCTION: 20079,
    NOSIGNAL: 99,
    ACCEPT_ENCODING: 10102,
    SHARE: 10100,
    POSTFIELDSIZE_LARGE: 30120,
    TIMEOUT_MS: 155,
    CONNECTTIMEOUT_MS: 156,
    COPYPOSTFIELDS: 10165,
    PROXY_CAINFO: 10246,
} as const;

export const CURLINFO = { EFFECTIVE_URL: 0x100001, RESPONSE_CODE: 0x200002 } as const;

const CURL_GLOBAL_ALL = 3;
const CURLSHOPT_SHARE = 1;
const CURL_LOCK_DATA_COOKIE = 2;
const CURL_LOCK_DATA_DNS = 3;
const CURL_LOCK_DATA_SSL_SESSION = 4;
const CURLMSG_DONE = 1;
/** `struct CURLMsg` on 64-bit: `int msg` (padded to 8), `CURL *easy_handle`, then the `CURLcode result` union. */
const CURLMSG_EASY_OFFSET = 8;
const CURLMSG_RESULT_OFFSET = 16;

/**
 * `curl_easy_setopt`, `curl_easy_getinfo` and `curl_share_setopt` are variadic. Apple arm64 passes every variadic
 * argument on the stack while bun:ffi calls them as fixed-argument functions, so six dummy register arguments push
 * the value into stack slot 0, where the callee reads it. Every other ABI passes it in the third register as usual.
 */
const APPLE_ARM64 = process.platform === "darwin" && process.arch === "arm64";
const PAD_TYPES = APPLE_ARM64 ? Array<FFIType>(6).fill(FFIType.i64) : [];
const PAD_VALUES = APPLE_ARM64 ? Array<number>(6).fill(0) : [];

type VariadicCall = (handle: Pointer, option: number, ...rest: Array<number | Pointer | null>) => number;

export interface MultiDone {
    easy: Pointer;
    result: number;
}

export interface Libcurl {
    easyInit(): Pointer;
    easyCleanup(easy: Pointer): void;
    /** Applies a browser target (TLS, HTTP/2 and, with `defaultHeaders`, its header set). 0 means accepted. */
    impersonate(easy: Pointer, target: string, defaultHeaders: boolean): number;
    setLong(easy: Pointer, option: number, value: number): number;
    setPointer(easy: Pointer, option: number, value: Pointer | null): number;
    /** curl copies string options, so the buffer may go once the call returns. */
    setString(easy: Pointer, option: number, value: string): number;
    infoLong(easy: Pointer, info: number): number;
    infoString(easy: Pointer, info: number): string;
    strerror(code: number): string;
    slistAppend(list: Pointer | null, line: string): Pointer | null;
    slistFree(list: Pointer | null): void;
    /** A share handle for cookies, DNS and TLS sessions. Single-threaded use only: no lock callbacks are set. */
    shareInit(): Pointer;
    shareCleanup(share: Pointer): void;
    multiInit(): Pointer;
    multiCleanup(multi: Pointer): void;
    multiAdd(multi: Pointer, easy: Pointer): number;
    multiRemove(multi: Pointer, easy: Pointer): number;
    multiPerform(multi: Pointer): number;
    /** Blocks until a transfer has activity, curl's own timer fires, `multiWakeup` is called or `timeoutMs` passes. */
    multiPoll(multi: Pointer, timeoutMs: number): number;
    /** Ends a `multiPoll` early; safe to call from another thread. */
    multiWakeup(multi: Pointer): number;
    multiDone(multi: Pointer): MultiDone[];
}

function cstring(value: string): Buffer {
    return Buffer.from(`${value}\0`, "utf8");
}

export function openLibcurl(path: string): Libcurl {
    const { symbols: c } = dlopen(path, {
        curl_global_init: { args: [FFIType.i64], returns: FFIType.i32 },
        curl_easy_init: { args: [], returns: FFIType.ptr },
        curl_easy_cleanup: { args: [FFIType.ptr], returns: FFIType.void },
        curl_easy_impersonate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        curl_easy_strerror: { args: [FFIType.i32], returns: FFIType.cstring },
        curl_slist_append: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
        curl_slist_free_all: { args: [FFIType.ptr], returns: FFIType.void },
        curl_share_init: { args: [], returns: FFIType.ptr },
        curl_share_cleanup: { args: [FFIType.ptr], returns: FFIType.i32 },
        curl_multi_init: { args: [], returns: FFIType.ptr },
        curl_multi_cleanup: { args: [FFIType.ptr], returns: FFIType.i32 },
        curl_multi_add_handle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        curl_multi_remove_handle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        curl_multi_perform: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        curl_multi_poll: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.ptr],
            returns: FFIType.i32,
        },
        curl_multi_wakeup: { args: [FFIType.ptr], returns: FFIType.i32 },
        curl_multi_info_read: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    });

    // bun:ffi binds one signature per symbol and handle, so each value type of a variadic call is its own dlopen.
    const variadic = (name: string, value: FFIType): VariadicCall => {
        const { symbols } = dlopen(path, {
            [name]: { args: [FFIType.ptr, FFIType.i32, ...PAD_TYPES, value], returns: FFIType.i32 },
        });
        const call = symbols[name];
        return (handle, option, ...rest) => Number(Reflect.apply(call, undefined, [handle, option, ...rest]));
    };
    const setoptLong = variadic("curl_easy_setopt", FFIType.i64);
    const setoptPointer = variadic("curl_easy_setopt", FFIType.ptr);
    const getinfoPointer = variadic("curl_easy_getinfo", FFIType.ptr);
    const shareSetoptLong = variadic("curl_share_setopt", FFIType.i64);

    c.curl_global_init(CURL_GLOBAL_ALL);

    const required = (value: Pointer | null, what: string): Pointer => {
        if (!value) {
            throw new Error(`libcurl-impersonate: ${what} returned NULL`);
        }

        return value;
    };
    const infoWord = (easy: Pointer, info: number): bigint => {
        const out = new BigInt64Array(1);
        getinfoPointer(easy, info, ...PAD_VALUES, ptr(out));
        return out[0] ?? 0n;
    };

    return {
        easyInit: () => required(c.curl_easy_init(), "curl_easy_init"),
        easyCleanup: (easy) => c.curl_easy_cleanup(easy),
        impersonate: (easy, target, defaultHeaders) =>
            c.curl_easy_impersonate(easy, ptr(cstring(target)), defaultHeaders ? 1 : 0),
        setLong: (easy, option, value) => setoptLong(easy, option, ...PAD_VALUES, value),
        setPointer: (easy, option, value) => setoptPointer(easy, option, ...PAD_VALUES, value),
        setString: (easy, option, value) => setoptPointer(easy, option, ...PAD_VALUES, ptr(cstring(value))),
        infoLong: (easy, info) => Number(infoWord(easy, info)),
        infoString: (easy, info) => {
            const address = Number(infoWord(easy, info));
            return address ? new CString(address as Pointer).toString() : "";
        },
        strerror: (code) => String(c.curl_easy_strerror(code)),
        slistAppend: (list, line) => c.curl_slist_append(list, ptr(cstring(line))),
        slistFree: (list) => {
            if (list) {
                c.curl_slist_free_all(list);
            }
        },
        shareInit: () => {
            const share = required(c.curl_share_init(), "curl_share_init");
            for (const data of [CURL_LOCK_DATA_COOKIE, CURL_LOCK_DATA_DNS, CURL_LOCK_DATA_SSL_SESSION]) {
                shareSetoptLong(share, CURLSHOPT_SHARE, ...PAD_VALUES, data);
            }

            return share;
        },
        shareCleanup: (share) => {
            c.curl_share_cleanup(share);
        },
        multiInit: () => required(c.curl_multi_init(), "curl_multi_init"),
        multiCleanup: (multi) => {
            c.curl_multi_cleanup(multi);
        },
        multiAdd: (multi, easy) => c.curl_multi_add_handle(multi, easy),
        multiRemove: (multi, easy) => c.curl_multi_remove_handle(multi, easy),
        multiPerform: (multi) => c.curl_multi_perform(multi, ptr(new Int32Array(1))),
        multiPoll: (multi, timeoutMs) => c.curl_multi_poll(multi, null, 0, timeoutMs, null),
        multiWakeup: (multi) => c.curl_multi_wakeup(multi),
        multiDone: (multi) => {
            const done: MultiDone[] = [];
            const left = new Int32Array(1);
            for (
                let msg = c.curl_multi_info_read(multi, ptr(left));
                msg;
                msg = c.curl_multi_info_read(multi, ptr(left))
            ) {
                if (read.i32(msg, 0) === CURLMSG_DONE) {
                    done.push({
                        easy: read.ptr(msg, CURLMSG_EASY_OFFSET) as Pointer,
                        result: read.i32(msg, CURLMSG_RESULT_OFFSET),
                    });
                }
            }

            return done;
        },
    };
}
