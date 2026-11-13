import { isAbsolute, relative, sep } from "node:path";
import { canonicalPath } from "@genesiscz/utils/fs/canonical";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/** Source media is permanent; capture retention owns the separate audio folder. */
export const SOURCE_AUDIO_FOLDER = "source-audio";

/** Automatic cleanup must not nominate the archive, its contents, or a folder that could hold it. */
export function protectsMeetingSourceAudio(path: string): boolean {
    const root = canonicalPath(toolDataDir("meetings"));
    const candidate = canonicalPath(path);
    const fromCandidate = relative(candidate, root);
    if (
        fromCandidate === "" ||
        (!isAbsolute(fromCandidate) && fromCandidate !== ".." && !fromCandidate.startsWith(`..${sep}`))
    ) {
        return true;
    }

    const fromRoot = relative(root, candidate);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        return false;
    }

    const parts = fromRoot.split(sep);
    return parts.length === 1 || parts[1] === SOURCE_AUDIO_FOLDER;
}
