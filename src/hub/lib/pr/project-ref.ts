import { existsSync } from "node:fs";
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

async function liveCheckouts(): Promise<CheckoutSource> {
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

    if (!named || /^https?:\/\//i.test(trimmed) || /^[~./]/.test(named[1]) || existsSync(named[1])) {
        return (
            parsePrRef(trimmed) ?? {
                problem: `expected a PR/MR URL, <repoPath>#<number> or <project>!<number>, got "${ref}"`,
            }
        );
    }

    const [, name, sign, digits] = named;
    const { roots, checkouts } = await source();
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

    const best = rankCheckouts({ project: pool[0].project, checkouts: pool })[0];
    return best ? { root: best.root } : { projects };
}
