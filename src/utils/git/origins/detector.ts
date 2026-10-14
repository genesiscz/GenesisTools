import { Executor } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { ghDriver } from "./gh";
import { glabDriver } from "./glab";
import { spawnRunner } from "./runner";
import type { CommandRunner, OriginDriver, OriginKind } from "./types";

export interface OriginInfo {
    url: string;
    host: string | null;
    kind: OriginKind | null;
}

/**
 * Which host a remote URL points at. Pure, so the shapes are pinned by tests:
 * scp-like (`git@host:o/r.git`), ssh/https URLs with or without a user and a
 * port. GitHub is `github.com` itself; anything with `gitlab` in the host
 * (`gitlab.com`, `gitlab.internal.example`) is GitLab; everything else has no driver.
 */
export function classifyOriginUrl(url: string): OriginInfo {
    const trimmed = url.trim();
    let host: string | null = null;

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        try {
            host = new URL(trimmed).hostname.toLowerCase();
        } catch (err) {
            logger.debug({ err, url: trimmed }, "origins: unparsable remote URL");
        }
    } else {
        const scp = /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed);
        host = scp?.[1]?.toLowerCase() ?? null;
    }

    if (!host) {
        return { url: trimmed, host: null, kind: null };
    }

    if (host === "github.com" || host.endsWith(".github.com")) {
        return { url: trimmed, host, kind: "github" };
    }

    if (host.includes("gitlab")) {
        return { url: trimmed, host, kind: "gitlab" };
    }

    return { url: trimmed, host, kind: null };
}

/**
 * A remote that is a folder on this machine, not a forge: a relative path (`repos/source.git`, `source.git`),
 * a home or absolute path, a `file:` URL, a Windows drive (`C:\repo`, `C:repo`) or a UNC path
 * (`\\server\share`). A URL scheme or an scp-like `host:path` (a colon before any slash) is a network remote.
 * A local folder has no forge, so nothing can list its pull requests.
 */
export function isLocalRemoteUrl(url: string): boolean {
    const trimmed = url.trim();

    // `file:/path` and `file:///path` are a folder. Any other scheme is a network remote.
    if (/^file:/i.test(trimmed)) {
        return true;
    }

    if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        return false;
    }

    // `C:\repo`, `C:/repo`, and a drive-relative `C:repo`. A leading letter and colon is a DOS drive, not an scp host.
    if (/^[A-Za-z]:/.test(trimmed)) {
        return true;
    }

    // `/repo`, `\repo`, `\\server\share`, `//server/share`.
    if (/^[/\\]/.test(trimmed)) {
        return true;
    }

    const slash = trimmed.search(/[/\\]/);
    const colon = trimmed.indexOf(":");

    // `[user@]host:path`, only when no slash comes first. `./foo:bar` is a local path that contains a colon.
    if (colon >= 0 && (slash < 0 || colon < slash)) {
        return false;
    }

    return true;
}

/** The `origin` remote of `cwd`, classified; null when there is no origin. */
export async function detectOrigin(cwd: string): Promise<OriginInfo | null> {
    const res = await new Executor({ prefix: "git", cwd }).exec(["remote", "get-url", "origin"]);

    if (!res.success || !res.stdout) {
        return null;
    }

    return classifyOriginUrl(res.stdout);
}

/**
 * The driver for `cwd`'s origin, or null with a debug line naming the host.
 * Callers that need corroboration print "no origin driver for <host>" and
 * continue without it.
 */
export async function originDriver(cwd: string, runner: CommandRunner = spawnRunner): Promise<OriginDriver | null> {
    const origin = await detectOrigin(cwd);

    if (!origin?.kind) {
        logger.debug({ host: origin?.host ?? null }, "origins: no driver for this origin");
        return null;
    }

    return origin.kind === "github" ? ghDriver(cwd, runner) : glabDriver(cwd, runner);
}
