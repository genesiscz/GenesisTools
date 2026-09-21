import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * Per-command scratch: it must not survive a reboot, and it must never land inside a user
 * repository where `git status` would show it.
 *
 * `tmpdir()` rather than a literal `/tmp`, for two reasons. It is the only Windows-portable
 * form (`scripts/ci/lint-rules.ts` enforces that), and on macOS it resolves to the per-user
 * `$TMPDIR` under `/var/folders`, which is mode 700. A capture holds copies of dirty files,
 * which can include a `.env` a command just wrote, so a user-private directory is the right
 * home for it and world-readable `/tmp` was not.
 *
 * It is a FUNCTION, not a constant: `TMPDIR` is what the test suite and the parity harnesses
 * move to point two implementations at the same tree, and a value frozen at import time
 * would ignore them.
 */
export function hookDataRoot(): string {
    // The `ai` segment is what the hook this port replaces already writes. Keeping it means
    // `scripts/hooks-diff-parity.ts` can point both implementations at ONE tree (with
    // `TMPDIR=/tmp`) and compare their renderings. Renaming it turned every scenario into a
    // false divergence, because the old side stopped finding the capture and silently fell
    // back to diffing against HEAD. It says `ai` while the command is `agents`: deliberate
    // continuity, not an oversight.
    return join(tmpdir(), "GenesisTools", "ai", "hooks", "data");
}

/**
 * 🛑 Every identifier that becomes a path segment is validated HERE, at the boundary.
 *
 * `parseHookPayload` takes `session_id` and `tool_use_id` verbatim from the payload, and the
 * post phase ends with `rmSync(dir, { recursive: true, force: true })`. A `toolUseId` of
 * `../../..` would therefore resolve the capture directory back up to `hookDataRoot()` or
 * beyond, and the sweep would delete it. The harness is the only writer of those fields
 * today, which makes this unlikely rather than impossible — and the blast radius is a
 * recursive delete, so it is validated rather than trusted.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function safeSegment(value: string | undefined): string | null {
    if (!value || value === "." || value === ".." || !SAFE_SEGMENT.test(value)) {
        return null;
    }

    return value;
}

function requireSegment(kind: string, value: string): string {
    const safe = safeSegment(value);

    if (safe === null) {
        throw new Error(`refusing to build a capture path from an unsafe ${kind}: ${SafeJSON.stringify(value)}`);
    }

    return safe;
}

export function sessionDir(harness: string, sessionId: string): string {
    return join(hookDataRoot(), requireSegment("harness", harness), requireSegment("session id", sessionId));
}

export function callDir(harness: string, sessionId: string, toolUseId: string): string {
    return join(sessionDir(harness, sessionId), "diff", requireSegment("tool call id", toolUseId));
}

/**
 * Sibling of `hookDataRoot()`, holding one tiny record per rendered file change.
 *
 * It is deliberately NOT under the data root: `collectStaleCaptures` walks that as
 * `<harness>/<session>/diff/<call>`, and a directory of loose files there would be read as a
 * harness full of sessions.
 */
export function claimsRoot(): string {
    return join(tmpdir(), "GenesisTools", "ai", "hooks", "claims");
}
