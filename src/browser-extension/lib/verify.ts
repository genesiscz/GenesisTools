import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connectBrowser, extensionTargets, launchWithExtension } from "@app/chrome-devtools/lib/extensions";
import { GENESIS_EXTENSION_ID } from "@genesiscz/utils/browser-extension/registry";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { DIST_DIR, ROUTER_HOSTS_FILE } from "./build";

const { log } = logger.scoped("browser-extension-verify");

export interface VerifyCheck {
    name: string;
    ok: boolean;
    detail: string;
}

const WAIT_MS = 15_000;

/** `work`, or null once `ms` pass: a browser that stops answering never holds the check past its deadline. */
async function within<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, ms));
    });

    try {
        return await Promise.race([work, expired]);
    } finally {
        clearTimeout(timer);
    }
}

async function until<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const value = await within(read(), deadline - Date.now());

        if (value !== null) {
            return value;
        }

        await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }

    return null;
}

/** The hosts the checked build was made for (its `router-hosts.json`), not the live config. */
function builtRouterHosts(distDir: string): { linkHost: string | null; hosts: string[] } {
    const path = join(distDir, ROUTER_HOSTS_FILE);

    if (!existsSync(path)) {
        return { linkHost: null, hosts: [] };
    }

    try {
        const data: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        if (isRecord(data)) {
            return {
                linkHost: typeof data.linkHost === "string" ? data.linkHost : null,
                hosts: Array.isArray(data.hosts) ? data.hosts.filter((host) => typeof host === "string") : [],
            };
        }
    } catch (error) {
        log.warn({ error, path }, "router-hosts.json in the build does not parse");
    }

    return { linkHost: null, hosts: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads `dist` in a headless browser on a throwaway profile and checks what a user would notice:
 * the worker starts, the redirect rules install, and a router link lands on the route page. Never
 * touches the user's own browser.
 */
export async function verifyExtension(distDir: string = DIST_DIR): Promise<VerifyCheck[]> {
    const headless = await launchWithExtension(distDir);
    let conn: Awaited<ReturnType<typeof connectBrowser>> | undefined;
    const checks: VerifyCheck[] = [];

    try {
        conn = await connectBrowser(headless.port);
        const browser = conn;
        const worker = await until(async () => {
            const found = (await extensionTargets(browser, GENESIS_EXTENSION_ID)).find(
                (info) => info.type === "service_worker"
            );
            return found ?? null;
        }, WAIT_MS);
        checks.push({
            name: "worker starts",
            ok: worker !== null,
            detail: worker ? worker.url : "no service worker within 15 s (the build may not load)",
        });

        if (!worker) {
            return checks;
        }

        const attached = await within(
            browser.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true }),
            WAIT_MS
        );
        const sessionId = isRecord(attached) && typeof attached.sessionId === "string" ? attached.sessionId : undefined;
        const wanted = builtRouterHosts(distDir);
        const expectsRules = wanted.linkHost !== null || wanted.hosts.length > 0;

        if (!expectsRules) {
            checks.push({
                name: "redirect rules install",
                ok: true,
                detail: "this build names no router hosts, so it installs no redirect rules",
            });
            return checks;
        }

        const rules = await until(async () => {
            const reply = await browser.send(
                "Runtime.evaluate",
                {
                    expression:
                        "chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.map((rule) => rule.id))",
                    awaitPromise: true,
                    returnByValue: true,
                },
                sessionId
            );
            const ids =
                isRecord(reply) && isRecord(reply.result) && Array.isArray(reply.result.value)
                    ? reply.result.value
                    : [];
            return ids.length > 0 ? ids : null;
        }, WAIT_MS);
        checks.push({
            name: "redirect rules install",
            ok: rules !== null,
            detail: rules ? `${rules.length} rule(s): ${rules.join(", ")}` : "no dynamic rules within 15 s",
        });

        const sample = wanted.linkHost
            ? `https://${wanted.linkHost}/verify`
            : wanted.hosts[0]
              ? `http://${wanted.hosts[0]}/`
              : null;

        if (sample) {
            const created = await within(browser.send("Target.createTarget", { url: sample }), WAIT_MS);
            const targetId = isRecord(created) && typeof created.targetId === "string" ? created.targetId : "";
            const landed = await until(async () => {
                const page = (await extensionTargets(browser, GENESIS_EXTENSION_ID)).find(
                    (info) => info.targetId === targetId && info.url.includes("/route.html")
                );
                return page ?? null;
            }, WAIT_MS);
            checks.push({
                name: "a router link reaches the route page",
                ok: landed !== null,
                detail: landed ? `${sample} -> ${landed.url}` : `${sample} was not redirected within 15 s`,
            });
        }

        return checks;
    } finally {
        log.info({ checks }, "extension verify");
        conn?.close();
        headless.close();
    }
}
