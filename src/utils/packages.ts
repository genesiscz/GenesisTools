import { existsSync } from "node:fs";
import { resolve } from "node:path";
import logger from "@app/logger";
import { isInteractive } from "@app/utils/cli";
import { Storage } from "@app/utils/storage/storage";
import * as p from "@clack/prompts";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

const inflight = new Map<string, Promise<void>>();

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
    return existsSync(resolve(PROJECT_ROOT, "node_modules", pkg, "package.json"));
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
        const installPromise = runBunAdd(toInstall, { label, silent });

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

async function runBunAdd(packages: string[], opts: { label: string; silent: boolean }): Promise<void> {
    if (!opts.silent) {
        logger.info(`Installing ${opts.label}...`);
    }

    const proc = Bun.spawn(["bun", "add", ...packages], {
        cwd: PROJECT_ROOT,
        stdout: opts.silent ? "ignore" : "inherit",
        stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`bun add ${packages.join(" ")} failed (exit ${exitCode}):\n${stderr.trim()}`);
    }
}
