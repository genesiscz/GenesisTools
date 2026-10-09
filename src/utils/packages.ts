import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import {
    isStorePackage,
    isStorePackageInstalled,
    packageStoreDir,
    preparePackageStore,
    STORE_PACKAGES,
} from "@genesiscz/utils/package-store";
import { Storage } from "@genesiscz/utils/storage/storage";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

const inflight = new Map<string, Promise<void>>();

// Serializes all bun add invocations to prevent concurrent writes to the workspace
let installQueue: Promise<void> = Promise.resolve();

const packageStorage = new Storage("packages");

async function getRejectedPackages(): Promise<Set<string>> {
    const rejected = await packageStorage.getConfigValue<string[]>("rejected");
    return new Set(rejected ?? []);
}

async function addRejectedPackage(pkg: string): Promise<void> {
    const rejected = await getRejectedPackages();
    rejected.add(pkg);
    await packageStorage.setConfigValue("rejected", [...rejected]);
}

export async function removeRejectedPackage(pkg: string): Promise<void> {
    const rejected = await getRejectedPackages();
    rejected.delete(pkg);
    await packageStorage.setConfigValue("rejected", [...rejected]);
}

export async function listRejectedPackages(): Promise<string[]> {
    const rejected = await getRejectedPackages();
    return [...rejected];
}

export async function clearRejectedPackages(): Promise<void> {
    await packageStorage.setConfigValue("rejected", []);
}

export function isPackageInstalled(pkg: string): boolean {
    if (isStorePackage(pkg)) {
        return isStorePackageInstalled(pkg);
    }

    return existsSync(resolve(PROJECT_ROOT, "node_modules", pkg, "package.json"));
}

/**
 * Store packages go to the shared package store at their pinned version; every other package
 * goes into the repo. A store package must never reach the repo's `bun add`, because that
 * writes it into package.json (the 2026-04-09 regression, see package-store.ts).
 */
export function bunAddCommands(packages: string[]): Array<{ cwd: string; cmd: string[]; store: boolean }> {
    const store = packages.filter(isStorePackage);
    const repo = packages.filter((pkg) => !isStorePackage(pkg));
    const commands: Array<{ cwd: string; cmd: string[]; store: boolean }> = [];

    if (store.length > 0) {
        commands.push({
            cwd: packageStoreDir(),
            cmd: ["bun", "add", "--exact", ...store.map((pkg) => `${pkg}@${STORE_PACKAGES[pkg]}`)],
            store: true,
        });
    }

    if (repo.length > 0) {
        commands.push({ cwd: PROJECT_ROOT, cmd: ["bun", "add", ...repo], store: false });
    }

    return commands;
}

export interface EnsurePackagesOptions {
    label?: string;
    silent?: boolean;
    interactive?: boolean; // If true, prompt user before installing. Default: false (auto-install)
    reason?: string; // WHY this package is needed (shown in prompt)
}

async function promptInstall(
    packages: string[],
    opts: { label: string; reason?: string }
): Promise<"accept" | "reject" | "already-rejected"> {
    const rejected = await getRejectedPackages();
    const allRejected = packages.every((pkg) => rejected.has(pkg));

    if (allRejected) {
        return "already-rejected";
    }

    const toPrompt = packages.filter((pkg) => !rejected.has(pkg));

    if (!isInteractive()) {
        return "accept";
    }

    const reasonText = opts.reason ? `\n  Reason: ${opts.reason}` : "";
    const result = await p.confirm({
        message: `Install ${opts.label}? (${toPrompt.length} package${toPrompt.length > 1 ? "s" : ""})${reasonText}`,
        initialValue: true,
    });

    if (p.isCancel(result) || !result) {
        for (const pkg of toPrompt) {
            await addRejectedPackage(pkg);
        }

        return "reject";
    }

    return "accept";
}

export async function ensurePackages(packages: string[], options?: EnsurePackagesOptions): Promise<void> {
    const missing = packages.filter((pkg) => !isPackageInstalled(pkg));

    if (missing.length === 0) {
        return;
    }

    // A test run must never `bun add` into the repo it is testing. promptInstall() returns
    // "accept" whenever stdin is not a TTY, so under `bun test` this path installed silently:
    // `chunker.test.ts` "extracts Python function and class definitions" was recorded at
    // 9836 ms against a 5000 ms per-test timeout purely because @ast-grep/lang-python was
    // absent from a worktree's partial node_modules and the assertion triggered a cold
    // install. With every grammar declared in package.json the same test runs in ~4 ms.
    // Returning rather than throwing keeps the failure where it belongs: the caller reports
    // the capability as unavailable, instead of the suite mutating node_modules mid-run.
    if (env.get("NODE_ENV") === "test") {
        logger.debug(
            { packages: missing },
            "ensurePackages: refusing to install under NODE_ENV=test — declare the package in package.json instead"
        );
        return;
    }

    const label = options?.label ?? missing.join(", ");
    const silent = options?.silent ?? false;

    if (options?.interactive) {
        const decision = await promptInstall(missing, {
            label,
            reason: options.reason,
        });

        if (decision === "reject" || decision === "already-rejected") {
            return;
        }
    }

    // Separate into already-in-flight vs needs-install
    const toInstall: string[] = [];
    const toAwait: Promise<void>[] = [];

    for (const pkg of missing) {
        const existing = inflight.get(pkg);

        if (existing) {
            toAwait.push(existing);
        } else {
            toInstall.push(pkg);
        }
    }

    if (toInstall.length > 0) {
        // Enqueue behind any in-progress bun add to prevent concurrent workspace writes
        const installPromise = enqueueInstall(toInstall, { label, silent });

        for (const pkg of toInstall) {
            inflight.set(pkg, installPromise);
        }

        installPromise.finally(() => {
            for (const pkg of toInstall) {
                inflight.delete(pkg);
            }
        });

        toAwait.push(installPromise);
    }

    await Promise.all(toAwait);
}

export async function ensurePackage(pkg: string, options?: EnsurePackagesOptions): Promise<void> {
    return ensurePackages([pkg], options);
}

function enqueueInstall(packages: string[], opts: { label: string; silent: boolean }): Promise<void> {
    const run = installQueue.then(() => runBunAdd(packages, opts));
    installQueue = run.catch(() => {});
    return run;
}

async function runBunAdd(packages: string[], opts: { label: string; silent: boolean }): Promise<void> {
    if (!opts.silent) {
        logger.info(`Installing ${opts.label}...`);
    }

    for (const { cwd, cmd, store } of bunAddCommands(packages)) {
        if (store) {
            preparePackageStore();
        }

        logger.debug({ cwd, cmd }, "ensurePackages: running bun add");
        const proc = Bun.spawn(cmd, {
            cwd,
            stdout: opts.silent ? "ignore" : "inherit",
            stderr: "pipe",
        });

        // Start draining stderr concurrently — waiting until after proc.exited can deadlock
        // if the child writes enough to fill the OS pipe buffer
        const stderrP = new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            const stderr = await stderrP;
            throw new Error(`${cmd.join(" ")} failed in ${cwd} (exit ${exitCode}):\n${stderr.trim()}`);
        }
    }
}
