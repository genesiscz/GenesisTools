import { basename } from "node:path";

/**
 * Why this process reads the vault, for the approval window GenesisTools.app shows before it hands the master key to a
 * tool. Martin, 2026-10-15: "enough context so i know exactly what / who / which session / triggered that and why
 * (each caller should give that context possibly)". WHO and WHICH SESSION the app reads from the kernel; WHY and WHAT
 * only the caller knows, so they live here.
 */
let purpose: string | undefined;
let firstSecret: string | undefined;

/** One sentence a person can judge: "refresh the usage figures of 11 accounts for the statusline". */
export function setVaultPurpose(text: string | undefined): void {
    purpose = text?.trim() || undefined;
}

/** The purpose for the duration of `fn`, then the one before it again. */
export async function withVaultPurpose<T>(text: string, fn: () => Promise<T>): Promise<T> {
    const previous = purpose;
    purpose = text.trim() || previous;

    try {
        return await fn();
    } finally {
        purpose = previous;
    }
}

export function vaultPurpose(): string | undefined {
    return purpose;
}

/** The first secret this process read: what it was after when it needed the master key. */
export function noteVaultSecret(path: string): void {
    firstSecret ??= path;
}

export function vaultSecretAsked(): string | undefined {
    return firstSecret;
}

/** Test seam. */
export function _resetVaultContextForTest(): void {
    purpose = undefined;
    firstSecret = undefined;
}

/**
 * The tool this process runs: `src/<tool>/` in the script path (`src/ai/commands/usage/poll-daemon.ts` is `ai`), else
 * the `gt-<tool>` launcher, else the script's own name. The first version read only `src/<tool>/index.ts` and called
 * the usage daemon "bun".
 */
export function currentToolName(argv: string[] = process.argv, executable: string = process.execPath): string {
    const script = argv[1] ?? "";
    const fromScript = script.match(/^.*[/\\]src[/\\]([^/\\]+)[/\\]/)?.[1];

    if (fromScript) {
        return fromScript;
    }

    for (const launcher of [basename(executable), basename(argv[0] ?? "")]) {
        if (launcher.startsWith("gt-")) {
            return launcher.slice(3);
        }
    }

    return basename(script).replace(/\.[cm]?[jt]sx?$/, "") || basename(argv[0] ?? "") || "unknown";
}

const CREDENTIAL_FLAGS = new Set(["--token", "--api-key", "--key", "--password", "--secret"]);

/** The wakeup relay's -t means token; other tools use -t for non-secret options. */
function hasTokenShortFlag(words: string[]): boolean {
    return (
        words.some(
            (word) =>
                /^(?:wakeup|gt-wakeup)$/.test(basename(word.replaceAll("\\", "/"))) ||
                /[/\\]src[/\\]wakeup[/\\]/.test(word)
        ) &&
        words.includes("daemon") &&
        words.includes("register")
    );
}

/** Redact before joining or truncating argv so a separated credential cannot lose its flag. */
export function redactCredentialArgs(argv: string[]): string[] {
    const shortToken = hasTokenShortFlag(argv);
    let hideNext = false;
    return argv.map((word) => {
        if (hideNext) {
            hideNext = false;
            return "[REDACTED]";
        }

        const equals = word.indexOf("=");
        const flag = equals < 0 ? word : word.slice(0, equals);
        if (!CREDENTIAL_FLAGS.has(flag) && !(shortToken && flag === "-t")) {
            return redactCredentialHeaders(word);
        }

        hideNext = equals < 0;
        return equals < 0 ? word : `${flag}=[REDACTED]`;
    });
}

const SENSITIVE_QUERY_NAMES = new Set([
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "apikey",
    "key",
    "password",
    "passwd",
    "secret",
    "clientsecret",
    "authorization",
    "auth",
    "credential",
    "credentials",
    "prompt",
    "command",
    "cmd",
    "argv",
    "args",
]);

function redactCredentialParams(params: URLSearchParams, depth: number): URLSearchParams {
    const safe = new URLSearchParams();
    for (const [name, value] of params) {
        const sensitive = SENSITIVE_QUERY_NAMES.has(name.toLowerCase().replaceAll(/[-_]/g, ""));
        safe.append(name, sensitive ? "[REDACTED]" : redactText(value, depth + 1));
    }

    return safe;
}

function redactCredentialUrl(raw: string, depth: number): string {
    try {
        const url = new URL(raw);
        if (url.username || url.password) {
            url.username = "[REDACTED]";
            url.password = "";
        }

        url.search = redactCredentialParams(url.searchParams, depth).toString();

        // An OAuth implicit-flow callback carries its tokens in the fragment (`#access_token=…`).
        if (url.hash.includes("=")) {
            url.hash = redactCredentialParams(new URLSearchParams(url.hash.slice(1)), depth).toString();
        }

        return url.toString();
    } catch {
        return "[REDACTED URL]";
    }
}

const CREDENTIAL_HEADER_NAMES = "(?:Proxy-)?Authorization|[a-z0-9_.-]*(?:key|token|secret|cookie)[a-z0-9_.-]*";

/** Scan UTF-16 units once; a whitespace run is inspected only at its start. */
function headerValueEnd({ text, start, outer }: { text: string; start: number; outer: string | undefined }): number {
    const space = (index: number) => text[index] === " " || text[index] === "\t";
    const lineEnd = (index: number) => index >= text.length || text[index] === "\r" || text[index] === "\n";
    const boundary = (index: number): { next: number; found: boolean } => {
        let next = index;
        while (space(next)) {
            next++;
        }
        if (next === index) {
            return { next, found: false };
        }
        let token = next;
        while (text[token] === '"' || text[token] === "'") {
            token++;
        }
        const flag = /^--?[a-z]/i.test(text.slice(token, token + 3));
        const nameStart = token;
        while (token < text.length && /[a-z0-9_.-]/i.test(text[token])) {
            token++;
        }
        const named = token > nameStart;
        while (space(token)) {
            token++;
        }
        return { next, found: flag || (named && text[token] === ":") };
    };
    let index = start;
    let previous = "";
    while (!lineEnd(index)) {
        if (space(index)) {
            const run = boundary(index);
            if (run.found) {
                return index;
            }
            index = run.next;
            continue;
        }
        const quote = text[index];
        if (quote !== '"' && quote !== "'") {
            previous = quote;
            index++;
            continue;
        }
        // A completed argument wrapper can precede another quoted header. Embedded value quotes
        // after '=' (or at the start of the value) still belong to the credential.
        const next = index + 1;
        if (outer === quote && index > start && previous !== "=" && (lineEnd(next) || boundary(next).found)) {
            return index;
        }
        let close = next;
        while (!lineEnd(close) && text[close] !== quote) {
            close += text[close] === "\\" && !lineEnd(close + 1) ? 2 : 1;
        }
        if (lineEnd(close)) {
            return close;
        }
        previous = quote;
        index = close + 1;
    }
    return index;
}

function redactedHeaderValue(name: string, value: string): string {
    const scheme = /^(?:Proxy-)?Authorization$/i.test(name)
        ? value.match(/^([a-z][a-z0-9+.-]*)[ \t]+\S/i)?.[1]
        : undefined;
    return `${scheme ? `${scheme} ` : ""}[REDACTED]`;
}

function redactCredentialHeaders(text: string): string {
    const exact = new RegExp(`^([ \\t]*)(${CREDENTIAL_HEADER_NAMES})([ \\t]*:[ \\t]*)([^\\r\\n]*)$`, "i");
    if (exact.test(text)) {
        return text.replace(
            exact,
            (_match, prefix: string, name: string, colon: string, value: string) =>
                `${prefix}${name}${colon}${redactedHeaderValue(name, value)}`
        );
    }

    const inline = new RegExp(`(^|[\\s"']|(?:--header|-H)=["']?)(${CREDENTIAL_HEADER_NAMES})([ \\t]*:[ \\t]*)`, "gi");
    let safe = "";
    let copied = 0;
    for (;;) {
        const match = inline.exec(text);
        if (!match) {
            break;
        }

        const start = inline.lastIndex;
        const prefix = match[1].at(-1);
        const beforeFlag = text[match.index - 1];
        const wrapper = prefix === '"' || prefix === "'" ? prefix : beforeFlag;
        const outer = wrapper === '"' || wrapper === "'" ? wrapper : undefined;
        const end = headerValueEnd({ text, start, outer });
        safe += text.slice(copied, start) + redactedHeaderValue(match[2], text.slice(start, end));
        copied = end;
        inline.lastIndex = end;
    }

    return safe + text.slice(copied);
}

/** Also protects command facts, purposes and nested audit fields supplied as text. */
export function redactCredentialText(text: string): string {
    return redactText(text, 0);
}

function redactText(text: string, depth: number): string {
    if (depth >= 8) {
        return "[REDACTED]";
    }

    const safe = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (url) => redactCredentialUrl(url, depth));
    const flags = hasTokenShortFlag(safe.split(/[\s/\\]+/))
        ? "--(?:token|api-key|key|password|secret)|-t"
        : "--(?:token|api-key|key|password|secret)";
    const pattern = new RegExp(
        String.raw`(^|[\s"'])(${flags})(=|\s+)("(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\?(?=$|[\r\n]))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|\\?(?=$|[\r\n]))|[^\s;]+)`,
        "g"
    );
    return redactCredentialHeaders(safe.replace(pattern, "$1$2$3[REDACTED]"));
}

export function redactCredentialFields(value: unknown): unknown {
    if (typeof value === "string") {
        return redactCredentialText(value);
    }

    if (Array.isArray(value)) {
        return value.every((word) => typeof word === "string")
            ? redactCredentialArgs(value).map(redactCredentialText)
            : value.map(redactCredentialFields);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redactCredentialFields(field)]));
    }

    return value;
}

/** `tools <tool> <args>`, with credentials redacted before cutting to a length a window can show. */
export function currentCommandLine(argv: string[] = process.argv, max = 300): string {
    const words = redactCredentialArgs(["tools", currentToolName(argv), ...argv.slice(2)]).map((word) =>
        word.includes(" ") ? `"${word}"` : word
    );
    const line = words.join(" ");

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
