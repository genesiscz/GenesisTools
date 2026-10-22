import { existsSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig } from "@app/browser-extension/lib/config";
import { configuredCheckouts } from "@app/browser-extension/lib/deps";
import { type LocalCheckout, rankCheckouts } from "@genesiscz/utils/git/local-checkouts";
import { parsePrRef } from "@genesiscz/utils/git/origins";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "hub/pr/project-ref" });

export type HubPrRef = { url: string } | { path: string; number: number };

export interface CheckoutSource {
    roots: string[];
    checkouts: LocalCheckout[];
}

export async function liveCheckouts(): Promise<CheckoutSource> {
    const config = await loadConfig();
    return { roots: config.repoRoots, checkouts: configuredCheckouts(config) };
}

/**
 * A PR/MR ref the hub can open, with a project named by its web path looked up among every checkout
 * under the repo roots: `group/sub/app!12` (GitLab's form), `owner/repo#42`, `gitlab.example/group/app!12`,
 * or only `app!12` when one project has that name. A URL, a folder and a bare number read as `parsePrRef`
 * reads them. With no checkout, `owner/repo#42` is still a github.com PR; anything else is a `problem`.
 */
export async function resolveHubPrRef(
    ref: string,
    { source = liveCheckouts }: { source?: () => Promise<CheckoutSource> } = {}
): Promise<HubPrRef | { problem: string }> {
    const trimmed = ref.trim();
    const named = /^([^\s#!]+)([#!])(\d+)$/.exec(trimmed);

    const url = /^https?:\/\//i.test(trimmed);

    // A folder named like `./app!12` is that folder, as `./app#12` is: `parsePrRef` reads only the `#` form.
    if (named && !url && named[2] === "!" && /^[~./]/.test(named[1])) {
        return { path: named[1], number: Number(named[3]) };
    }

    if (!named || url || /^[~./]/.test(named[1]) || (named[2] === "#" && existsSync(named[1]))) {
        return (
            parsePrRef(trimmed) ?? {
                problem: `expected a PR/MR URL, <repoPath>#<number> or <project>!<number>, got "${ref}"`,
            }
        );
    }

    const [, name, sign, digits] = named;
    let roots: string[] = [];
    let checkouts: LocalCheckout[] = [];

    // A config or scan failure must not break `owner/repo#42`, which needs no checkout to read as a github.com PR.
    try {
        ({ roots, checkouts } = await source());
    } catch (err) {
        log.warn({ err, ref }, "hub pr: could not list the local checkouts; reading the ref without them");
    }

    const found = checkoutOf(name, checkouts);

    if ("root" in found) {
        log.debug({ ref, root: found.root }, "hub pr: project ref resolved to a checkout");
        return { path: found.root, number: Number(digits) };
    }

    if (found.projects.length > 1) {
        return {
            problem: `${name} names ${found.projects.length} projects (${found.projects.join(", ")}); use the whole path`,
        };
    }

    const github = sign === "#" ? parsePrRef(trimmed) : null;

    if (github && "url" in github) {
        log.debug({ ref, url: github.url }, "hub pr: no checkout of the project, read as a github.com PR");
        return github;
    }

    log.debug({ ref, roots, checkouts: checkouts.length }, "hub pr: no checkout of the project");
    return {
        problem: `no checkout of ${name} under the repo roots (${roots.join(", ")}); open it by its page URL, or clone it there`,
    };
}

/**
 * The best checkout of the one project `name` names: its whole web path (with or without the host), else
 * the end of one (`daf-fe` for `group/daf/daf-fe`). Letter case does not matter, as on the forges.
 */
function checkoutOf(name: string, checkouts: LocalCheckout[]): { root: string } | { projects: string[] } {
    const wanted = name
        .toLowerCase()
        .replace(/\.git$/, "")
        .replace(/^\/+|\/+$/g, "");
    const key = (checkout: LocalCheckout) => `${checkout.project.host}/${checkout.project.path}`;
    const exact = checkouts.filter((checkout) => checkout.project.path === wanted || key(checkout) === wanted);
    const pool =
        exact.length > 0 ? exact : checkouts.filter((checkout) => checkout.project.path.endsWith(`/${wanted}`));
    const projects = [...new Set(pool.map(key))];

    if (projects.length !== 1) {
        return { projects };
    }

    const best = preferredCheckout(rankCheckouts({ project: pool[0].project, checkouts: pool }));
    return best ? { root: best.root } : { projects };
}

/**
 * The checkout a link of one project opens, from its checkouts best first (`rankCheckouts`): a main checkout
 * before a worktree, and of two clones the folder named like the project (`app`, not `app-v2`).
 */
export function preferredCheckout(ranked: LocalCheckout[]): LocalCheckout | undefined {
    const mains = ranked.filter((checkout) => checkout.isMain);
    const pool = mains.length > 0 ? mains : ranked;
    return pool.find((checkout) => namedLikeProject(checkout.root, checkout.project.path)) ?? pool[0];
}

/** Whether a checkout's folder carries its project's name (the last segment of the web path), in any case. */
export function namedLikeProject(root: string, web: string): boolean {
    const name = web.replace(/\/+$/, "").split("/").pop() ?? "";
    return basename(root).toLowerCase() === name.toLowerCase();
}
