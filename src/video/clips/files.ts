import { existsSync, linkSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { ClipProviderId } from "./types";

/**
 * ffmpeg may open only these protocols for a clip or VOD input and every playlist and segment it names: a remote answer
 * then cannot point ffmpeg at a local file, a pipe or another protocol.
 */
const FFMPEG_INPUT_PROTOCOLS = "https,tls,tcp,crypto";

/** One part of a file name from a site's answer (a channel, an id, a date): any other character becomes `-`. */
export function fileNamePart(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Joins the non-empty parts into `<parts>.mp4` and refuses a name that is not one plain file name. */
export function mp4FileName(parts: string[]): string {
    const name = `${parts.filter(Boolean).join("-")}.mp4`;

    if (name !== basename(name) || name.startsWith(".") || name.length > 240) {
        throw new Error(`"${name}" is not a file name this tool writes`);
    }

    return name;
}

/** The size of a regular file at `path`; 0 when nothing, an empty file or something else (a folder) is there. */
export function regularFileBytes(path: string): number {
    if (!existsSync(path)) {
        return 0;
    }

    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
}

/** True for a host name ffmpeg must not be sent to: this Mac, a private network or an IP literal. */
function isLocalHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        /^\d+(\.\d+){3}$/.test(host) ||
        host.includes(":")
    );
}

/** `url` when it is an https URL on a public host name, else throws: a site's answer decides what ffmpeg opens. */
export function requireRemoteHttpsUrl(url: string, what: string): string {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        logger.debug({ what }, "Media URL does not parse");
        throw new Error(`${what}: the site answered a media URL that does not parse`);
    }

    if (parsed.protocol !== "https:" || isLocalHost(parsed.hostname) || parsed.username || parsed.password) {
        throw new Error(`${what}: the site answered a media URL that is not https on a public host (${parsed.origin})`);
    }

    return url;
}

const MEDIA_HOSTS: Record<ClipProviderId, readonly string[]> = {
    kick: ["kick.com", "live-video.net", "cloudfront.net"],
    twitch: ["twitch.tv", "ttvnw.net", "twitchcdn.net", "cloudfront.net"],
};

export function requireProviderMediaUrl(url: string, provider: ClipProviderId): string {
    requireRemoteHttpsUrl(url, `${provider} media`);
    const parsed = new URL(url);
    if (
        (parsed.port && parsed.port !== "443") ||
        !MEDIA_HOSTS[provider].some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
    ) {
        throw new Error(`${provider} answered a media URL outside its supported CDN hosts`);
    }
    return url;
}

/** Check the playlists, segments and encryption keys before an external media process reads the playlist. */
export function validateProviderPlaylist(text: string, base: string, provider: ClipProviderId): void {
    if (!text.trimStart().startsWith("#EXTM3U")) {
        return;
    }
    for (const line of text.split(/\r?\n/)) {
        const value = line.trim();
        if (value && !value.startsWith("#")) {
            requireProviderMediaUrl(new URL(value, base).href, provider);
        }
        for (const match of value.matchAll(/URI="([^"]+)"/g)) {
            requireProviderMediaUrl(new URL(match[1], base).href, provider);
        }
    }
}

/** `ffmpeg -c copy` from `input` into an MP4 at `output`; `cut` seeks to a keyframe and stops after `lengthSec`. */
export function copyToMp4Command({
    input,
    output,
    cut,
}: {
    input: string;
    output: string;
    cut?: { fromSec: number; lengthSec: number };
}): string[] {
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-protocol_whitelist",
        FFMPEG_INPUT_PROTOCOLS,
        ...(cut ? ["-ss", String(cut.fromSec)] : []),
        "-i",
        input,
        ...(cut ? ["-t", String(cut.lengthSec)] : []),
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        output,
    ];
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * `write` fills a file in a private folder made for this run beside `output` (`.video-part-XXXXXX/`), so two runs never
 * share a half-written file and nothing planted there redirects the write. The file then becomes `output`: with
 * `force` it replaces what is there, without it a file that appeared meanwhile stays and the result is `exists`. The
 * private folder is removed whether `write` succeeds, fails or is cancelled.
 */
export async function writeThenPublish({
    output,
    force,
    write,
}: {
    output: string;
    force: boolean;
    write: (partPath: string) => Promise<unknown>;
}): Promise<"saved" | "exists"> {
    const staging = mkdtempSync(join(dirname(output), ".video-part-"));

    try {
        const part = join(staging, basename(output));
        await write(part);

        if (force) {
            renameSync(part, output);
            return "saved";
        }

        try {
            // A hard link publishes only when no file has the name; rename would replace one.
            linkSync(part, output);
            return "saved";
        } catch (error) {
            if (errorCode(error) === "EEXIST") {
                return "exists";
            }

            throw new Error(
                "The filesystem cannot publish this file without replacement; use --force to permit replacement",
                { cause: error }
            );
        }
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
