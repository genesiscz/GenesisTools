import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { UrlSource } from "@genesiscz/utils/ai/local/artifacts/sources/url";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

const { log } = logger.scoped("transcribe-downloads");

/** A file the transcript checks fetch on first use, so the repository does not ship it (size or licence). */
export interface Download {
    /** The path under `~/.genesis-tools/downloads/transcribe/`. */
    file: string;
    /** Pinned to a commit, so `sha256` stays true. */
    url: string;
    sha256: string;
    license: string;
}

export function downloadPath(download: Download): string {
    return join(new Storage("downloads").getBaseDir(), "transcribe", download.file);
}

let source: UrlSource | undefined;

/** The local path of `download`, fetched and checked against its sha256 the first time. */
export async function ensureDownload(download: Download): Promise<string> {
    const file = downloadPath(download);

    if (!existsSync(file)) {
        // One short line, so a first run that waits for the download says why; the URL and the path go to the day log
        // only (a block of them per file filled the console of a first suggest, R2-MC2).
        ui.dim(`Downloading ${basename(file)} for the word check (${download.license}); only this once.`);
        log.debug({ url: download.url, license: download.license, file }, "downloading a transcript check file");
    }

    source ??= new UrlSource();
    const { path } = await source.ensure({ source: "url", locator: download.url, file, sha256: download.sha256 });

    return path;
}
