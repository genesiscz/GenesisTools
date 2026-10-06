import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { runGitIn } from "./patch";

export type RecoveryFile = { kind: "missing" } | { kind: "file" | "symlink"; data: string; mode: number };
export interface ApplyRecoverySnapshot {
    files: Record<string, RecoveryFile>;
    index: string | null;
    indexPath: string;
}

export async function confinedPath(root: string, file: string): Promise<string> {
    const absolute = resolve(root, file);
    const rel = relative(root, absolute);
    if (!rel || isAbsolute(file) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error(`Stash path leaves project: ${file}`);
    }

    let parent = dirname(absolute);
    while (parent !== root) {
        const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return null;
            }
            throw error;
        });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
            throw new Error(`Stash path has an unsafe parent: ${file}`);
        }
        parent = dirname(parent);
    }
    return absolute;
}

async function snapshotFile(root: string, file: string): Promise<RecoveryFile> {
    const absolute = await confinedPath(root, file);
    const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    });
    if (!stat) {
        return { kind: "missing" };
    }
    if (stat.isSymbolicLink()) {
        return { kind: "symlink", data: await readlink(absolute), mode: stat.mode & 0o777 };
    }
    if (!stat.isFile()) {
        throw new Error(`Stash cannot snapshot a non-file: ${file}`);
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return { kind: "file", data: (await handle.readFile()).toString("base64"), mode: stat.mode & 0o777 };
    } finally {
        await handle.close();
    }
}

export async function captureApplySnapshot(args: { root: string; files: string[] }): Promise<ApplyRecoverySnapshot> {
    const indexPath = resolve(args.root, (await runGitIn(args.root, ["rev-parse", "--git-path", "index"])).trim());
    const index = await readFile(indexPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    });
    const files: Record<string, RecoveryFile> = {};
    for (const file of args.files) {
        files[file] = await snapshotFile(args.root, file);
    }
    return { files, index: index?.toString("base64") ?? null, indexPath };
}

export async function restoreApplySnapshot(args: {
    root: string;
    before: ApplyRecoverySnapshot;
    after: ApplyRecoverySnapshot;
}): Promise<void> {
    const current = await captureApplySnapshot({ root: args.root, files: Object.keys(args.before.files) });
    const equal = (a: RecoveryFile, b: RecoveryFile) => SafeJSON.stringify(a) === SafeJSON.stringify(b);
    for (const [file, state] of Object.entries(current.files)) {
        if (!equal(state, args.before.files[file]) && !equal(state, args.after.files[file])) {
            throw new Error(`Refusing to overwrite edits made after apply: ${file}`);
        }
    }
    if (current.index !== args.after.index && current.index !== args.before.index) {
        throw new Error("Refusing to overwrite index changes made after apply");
    }

    const lockPath = `${current.indexPath}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    let lockRenamed = false;
    try {
        const latestIndex = await readFile(current.indexPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return null;
            }
            throw error;
        });
        if ((latestIndex?.toString("base64") ?? null) !== current.index) {
            throw new Error("Index changed while preparing stash recovery");
        }
        for (const [file, before] of Object.entries(args.before.files)) {
            if (equal(current.files[file], before)) {
                continue;
            }
            const absolute = await confinedPath(args.root, file);
            if (before.kind === "missing") {
                await unlink(absolute);
                continue;
            }
            await mkdir(dirname(absolute), { recursive: true });
            const temporary = join(dirname(absolute), `.stash-restore-${randomUUID()}`);
            if (before.kind === "symlink") {
                await symlink(before.data, temporary);
            } else {
                await writeFile(temporary, Buffer.from(before.data, "base64"), { flag: "wx", mode: before.mode });
            }
            await rename(temporary, absolute);
        }
        if (args.before.index === null) {
            await unlink(current.indexPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            });
        } else {
            await lock.writeFile(Buffer.from(args.before.index, "base64"));
            await lock.sync();
            await rename(lockPath, current.indexPath);
            lockRenamed = true;
        }
    } finally {
        await lock.close();
        if (!lockRenamed) {
            await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            });
        }
    }
}
