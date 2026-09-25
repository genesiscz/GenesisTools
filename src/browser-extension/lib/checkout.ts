import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
    checkoutsAt,
    type LocalCheckout,
    type ProjectRef,
    projectRefFromUrl,
    rankCheckouts,
    sameProject,
} from "@genesiscz/utils/git/local-checkouts";
import { logger } from "@genesiscz/utils/logger";
import type { BrowserExtensionConfig } from "./config";
import { FeatureError } from "./errors";
import { type ForgePage, parseForgeUrl, splitRefPath } from "./page-url";
import { checkRelativePath } from "./values";

export interface ResolvedPage {
    page: ForgePage;
    project: ProjectRef;
    /** Best first: a worktree on the requested branch, then the main checkout. */
    candidates: LocalCheckout[];
    checkout: LocalCheckout;
}

const log = logger.child({ component: "browser-extension/checkout" });

export function forgePage(url: unknown, config: BrowserExtensionConfig): ForgePage {
    const page = typeof url === "string" ? parseForgeUrl(url, config.gitlabHosts) : null;

    if (!page) {
        throw new FeatureError(
            "invalid",
            "not a GitHub or GitLab project page (add self-hosted GitLab to gitlabHosts)"
        );
    }

    return page;
}

/** The local checkouts of the project a page belongs to; a `repos` entry wins over the scan. */
export function resolvePage({
    url,
    branch,
    config,
    checkouts,
}: {
    url: unknown;
    branch?: string;
    config: BrowserExtensionConfig;
    checkouts: () => LocalCheckout[];
}): ResolvedPage {
    const page = forgePage(url, config);
    const project = projectRefFromUrl(page.webBase);

    if (!project) {
        throw new FeatureError("invalid", `cannot read a project from ${page.webBase}`);
    }

    const mapped = Object.entries(config.repos).find(([key]) => {
        const ref = projectRefFromUrl(key);
        return ref !== null && sameProject(ref, project);
    });
    const pool = mapped ? checkoutsAt(mapped[1]).map((checkout) => ({ ...checkout, project })) : checkouts();
    const candidates = rankCheckouts({ project, checkouts: pool, branch });
    const checkout = candidates[0];
    log.debug(
        { project, branch: branch ?? null, mapped: mapped?.[1] ?? null, pool: pool.length, found: candidates.length },
        "resolve page"
    );

    if (!checkout) {
        const where = config.repoRoots.length > 0 ? config.repoRoots.join(", ") : "(no repoRoots configured)";
        throw new FeatureError(
            "no-checkout",
            `no local checkout of ${project.host}/${project.path} under ${where}. Clone it there, or map it in "repos".`
        );
    }

    return { page, project, candidates, checkout };
}

/**
 * The file a page names, as an absolute path inside the checkout: from an explicit `path` (a diff),
 * else from a blob URL split against the local branch names. The result must exist and stay inside
 * the checkout after symlinks are resolved.
 */
export function fileInCheckout(resolved: ResolvedPage, path?: unknown): string | null {
    let relative: string | null = null;

    if (path !== undefined && path !== null && path !== "") {
        relative = checkRelativePath(path);
    } else if (resolved.page.refPath) {
        const branches = resolved.candidates.flatMap((checkout) => (checkout.branch ? [checkout.branch] : []));
        const split = splitRefPath(resolved.page.refPath, branches).path;
        relative = split ? checkRelativePath(split) : null;
    }

    if (!relative) {
        return null;
    }

    const root = realpathSync(resolved.checkout.root);
    const absolute = join(root, relative);

    if (!existsSync(absolute)) {
        throw new FeatureError("invalid", `${relative} does not exist in ${resolved.checkout.root}`);
    }

    const real = realpathSync(absolute);

    if (real !== root && !real.startsWith(`${root}${sep}`)) {
        throw new FeatureError("invalid", `${relative} resolves outside the checkout`);
    }

    return real;
}
