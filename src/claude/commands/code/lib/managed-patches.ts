import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFileStreamed } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { claudeCodePatches } from "../../../lib/patches";
import { applyPatches, inspectPatch } from "../../../lib/patches/apply";
import type { AstPatchMatch, ClaudeCodePatch } from "../../../lib/patches/define-patch";
import { type BunModule, extractBunModules, replaceBunModule } from "./bun-binary";

export function readClaudeModules(binary: Buffer, path: string): BunModule[] {
    try {
        return extractBunModules(binary);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Cannot read the embedded Claude Code bundle in ${path}. ${detail}. Pass --binary <path-to-native-claude>.`,
            {
                cause: error,
            }
        );
    }
}

export function embeddedClaudeVersion(modules: BunModule[]): string | undefined {
    const entrypoint = modules.find((module) => module.isEntrypoint);
    const header = Buffer.from(entrypoint?.contents.subarray(0, 2048) ?? []).toString("utf8");
    return /^\/\/ Version: (\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\r?$/m.exec(header)?.[1];
}

function digest(binary: Buffer): string {
    return createHash("sha256").update(binary).digest("hex");
}

async function readBinary(path: string): Promise<Buffer> {
    return Buffer.from(await Bun.file(path).arrayBuffer());
}

export interface ManagedPatchTarget {
    path: string;
    backup: string;
    receipt: string;
    currentHash: string;
    originalHash: string;
    original: Buffer;
    currentModules: BunModule[];
    originalModules: BunModule[];
    version: string | undefined;
}

export async function readManagedTarget(path: string, { requireBackup = false } = {}): Promise<ManagedPatchTarget> {
    const resolved = await realpath(path);
    const backup = `${resolved}.genesis-original`;
    const receipt = `${resolved}.genesis-patch-state`;
    const hasBackup = existsSync(backup);

    if (requireBackup && !hasBackup) {
        throw new Error(`No pristine backup found at ${backup}.`);
    }

    const current = await readBinary(resolved);
    const currentHash = digest(current);
    const original = hasBackup ? await readBinary(backup) : current;
    const originalHash = original === current ? currentHash : digest(original);

    if (existsSync(receipt)) {
        const [base, ...allowed] = (await Bun.file(receipt).text()).trim().split("\n");

        if (base !== originalHash || !allowed.includes(currentHash)) {
            throw new Error(
                "Executable or backup changed outside the patch picker. Use an unmodified executable at a fresh path."
            );
        }
    } else if (currentHash !== originalHash) {
        throw new Error(
            "Executable differs from its backup and has no patch state. Use an unmodified executable at a fresh path."
        );
    }

    const originalModules = readClaudeModules(original, original === current ? resolved : backup);
    return {
        path: resolved,
        backup,
        receipt,
        currentHash,
        originalHash,
        original,
        originalModules,
        currentModules: original === current ? originalModules : readClaudeModules(current, resolved),
        version: embeddedClaudeVersion(originalModules),
    };
}

export interface ManagedEdit {
    patch: ClaudeCodePatch;
    module: string;
    source: string;
    edit: AstPatchMatch;
    applied: boolean;
}

export function listManagedPatches(target: ManagedPatchTarget): { edits: ManagedEdit[]; problems: string[] } {
    const edits: ManagedEdit[] = [];
    const problems: string[] = [];

    for (const patch of claudeCodePatches) {
        if (
            patch.versions?.length &&
            (!target.version || !patch.versions.some((range) => Bun.semver.satisfies(target.version ?? "", range)))
        ) {
            problems.push(
                `${patch.id}: Claude Code ${target.version ?? "version unknown"} does not match ${patch.versions.join(" or ")}`
            );
            continue;
        }

        const hint = patch.moduleHint;
        const candidates = target.originalModules.filter(
            (module) =>
                module.loader === 1 &&
                (hint
                    ? Buffer.from(
                          module.contents.buffer,
                          module.contents.byteOffset,
                          module.contents.byteLength
                      ).includes(hint)
                    : module.isEntrypoint)
        );
        const matches: ManagedEdit[] = [];
        const reasons: string[] = [];

        for (const module of candidates) {
            const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(module.contents);
            const original = inspectPatch(source, patch, target.version);

            if (original.state === "applied") {
                throw new Error(
                    `${patch.id} is already present in the base executable. Start from an unmodified executable to enable backup and revert.`
                );
            }

            if (original.state === "incompatible") {
                reasons.push(`${module.name}: ${original.reason}`);
                continue;
            }

            const current = target.currentModules.find(({ name }) => name === module.name);
            const applied =
                current &&
                inspectPatch(Buffer.from(current.contents).toString("utf8"), patch, target.version).state === "applied";
            matches.push({ patch, module: module.name, source, edit: original.edit, applied: Boolean(applied) });
        }

        if (matches.length === 1 && matches[0]) {
            edits.push(matches[0]);
        } else {
            const reason =
                matches.length > 1
                    ? `matched ${matches.length} modules`
                    : reasons.join("; ") || "no candidate module found";
            problems.push(`${patch.id}: ${reason}`);
        }
    }

    return { edits, problems };
}

export function planManagedPatches(edits: ManagedEdit[], selected: ReadonlySet<string>, version?: string) {
    const modules = new Map<string, Buffer>();
    const preview: ManagedEdit[] = [];
    const spans = new Map<string, AstPatchMatch[]>();

    for (const { patch, module, source, edit, applied } of edits) {
        const enabled = selected.has(patch.id);

        if (enabled) {
            const prior = spans.get(module) ?? [];

            if (prior.some(({ start, end }) => edit.start < end && edit.end > start)) {
                throw new Error(`Patch ${patch.id} overlaps another selected edit in ${module}`);
            }

            prior.push(edit);
            spans.set(module, prior);
        }

        if (enabled !== applied) {
            preview.push({ patch, module, source, edit, applied });
        }
    }

    for (const [module] of spans) {
        const group = edits.filter((edit) => edit.module === module && selected.has(edit.patch.id));
        const first = group[0];

        if (first) {
            const patched = applyPatches(
                first.source,
                group.map(({ patch }) => patch),
                version
            );
            let expected = first.source;

            // Every preview describes edits against the pristine source.
            // Compare against that exact set before publishing the binary.
            for (const edit of [...(spans.get(module) ?? [])].sort((a, b) => b.start - a.start)) {
                expected = expected.slice(0, edit.start) + edit.replacement + expected.slice(edit.end);
            }

            if (patched !== expected) {
                throw new Error(`Combined patch output differs from the preview for ${module}`);
            }

            modules.set(module, Buffer.from(patched));
        }
    }

    return { modules, preview };
}

async function assertCurrent(target: ManagedPatchTarget): Promise<void> {
    if (digest(await readBinary(target.path)) !== target.currentHash) {
        throw new Error("Executable changed during the patch operation. Rerun the preview.");
    }
}

async function ensureBackup(target: ManagedPatchTarget, mode: number): Promise<"created" | "existing"> {
    if (existsSync(target.backup)) {
        if (digest(await readBinary(target.backup)) !== target.originalHash) {
            throw new Error("The pristine backup changed during the patch operation.");
        }

        return "existing";
    }

    if (target.currentHash !== target.originalHash) {
        throw new Error("Pristine backup disappeared during the patch operation.");
    }

    await atomicWriteFileStreamed(target.backup, (write) => write(target.original), { mode, exclusive: true });
    return "created";
}

export async function backupManagedTarget(target: ManagedPatchTarget): Promise<"created" | "existing"> {
    return withFileLock(`${target.receipt}.lock`, async () => {
        await assertCurrent(target);
        return ensureBackup(target, (await stat(target.path)).mode & 0o777);
    });
}

export async function applyManagedPlan(
    target: ManagedPatchTarget,
    modules: ReadonlyMap<string, Buffer>
): Promise<void> {
    if (process.platform !== "darwin" || target.original.readUInt32LE(0) !== 0xfeedfacf) {
        throw new Error("Applying patches requires a thin Mach-O executable on macOS.");
    }

    await withFileLock(`${target.receipt}.lock`, async () => {
        await assertCurrent(target);
        const mode = (await stat(target.path)).mode & 0o777;
        await ensureBackup(target, mode);
        const directory = await mkdtemp(join(dirname(target.path), ".claude-code-"));

        try {
            const temporary = join(directory, "claude");
            const binary = modules.size ? Buffer.from(target.original) : target.original;

            for (const [name, source] of modules) {
                replaceBunModule(binary, name, source);
            }

            await Bun.write(temporary, binary);
            await chmod(temporary, mode);

            if (modules.size) {
                runCodesign(["--force", "--sign", "-", temporary]);
            }

            runCodesign(["--verify", temporary]);
            const nextHash = digest(await readBinary(temporary));
            // Either hash remains valid if interrupted between the receipt write and rename.
            const receipt = `${target.originalHash}\n${target.currentHash}\n${nextHash}\n`;
            await atomicWriteFileStreamed(target.receipt, (write) => write(Buffer.from(receipt)), { mode: 0o600 });
            await assertCurrent(target);
            await rename(temporary, target.path);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}

function runCodesign(args: string[]): void {
    const result = Bun.spawnSync(["/usr/bin/codesign", ...args]);

    if (result.exitCode !== 0) {
        throw new Error(`codesign failed: ${result.stderr.toString().trim()}`);
    }
}
