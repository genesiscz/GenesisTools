import { askHeadless, capText } from "./agent";
import type { Deps } from "./deps";
import { FeatureError } from "./errors";
import { type PageRequest, resolveRequest } from "./open";
import { checkLine, checkRelativePath } from "./values";

const HUNK_CAP = 20_000;

export interface ExplainRequest extends PageRequest {
    hunk: unknown;
    path?: unknown;
    line?: unknown;
}

function checkHunk(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new FeatureError("invalid", "select the diff lines to explain first");
    }

    if (value.length > HUNK_CAP) {
        throw new FeatureError("invalid", `the selection is ${value.length} characters; the cap is ${HUNK_CAP}`);
    }

    return value.replaceAll("\0", "");
}

export function explainPrompt({
    where,
    path,
    line,
    root,
    branch,
    hunk,
}: {
    where: string;
    path: string | null;
    line: number | null;
    root: string;
    branch: string | null;
    hunk: string;
}): string {
    const file = path ? `${path}${line ? ` around line ${line}` : ""}` : "unknown (read it from the hunk)";

    return [
        `Explain this diff hunk from ${where}.`,
        `File: ${file}. Local checkout: ${root}${branch ? ` on branch ${branch}` : ""}.`,
        "Read files in this checkout when it helps. Do not edit, run or commit anything.",
        "Answer in at most 12 short lines: what the hunk changes, the likely reason, and any risk you see.",
        "",
        "```diff",
        capText(hunk),
        "```",
        "",
    ].join("\n");
}

/** Asks the headless agent about a hunk, in the page's local checkout; the hunk travels on stdin. */
export async function explainHunk(deps: Deps, request: ExplainRequest): Promise<{ answer: string; root: string }> {
    const hunk = checkHunk(request.hunk);
    const path =
        request.path === undefined || request.path === null || request.path === ""
            ? null
            : checkRelativePath(request.path);
    const line = checkLine(request.line) ?? null;
    const config = await deps.config();
    const resolved = await resolveRequest(deps, request);
    const { page, checkout } = resolved;
    const where = page.number
        ? `${page.webBase} (${page.kind === "github" ? "PR #" : "MR !"}${page.number})`
        : page.webBase;
    const answer = await askHeadless({
        deps,
        config,
        cwd: checkout.root,
        prompt: explainPrompt({ where, path, line, root: checkout.root, branch: checkout.branch, hunk }),
    });
    return { answer, root: checkout.root };
}
