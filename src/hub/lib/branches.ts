import { createGit } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "hub/branches" });

/** A code span (`name`) or a bare token with a slash (`feat/x`): the shapes a branch takes in prose. */
const CODE_SPAN = /`([^`\s]+)`/g;
const SLASH_TOKEN = /(?<![\w./-])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g;

/**
 * Branch names from `refs/heads/*` and `refs/remotes/<remote>/*`, without the prefix. A remote's
 * `HEAD` alias is not a branch.
 */
export function branchNamesFromRefs(refs: string[]): Set<string> {
    const names = new Set<string>();

    for (const ref of refs) {
        let name: string | null = null;

        if (ref.startsWith("refs/heads/")) {
            name = ref.slice("refs/heads/".length);
        } else if (ref.startsWith("refs/remotes/")) {
            const rest = ref.slice("refs/remotes/".length);
            const slash = rest.indexOf("/");
            name = slash > 0 ? rest.slice(slash + 1) : null;
        }

        if (name && name !== "HEAD") {
            names.add(name);
        }
    }

    return names;
}

/**
 * The names in a PR/MR description that are branches of the checkout, in first-seen order. Only
 * code spans and slash tokens are candidates, so a word like "develop" in a sentence is never one;
 * fenced code blocks and link targets are skipped.
 */
export function branchMentions(body: string, known: Set<string>): string[] {
    const prose = body.replace(/```[\s\S]*?(```|$)/g, " ").replace(/\]\([^)]*\)/g, "]");
    const found: string[] = [];
    const add = (candidate: string) => {
        const name = candidate.replace(/[.,;:!?)]+$/, "");

        if (known.has(name) && !found.includes(name)) {
            found.push(name);
        }
    };

    for (const match of prose.matchAll(CODE_SPAN)) {
        add(match[1]);
    }

    for (const match of prose.matchAll(SLASH_TOKEN)) {
        add(match[0]);
    }

    return found;
}

/** The local and remote-tracking branch names of a checkout; empty when git cannot list them. */
export async function localBranchNames(root: string): Promise<Set<string>> {
    try {
        const refs = await createGit({ cwd: root }).refs(["refs/heads", "refs/remotes"]);
        const names = branchNamesFromRefs(refs.map((ref) => ref.ref));
        log.debug({ root, count: names.size }, "branch names");
        return names;
    } catch (error) {
        log.warn({ error, root }, "branch names unavailable");
        return new Set();
    }
}
