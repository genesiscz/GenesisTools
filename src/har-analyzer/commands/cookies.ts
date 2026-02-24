import { printFormatted, truncatePath } from "@app/har-analyzer/core/formatter";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { HarEntry, OutputOptions } from "@app/har-analyzer/types";
import type { Command } from "commander";

interface CookieInfo {
    name: string;
    setByEntry: number | null;
    setByUrl: string;
    flags: string[];
    sentInEntries: number[];
}

function collapseEntryRanges(indices: number[]): string {
    if (indices.length === 0) {
        return "none";
    }
    if (indices.length === 1) {
        return `e${indices[0]}`;
    }

    const sorted = [...indices].sort((a, b) => a - b);
    const ranges: string[] = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === rangeEnd + 1) {
            rangeEnd = sorted[i];
        } else {
            ranges.push(rangeStart === rangeEnd ? `e${rangeStart}` : `[e${rangeStart}..e${rangeEnd}]`);
            rangeStart = sorted[i];
            rangeEnd = sorted[i];
        }
    }

    ranges.push(rangeStart === rangeEnd ? `e${rangeStart}` : `[e${rangeStart}..e${rangeEnd}]`);
    return ranges.join(", ");
}

function extractCookieFlags(setCookieValue: string): string[] {
    const flags: string[] = [];
    const lower = setCookieValue.toLowerCase();
    if (lower.includes("httponly")) {
        flags.push("HttpOnly");
    }
    if (lower.includes("secure")) {
        flags.push("Secure");
    }
    if (lower.includes("samesite=strict")) {
        flags.push("SameSite=Strict");
    } else if (lower.includes("samesite=lax")) {
        flags.push("SameSite=Lax");
    } else if (lower.includes("samesite=none")) {
        flags.push("SameSite=None");
    }
    return flags;
}

function parseCookieName(setCookieValue: string): string {
    const eqIndex = setCookieValue.indexOf("=");
    if (eqIndex === -1) {
        return setCookieValue.trim();
    }
    return setCookieValue.slice(0, eqIndex).trim();
}

function analyzeCookies(harEntries: HarEntry[]): CookieInfo[] {
    const cookieMap = new Map<string, CookieInfo>();

    // Pass 1: Find Set-Cookie response headers
    for (let i = 0; i < harEntries.length; i++) {
        const entry = harEntries[i];
        for (const header of entry.response.headers) {
            if (header.name.toLowerCase() === "set-cookie") {
                const name = parseCookieName(header.value);
                if (!cookieMap.has(name)) {
                    cookieMap.set(name, {
                        name,
                        setByEntry: i,
                        setByUrl: entry.request.url,
                        flags: extractCookieFlags(header.value),
                        sentInEntries: [],
                    });
                }
            }
        }
    }

    // Pass 2: Find Cookie request headers and request cookies
    for (let i = 0; i < harEntries.length; i++) {
        const entry = harEntries[i];

        // Check request cookies array
        for (const cookie of entry.request.cookies) {
            const info = cookieMap.get(cookie.name);
            if (info) {
                info.sentInEntries.push(i);
            } else {
                // Cookie exists in requests but was never set in this HAR (pre-existing)
                cookieMap.set(cookie.name, {
                    name: cookie.name,
                    setByEntry: null,
                    setByUrl: "(pre-existing)",
                    flags: [],
                    sentInEntries: [i],
                });
            }
        }

        // Also check Cookie header directly for cookies not in the cookies array
        for (const header of entry.request.headers) {
            if (header.name.toLowerCase() === "cookie") {
                const pairs = header.value.split(";").map((p) => p.trim());
                for (const pair of pairs) {
                    const name = pair.split("=")[0]?.trim();
                    if (!name) {
                        continue;
                    }

                    const info = cookieMap.get(name);
                    if (info) {
                        if (!info.sentInEntries.includes(i)) {
                            info.sentInEntries.push(i);
                        }
                    } else {
                        cookieMap.set(name, {
                            name,
                            setByEntry: null,
                            setByUrl: "(pre-existing)",
                            flags: [],
                            sentInEntries: [i],
                        });
                    }
                }
            }
        }
    }

    return Array.from(cookieMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function registerCookiesCommand(program: Command): void {
    program
        .command("cookies")
        .description("Track cookie flow across requests")
        .action(async () => {
            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            const har = await loadHarFile(session.sourceFile);
            const cookies = analyzeCookies(har.log.entries);

            if (cookies.length === 0) {
                console.log("No cookies found in HAR file.");
                return;
            }

            const lines: string[] = [];
            lines.push(`${cookies.length} cookie${cookies.length !== 1 ? "s" : ""} found:\n`);

            for (const cookie of cookies) {
                lines.push(`  ${cookie.name}`);

                if (cookie.setByEntry !== null) {
                    let path: string;
                    try {
                        path = truncatePath(new URL(cookie.setByUrl).pathname, 40);
                    } catch {
                        path = truncatePath(cookie.setByUrl, 40);
                    }
                    lines.push(`    Set by: e${cookie.setByEntry} ${path}`);
                } else {
                    lines.push(`    Set by: ${cookie.setByUrl}`);
                }

                if (cookie.flags.length > 0) {
                    lines.push(`    Flags:  ${cookie.flags.join(", ")}`);
                }

                const sentCount = cookie.sentInEntries.length;
                const sentRange = collapseEntryRanges(cookie.sentInEntries);
                lines.push(`    Sent in ${sentCount} request${sentCount !== 1 ? "s" : ""}: ${sentRange}`);
                lines.push("");
            }

            await printFormatted(lines.join("\n"), parentOpts.format);
        });
}
