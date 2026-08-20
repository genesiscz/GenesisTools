// GitHub native pull-request stacks (public preview, 2026-07-30).
// REST PATCH /pulls/{n} {base} is rejected while the PR is in a stack.
// GraphQL cannot mutate stacks. Unstack via REST, then PATCH base — never close-and-reopen.

/** Exact GitHub REST 422 `errors[].message` for stacked-PR base changes. */
export const NATIVE_STACK_BASE_ERROR = "Cannot change the base branch because the pull request is part of a stack.";

export interface NativeStackRecovery {
    owner: string;
    repo: string;
    parentNumber: number;
    childNumber: number;
    newBase: string;
    stackNumber?: number | null;
}

/**
 * True when `err` is GitHub's native-stack base-change 422 (or a wrapper that
 * quotes that message). Close-and-reopen is not a valid response to this error.
 */
export function isNativeStackBaseError(err: unknown): boolean {
    const chunks: string[] = [];

    if (err instanceof Error) {
        chunks.push(err.message);
    } else if (err != null) {
        chunks.push(String(err));
    }

    if (err && typeof err === "object") {
        const rec = err as {
            response?: { data?: { message?: string; errors?: Array<{ message?: string }> } };
            errors?: Array<{ message?: string }>;
        };
        const data = rec.response?.data;

        if (data?.message) {
            chunks.push(data.message);
        }

        for (const item of data?.errors ?? rec.errors ?? []) {
            if (item?.message) {
                chunks.push(item.message);
            }
        }
    }

    return chunks.some((chunk) => chunk.includes(NATIVE_STACK_BASE_ERROR));
}

/** Read `stack.number` from a pulls.get / pulls.list payload (null if unstacked). */
export function parsePullStackNumber(data: unknown): number | null {
    if (!data || typeof data !== "object") {
        return null;
    }

    const stack = (data as { stack?: unknown }).stack;
    if (!stack || typeof stack !== "object") {
        return null;
    }

    const n = (stack as { number?: unknown }).number;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        return null;
    }

    return n;
}

/**
 * Exact recovery commands after a native-stack retarget failure.
 * The parent SHA is already on the base; the child PR number stays the same.
 */
export function formatNativeStackRecovery(input: NativeStackRecovery): string[] {
    const repo = `${input.owner}/${input.repo}`;
    const lines = [
        `Child #${input.childNumber} is still OPEN (same number). Do not close and reopen it.`,
        `GitHub native stacks reject PATCH base: ${NATIVE_STACK_BASE_ERROR}`,
    ];

    if (input.stackNumber != null) {
        lines.push(`gh api -X POST repos/${repo}/stacks/${input.stackNumber}/unstack`);
        lines.push(`gh api -X PATCH repos/${repo}/pulls/${input.childNumber} -f base='${input.newBase}'`);
    } else {
        lines.push(`gh api repos/${repo}/pulls/${input.childNumber} --jq .stack.number`);
        lines.push(`gh api -X POST repos/${repo}/stacks/<stack-number>/unstack`);
        lines.push(`gh api -X PATCH repos/${repo}/pulls/${input.childNumber} -f base='${input.newBase}'`);
    }

    return lines;
}
