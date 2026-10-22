// `tools du evict`: free the local copy of cloud files that are safely in the
// cloud. Never deletes: eviction turns a downloaded file back into a dataless
// placeholder, and the provider fetches it again on the next open.
//
// Only iCloud Drive is supported. Its upload state comes from the file's own
// resource values (NSURLUbiquitousItemIsUploadedKey and friends) through the
// cloudctl helper, which checks that state AGAIN right before each evict call.
// Tresorit is refused: on its Drive mount only a content read through the mount
// proves the server has the file (its File Provider snapshot and a mount listing
// both lie), and GenesisTools does not read file contents here. Other providers
// are refused too: their upload state has not been verified.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { ICLOUD_PROVIDER, TRESORIT_PROVIDER } from "./cloud";
import type { CloudFileEntry } from "./types";

const NATIVE_DIR = join(import.meta.dir, "..", "native");
const CLOUDCTL_SRC = join(NATIVE_DIR, "cloudctl.swift");
const CLOUDCTL_BIN = join(NATIVE_DIR, "cloudctl");

export interface CloudItemStatus {
    path: string;
    ubiquitous?: boolean;
    uploaded?: boolean;
    uploading?: boolean;
    uploadError?: string;
    /** current | downloaded | notDownloaded */
    downloading?: string;
    error?: string;
}

export interface EvictOutcome {
    path: string;
    evicted: boolean;
    reason?: string;
}

/** The two calls that reach iCloud. Tests pass a fake; the real one runs the cloudctl helper. */
export interface CloudCtl {
    status(paths: string[]): Promise<CloudItemStatus[]>;
    evict(paths: string[]): Promise<EvictOutcome[]>;
}

export type Verdict = { file: CloudFileEntry; ok: true } | { file: CloudFileEntry; ok: false; reason: string };

export const TRESORIT_REFUSAL =
    "Tresorit: only reading the file back through the mount proves the server has it, and GenesisTools does not read " +
    "file contents. Use Tresorit's own 'Remove download'.";

/** Refusals that need no status call: the provider decides. Null when the provider is iCloud. */
export function providerRefusal(provider: string): string | null {
    if (provider === ICLOUD_PROVIDER) {
        return null;
    }

    if (provider === TRESORIT_PROVIDER) {
        return TRESORIT_REFUSAL;
    }

    return `${provider || "unknown provider"}: only iCloud Drive eviction is supported. Use the provider's own 'Remove download'.`;
}

/** Whether one file may be evicted. Every "not proven safe" state is a refusal. */
export function judgeEviction(file: CloudFileEntry, status: CloudItemStatus | undefined): Verdict {
    const byProvider = providerRefusal(file.provider);
    if (byProvider) {
        return { file, ok: false, reason: byProvider };
    }

    if (!status) {
        return { file, ok: false, reason: "status unknown: no answer from iCloud" };
    }

    if (status.error) {
        return { file, ok: false, reason: `status unknown: ${status.error}` };
    }

    if (status.ubiquitous !== true) {
        return { file, ok: false, reason: "not an iCloud item" };
    }

    if (status.uploading === true) {
        return { file, ok: false, reason: "upload in progress" };
    }

    if (status.uploadError) {
        return { file, ok: false, reason: `upload error: ${status.uploadError}` };
    }

    if (status.uploaded !== true) {
        return { file, ok: false, reason: "not uploaded yet" };
    }

    if (status.downloading !== "current") {
        return {
            file,
            ok: false,
            reason: `local copy is not the current version (${status.downloading ?? "unknown"})`,
        };
    }

    return { file, ok: true };
}

export interface EvictionPlan {
    eligible: Extract<Verdict, { ok: true }>[];
    refused: Extract<Verdict, { ok: false }>[];
}

/** Asks iCloud about the files it may evict, and judges every file. Read-only. */
export async function planEviction(files: CloudFileEntry[], ctl: CloudCtl): Promise<EvictionPlan> {
    const ask = files.filter((f) => providerRefusal(f.provider) === null).map((f) => f.path);
    const statuses = ask.length > 0 ? await ctl.status(ask) : [];
    const byPath = new Map(statuses.map((s) => [s.path, s]));
    const plan: EvictionPlan = { eligible: [], refused: [] };
    for (const f of files) {
        const v = judgeEviction(f, byPath.get(f.path));
        if (v.ok) {
            plan.eligible.push(v);
        } else {
            plan.refused.push(v);
        }
    }

    logger.debug({ files: files.length, eligible: plan.eligible.length }, "du evict: planned");
    return plan;
}

/**
 * Evicts the selected files. A path outside `plan.eligible` is refused here,
 * before the helper runs, whatever the caller passed in.
 */
export async function applyEviction(plan: EvictionPlan, selected: string[], ctl: CloudCtl): Promise<EvictOutcome[]> {
    const allowed = new Set(plan.eligible.map((v) => v.file.path));
    const refused: EvictOutcome[] = [];
    const go: string[] = [];
    for (const path of selected) {
        if (allowed.has(path)) {
            go.push(path);
        } else {
            refused.push({ path, evicted: false, reason: "not in the eligible list" });
        }
    }

    const done = go.length > 0 ? await ctl.evict(go) : [];
    logger.info({ requested: selected.length, evicted: done.filter((d) => d.evicted).length }, "du evict: applied");
    return [...done, ...refused];
}

/** Compiles the Swift helper on demand (cached, rebuilt when the source is newer). */
export function ensureCloudCtl(): string {
    const needBuild =
        !existsSync(CLOUDCTL_BIN) ||
        (existsSync(CLOUDCTL_SRC) && statSync(CLOUDCTL_SRC).mtimeMs > statSync(CLOUDCTL_BIN).mtimeMs);
    if (needBuild) {
        logger.debug({ src: CLOUDCTL_SRC, bin: CLOUDCTL_BIN }, "du: compiling cloudctl.swift");
        execFileSync("swiftc", ["-O", "-o", CLOUDCTL_BIN, CLOUDCTL_SRC], { stdio: "pipe" });
    }

    return CLOUDCTL_BIN;
}

async function runCloudCtl<T>(verb: "status" | "evict", paths: string[]): Promise<T[]> {
    const bin = ensureCloudCtl();
    logger.debug({ bin, verb, paths: paths.length }, "du: running cloudctl");
    const proc = Bun.spawn([bin, verb], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(paths.join("\0"));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) {
        throw new Error(`cloudctl ${verb} exited with ${code}: ${stderr.trim()}`);
    }

    const rows: T[] = [];
    for (const line of stdout.split("\n")) {
        if (line.trim().length > 0) {
            rows.push(SafeJSON.parse(line, { strict: true }) as T);
        }
    }

    return rows;
}

export const realCloudCtl: CloudCtl = {
    status: (paths) => runCloudCtl<CloudItemStatus>("status", paths),
    evict: (paths) => runCloudCtl<EvictOutcome>("evict", paths),
};
