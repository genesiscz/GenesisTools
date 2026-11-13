import { createHash } from "node:crypto";

/**
 * The code stamp a resident service and its callers compare in `hello` (`ServiceHostOptions.code`): the checkout the
 * code runs from, as 12 hex characters. A worktree's CLI and the main checkout's service differ, so the worktree
 * answers with its own code. The Meetings and metrics services both use it.
 */
export function checkoutCodeStamp(root: string): string {
    return createHash("sha1").update(root).digest("hex").slice(0, 12);
}
