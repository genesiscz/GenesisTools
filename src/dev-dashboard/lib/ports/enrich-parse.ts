import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

/** Pure helpers shared by enrich + probe (no Node process I/O). */

export function parsePackageName(json: string): string | null {
    try {
        const parsed = SafeJSON.parse(json) as { name?: unknown };
        if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
            return parsed.name.trim();
        }

        return null;
    } catch (err) {
        logger.debug({ err }, "ports/enrich: package.json parse failed");
        return null;
    }
}

export function parseHtmlTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) {
        return null;
    }

    const title = match[1].replace(/\s+/g, " ").trim();
    return title.length > 0 ? title : null;
}

/** Parse `lsof -Fn` field output, returning the first `n<path>` (the cwd). */
export function parseLsofCwd(stdout: string): string | null {
    for (const line of stdout.split("\n")) {
        if (line.startsWith("n")) {
            const path = line.slice(1).trim();
            if (path.length > 0) {
                return path;
            }
        }
    }

    return null;
}

export function isLocalAddress(address: string): boolean {
    return (
        address === "127.0.0.1" ||
        address === "[::1]" ||
        address === "::1" ||
        address === "*" ||
        address === "0.0.0.0" ||
        address === "localhost"
    );
}

const GENERIC_RUNTIMES = new Set([
    "bun",
    "node",
    "deno",
    "python",
    "python2",
    "python3",
    "ruby",
    "php",
    "php-fpm",
    "java",
    "dotnet",
    "tsx",
    "ts-node",
    "nodemon",
    "uvicorn",
    "gunicorn",
]);

export function isGenericRuntime(command: string): boolean {
    return GENERIC_RUNTIMES.has(command.toLowerCase());
}
