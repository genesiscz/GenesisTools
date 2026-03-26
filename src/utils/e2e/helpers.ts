import { resolve } from "node:path";

const TOOLS_PATH = resolve(import.meta.dir, "..", "..", "..", "tools");

// \x1B (ESC) is excluded from the control-char class so the CSI alternatives can match full sequences
// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for stripping ANSI
const ANSI_RE = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F]|\x1B\[[?]?[0-9;]*[a-zA-Z]|\x1B\[[0-9;]*[A-Za-z]|\x1B\].*?\x07/g;

// All Unicode symbols from @clack/prompts common.ts + spinner frames
const CLACK_SYMBOLS = /[◆◇■▲●○◻◼▪│┌└┐┘├─╭╮╰╯◒◐◓◑]/g;

// ─── ANSI / Clack stripping ─────────────────────────────────

export function stripAnsi(str: string): string {
    return str.replace(ANSI_RE, "");
}

/** Strip ANSI escapes AND clack's decorative Unicode symbols. */
export function stripClack(str: string): string {
    return stripAnsi(str).replace(CLACK_SYMBOLS, "").replace(/^\s+$/gm, "");
}

// ─── Tool runner ─────────────────────────────────────────────

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export async function runTool(args: string[], timeoutMs = 15_000): Promise<RunResult> {
    const proc = Bun.spawn(["bun", "run", TOOLS_PATH, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
    });

    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    clearTimeout(timeout);

    return { stdout, stderr, exitCode };
}

// ─── Output helpers ──────────────────────────────────────────

/** Combine stdout + stderr and strip all ANSI + clack decorations. */
export function getOutput(result: RunResult): string {
    return stripClack(result.stdout + result.stderr);
}

// ─── JSON extraction ─────────────────────────────────────────

/**
 * Extract a JSON value from mixed CLI output (spinner + log + JSON).
 * Strips ANSI and clack symbols, then finds JSON array or object boundaries.
 */
export function extractJson<T = unknown>(output: string): T {
    const clean = stripClack(output);

    // Try parsing the whole cleaned output first (handles compact JSON)
    try {
        // biome-ignore lint/style/noRestrictedGlobals: SafeJSON (comment-json) chokes on Unicode in CLI output
        return JSON.parse(clean) as T;
    } catch {
        // Fall through to boundary extraction
    }

    // Try array: find first "[" and last "]"
    const arrStart = clean.indexOf("[");
    const arrEnd = clean.lastIndexOf("]");

    if (arrStart !== -1 && arrEnd > arrStart) {
        // biome-ignore lint/style/noRestrictedGlobals: SafeJSON (comment-json) chokes on Unicode in CLI output
        return JSON.parse(clean.slice(arrStart, arrEnd + 1)) as T;
    }

    // Try object: slice from first "{" to last "}"
    const objStart = clean.indexOf("{");
    const objEnd = clean.lastIndexOf("}");

    if (objStart !== -1 && objEnd > objStart) {
        // biome-ignore lint/style/noRestrictedGlobals: SafeJSON (comment-json) chokes on Unicode in CLI output
        return JSON.parse(clean.slice(objStart, objEnd + 1)) as T;
    }

    throw new Error(`No JSON found in output:\n${output.slice(0, 500)}`);
}

/**
 * Extract JSON from a RunResult, trying stdout first then stderr.
 * Useful for tools that write JSON to stdout but spinner noise to stderr.
 */
export function extractJsonFromResult<T = unknown>(result: RunResult): T {
    try {
        return extractJson<T>(result.stdout);
    } catch {
        return extractJson<T>(result.stderr);
    }
}
