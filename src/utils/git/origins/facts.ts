import type { OriginKind } from "./types";

/**
 * The static facts of one forge: its words, its web paths, its CLI and the fields its API names differently.
 * A caller reads a fact here instead of comparing `kind` inline. Behaviour (which API to call, how to parse its
 * rows) stays in the drivers and backends (`OriginDriver`, `PrBackend`, the watch fetchers) and switches there.
 */
export interface ForgeFacts {
    /** `GitHub`, `GitLab`. */
    name: string;
    /** The mark before a PR number in a ref: `owner/repo#12`, `group/app!12`. */
    mark: "#" | "!";
    /** `PR`, `MR`. */
    noun: string;
    /** `pull request`, `merge request`. */
    longNoun: string;
    /** The CLI that talks to the forge. */
    binary: "gh" | "glab";
    /** The host the CLI asks without `--hostname`. */
    defaultHost: string;
    /** The field of the API's user object that holds the login. */
    loginField: "login" | "username";
    /** Web paths under a project page (`https://host/owner/repo`), with no leading or trailing slash. */
    web: {
        /** The PR page is `<project>/<pr>/<n>`. */
        pr: string;
        /** The branch page is `<project>/<tree>/<branch>`. */
        tree: string;
        /** The commit page is `<project>/<commit>/<sha>`. */
        commit: string;
        /** The tabs under a PR page. */
        prTabs: { files: string; commits: string; checks: string };
    };
    /** A PR page's URL path: group 1 is the project path, group 2 the number; a trailing tab is allowed. */
    prPath: RegExp;
    /** The host's own ref namespace for PR heads: `<headRefs>/<n>/head`. */
    headRefs: string;
}

/** One entry per forge; the compiler names a forge without one. */
export const FORGE_FACTS = {
    github: {
        name: "GitHub",
        mark: "#",
        noun: "PR",
        longNoun: "pull request",
        binary: "gh",
        defaultHost: "github.com",
        loginField: "login",
        web: {
            pr: "pull",
            tree: "tree",
            commit: "commit",
            prTabs: { files: "files", commits: "commits", checks: "checks" },
        },
        prPath: /^\/(.+?)\/pull\/(\d+)(?:\/.*)?$/,
        headRefs: "refs/pull",
    },
    gitlab: {
        name: "GitLab",
        mark: "!",
        noun: "MR",
        longNoun: "merge request",
        binary: "glab",
        defaultHost: "gitlab.com",
        loginField: "username",
        web: {
            pr: "-/merge_requests",
            tree: "-/tree",
            commit: "-/commit",
            prTabs: { files: "diffs", commits: "commits", checks: "pipelines" },
        },
        prPath: /^\/(.+?)\/(?:-\/)?merge_requests\/(\d+)(?:\/.*)?$/,
        headRefs: "refs/merge-requests",
    },
} satisfies Record<OriginKind, ForgeFacts>;

/** `#12` on GitHub, `!12` on GitLab. */
export function prNumberLabel(kind: OriginKind, number: number): string {
    return `${FORGE_FACTS[kind].mark}${number}`;
}

/** The PR page: `https://github.com/o/r/pull/12`, `https://gitlab.host/g/p/-/merge_requests/12`. */
export function prWebUrl(kind: OriginKind, projectWeb: string, number: number): string {
    return `${projectWeb}/${FORGE_FACTS[kind].web.pr}/${number}`;
}
