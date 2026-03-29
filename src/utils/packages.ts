import { existsSync } from "node:fs";
import { resolve } from "node:path";
import logger from "@app/logger";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

const inflight = new Map<string, Promise<void>>();

export function isPackageInstalled(pkg: string): boolean {
    return existsSync(resolve(PROJECT_ROOT, "node_modules", pkg, "package.json"));
}

export interface EnsurePackagesOptions {
    label?: string;
    silent?: boolean;
}

export async function ensurePackages(packages: string[], options?: EnsurePackagesOptions): Promise<void> {
    const missing = packages.filter((pkg) => !isPackageInstalled(pkg));

    if (missing.length === 0) {
        return;
    }

    const label = options?.label ?? missing.join(", ");
    const silent = options?.silent ?? false;

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
