import { logger } from "@genesiscz/utils/logger";
import type { OriginInfo } from "./detector";

/**
 * The browser URL of a remote's project page: scp-like `git@host:g/p.git`, `ssh://git@host:2222/g/p.git`
 * and `https://user@host/g/p.git` all become `https://host/g/p`. An ssh port is dropped (it is not the
 * web port); an http(s) port is kept, and so is a plain `http:` scheme. Null when the URL has no host or no
 * project path.
 */
export function originWebBase(url: string): string | null {
    const trimmed = url.trim();
    let host: string;
    let path: string;
    let scheme = "https";

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        let parsed: URL;

        try {
            parsed = new URL(trimmed);
        } catch (err) {
            logger.debug({ err, url: trimmed }, "origins/web: unparsable remote URL");
            return null;
        }

        host = parsed.protocol.startsWith("http") ? parsed.host : parsed.hostname;
        scheme = parsed.protocol === "http:" ? "http" : "https";
        path = parsed.pathname;
    } else {
        const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);

        if (!scp) {
            return null;
        }

        host = scp[1];
        path = scp[2];
    }

    const project = path
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/\.git$/, "");

    if (!host || !project) {
        return null;
    }

    return `${scheme}://${host.toLowerCase()}/${project}`;
}

function encodePath(value: string): string {
    return value.split("/").map(encodeURIComponent).join("/");
}

/** The branch page: `/tree/<b>` on GitHub, `/-/tree/<b>` on GitLab; null for other hosts. */
export function branchWebUrl(origin: OriginInfo, branch: string): string | null {
    const base = originWebBase(origin.url);

    if (!base || !origin.kind || !branch || branch === "HEAD") {
        return null;
    }

    return `${base}${origin.kind === "github" ? "/tree/" : "/-/tree/"}${encodePath(branch)}`;
}

/** The commit page: `/commit/<sha>` on GitHub, `/-/commit/<sha>` on GitLab; null for other hosts. */
export function commitWebUrl(origin: OriginInfo, sha: string): string | null {
    const base = originWebBase(origin.url);

    if (!base || !origin.kind || !sha) {
        return null;
    }

    return `${base}${origin.kind === "github" ? "/commit/" : "/-/commit/"}${sha}`;
}
