import { spawnSync } from "node:child_process";
import { linkQuery } from "./query";

/**
 * Opening a file in Genesis Markdown when it is installed, and in the file's default app when it is not. Imports
 * nothing but `./query`, so another repo can copy it without the router or the hub links in targets.ts.
 */

export interface GenesisMdFile {
    path: string;
    /** Lines to highlight, `"12"` or `"12-30"`. */
    range?: string;
}

/** `genesis-md://open?path=…&range=…`, slashes kept. The one builder: targets.ts's genesis-md preset uses it too. */
export function genesisMdLink(file: GenesisMdFile): string {
    return `genesis-md://open${linkQuery(
        [
            ["path", file.path],
            ["range", file.range],
        ],
        { keepSlash: true }
    )}`;
}

// AppKit through osascript's JavaScript bridge, which every macOS has: about 80 ms, so it runs once per process.
const HANDLER_PROBE =
    'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(' +
    '$.NSURL.URLWithString("genesis-md://open")); u.isNil() ? "none" : ObjC.unwrap(u.path)';

/** The app that opens genesis-md links (e.g. `/Applications/Genesis Markdown.app`), or null when none does. */
export function genesisMdHandlerPath(): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    const probe = spawnSync("osascript", ["-l", "JavaScript", "-e", HANDLER_PROBE], {
        encoding: "utf8",
        timeout: 5_000,
    });
    const found = probe.stdout?.trim();

    return probe.status === 0 && found && found !== "none" ? found : null;
}

let handlerKnown: boolean | undefined;

/** Whether this Mac has an app for genesis-md links. Probed once per process; a passed `probe` is never cached. */
export function hasGenesisMdHandler(probe?: () => string | null): boolean {
    if (probe) {
        return probe() !== null;
    }

    handlerKnown ??= genesisMdHandlerPath() !== null;
    return handlerKnown;
}

/**
 * What `open` should get for a file: the genesis-md link when an app handles it, else the plain absolute path, which
 * `open` gives to the file's default app (`open genesis-md://…` with no handler fails: "could not open").
 */
export function openFileTarget(path: string, range?: string, options: { hasHandler?: boolean } = {}): string {
    const handled = options.hasHandler ?? hasGenesisMdHandler();
    return handled ? genesisMdLink({ path, range }) : path;
}
