import { logger } from "@genesiscz/utils/logger";
import { escapeJxa, runJxa } from "./jxa";

/**
 * Where Launch Services finds the app with this bundle id, or null when it knows none. This is the lookup
 * `open -b <id>` and a `<scheme>://` click use, so it answers "would it open" where Spotlight cannot: on
 * 2026-10-23 `mdfind kMDItemCFBundleIdentifier == …` found no app at all on a Mac with indexing on, while both
 * GenesisTools.app and Genesis Markdown.app opened. One osascript start, about 80 ms.
 */
export function appPathForBundleId(bundleId: string): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    const script =
        'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(' +
        `"${escapeJxa(bundleId)}"); u.isNil() ? "none" : ObjC.unwrap(u.path)`;

    try {
        const found = runJxa(script, 5_000);
        return found && found !== "none" ? found : null;
    } catch (error) {
        logger.debug({ error, bundleId }, "launch-services: the app lookup failed");
        return null;
    }
}

/** One process that Launch Services counts as a running application (a row of `lsappinfo list`). */
export interface RunningApplication {
    /**
     * The low half of its ASN. Launch Services numbers check-ins in order, so a lower number checked in earlier; it hands
     * a link, a banner click and a Dock reopen to the instance of the bundle with the lowest number.
     */
    order: number;
    name: string;
    bundleId: string | null;
    pid: number;
    /** `Foreground`, `UIElement` or `BackgroundOnly`. A delivery turns a `BackgroundOnly` instance into a `UIElement`. */
    type: string | null;
}

/** Parses `lsappinfo list`: one block per application, from `N) "Name" ASN:0x0-0x1c34a32e:` to the next. */
export function parseRunningApplications(text: string): RunningApplication[] {
    const blocks = text.split(/\n(?=\s*\d+\) ")/);
    return blocks.flatMap((block) => {
        const header = block.match(/^\s*\d+\) "([^"]*)" ASN:0x[0-9a-f]+-0x([0-9a-f]+):/i);
        const pid = block.match(/\bpid = (\d+)/)?.[1];

        if (!header || !pid) {
            return [];
        }

        return [
            {
                order: Number.parseInt(header[2], 16),
                name: header[1],
                bundleId: block.match(/bundleID="([^"]+)"/)?.[1] ?? null,
                pid: Number(pid),
                type: block.match(/\btype="([^"]+)"/)?.[1] ?? null,
            },
        ];
    });
}

/**
 * The running applications Launch Services knows, oldest check-in first; with `bundleId`, only that bundle's instances.
 * Empty off macOS and when `lsappinfo` fails (logged).
 */
export function runningApplications(bundleId?: string): RunningApplication[] {
    if (process.platform !== "darwin") {
        return [];
    }

    const proc = Bun.spawnSync(["lsappinfo", "list"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });

    if (proc.exitCode !== 0) {
        logger.debug(
            { exitCode: proc.exitCode, stderr: new TextDecoder().decode(proc.stderr).slice(-300) },
            "launch-services: lsappinfo list failed"
        );
        return [];
    }

    return parseRunningApplications(new TextDecoder().decode(proc.stdout))
        .filter((app) => bundleId === undefined || app.bundleId === bundleId)
        .sort((left, right) => left.order - right.order);
}
