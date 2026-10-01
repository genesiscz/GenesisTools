import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extensionProfiles } from "@genesiscz/utils/browser-extension/profiles";
import { BROWSER_EXTENSIONS, type BrowserExtensionEntry } from "@genesiscz/utils/browser-extension/registry";
import { suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isRecord } from "../values";
import { hostStatus } from "./install";

function builtHostPermissions(distDir: string): string[] {
    const file = join(distDir, "manifest.json");

    if (!existsSync(file)) {
        return [];
    }

    let manifest: unknown;

    try {
        manifest = SafeJSON.parse(readFileSync(file, "utf8"), { strict: true });
    } catch (error) {
        // A damaged build must not break status and install; they report it as having no hosts.
        logger.warn({ error, file }, "browser-extension: the built manifest is unreadable");
        return [];
    }

    const hosts = isRecord(manifest) ? manifest.host_permissions : undefined;
    return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === "string") : [];
}

/** `tools <args...>` as a runnable suggestion. */
function toolsCommand(args: string[]): string {
    const [tool, ...rest] = args;
    return suggestCommand(`tools ${tool}`, { replaceCommand: rest });
}

/** One finding about one extension: `ok` when nothing needs doing, else `fix` names the next step. */
export interface ExtensionCheck {
    extension: string;
    ok: boolean;
    message: string;
    fix: string[];
}

function checksFor(entry: BrowserExtensionEntry): ExtensionCheck[] {
    const manifest = join(entry.distDir, "manifest.json");
    const build = `build: ${toolsCommand(entry.buildArgs)}`;
    const load = `load: brave://extensions (or chrome://extensions) > Developer mode > Load unpacked > ${entry.distDir}`;
    const check = (ok: boolean, message: string, fix: string[] = []): ExtensionCheck => ({
        extension: entry.name,
        ok,
        message: `${entry.name} extension: ${message}`,
        fix,
    });

    if (!existsSync(manifest)) {
        return [check(false, `not built (${entry.purpose})`, [build, load])];
    }

    const loaded = extensionProfiles({
        extensionId: entry.id,
        wanted: builtHostPermissions(entry.distDir),
        builtAt: statSync(manifest).mtimeMs,
    }).filter((profile) => profile.loaded);

    if (loaded.length === 0) {
        return [check(false, `not loaded in any browser (${entry.purpose})`, [load])];
    }

    const checks = loaded.map((profile) =>
        profile.stale
            ? check(false, `OLDER BUILD in ${profile.browser} (${profile.profile})`, [
                  `reload: ${toolsCommand(entry.reloadArgs)}`,
              ])
            : check(true, `loaded in ${profile.browser} (${profile.profile})`)
    );

    if (entry.status === "native-host") {
        const hosts = hostStatus();
        const unreachable = hosts.browsers.some((browser) =>
            loaded.some((profile) => profile.browser === browser.browser && !browser.allowsThisId)
        );

        if (!hosts.launcherExists || unreachable) {
            checks.push(
                check(false, "its native host is not registered, so it cannot ask the router", [
                    `run: ${toolsCommand(["browser-extension", "install-host"])}`,
                ])
            );
        }
    }

    return checks;
}

/**
 * The state of every GenesisTools extension: not built, not loaded, an older build than `dist` (a
 * Reload is due), or a native host out of reach. Read-only. `tools browser-router status` and
 * `tools doctor` both report it.
 */
export function extensionChecks(): ExtensionCheck[] {
    return BROWSER_EXTENSIONS.flatMap(checksFor);
}

/** `extensionChecks()` as printable lines, each fix indented under its finding. */
export function extensionAdvice(): string[] {
    return extensionChecks().flatMap((check) => [check.message, ...check.fix.map((line) => `  ${line}`)]);
}
