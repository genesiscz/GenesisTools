import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createTwoFilesPatch } from "diff";
import { runGitIn } from "./patch";

export type RecoveryFile = { kind: "missing" } | { kind: "file" | "symlink"; data: string; mode: number };
export interface ApplyRecoverySnapshot {
    files: Record<string, RecoveryFile>;
    index: string | null;
    indexPath: string;
}

export async function confinedPath(root: string, file: string): Promise<string> {
    const normalizedRoot = resolve(root);
    const absolute = resolve(normalizedRoot, file);
    const rel = relative(normalizedRoot, absolute);
    if (!rel || isAbsolute(file) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error(`Stash path leaves project: ${file}`);
    }

    let parent = dirname(absolute);
    while (parent !== normalizedRoot) {
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

/** The files among `files` whose current state differs from their state in `before`. */
export async function changedFromSnapshot(args: {
    root: string;
    before: ApplyRecoverySnapshot;
    files: string[];
}): Promise<string[]> {
    const known = args.files.filter((file) => args.before.files[file]);
    const now = await captureApplySnapshot({ root: args.root, files: known });
    return args.files.filter(
        (file) =>
            !args.before.files[file] ||
            SafeJSON.stringify(now.files[file]) !== SafeJSON.stringify(args.before.files[file])
    );
}

/** True when the files and the index match: a failed `git apply` that left the tree untouched. */
export function sameApplySnapshot(a: ApplyRecoverySnapshot, b: ApplyRecoverySnapshot): boolean {
    return a.index === b.index && SafeJSON.stringify(a.files) === SafeJSON.stringify(b.files);
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
                // Same guard as the rename below: an edit made since the scan must survive.
                const latest = await snapshotFile(args.root, file);
                if (!equal(latest, current.files[file])) {
                    throw new Error(`File changed while preparing stash recovery: ${file}`);
                }
                await unlink(absolute);
                continue;
            }
            await mkdir(dirname(absolute), { recursive: true });
            const temporary = join(dirname(absolute), `.stash-restore-${randomUUID()}`);
            if (before.kind === "symlink") {
                await symlink(before.data, temporary);
            } else {
                await writeFile(temporary, Buffer.from(before.data, "base64"), { flag: "wx", mode: 0o600 });
                // The create mode is filtered by the umask; chmod is not, so the saved mode lands exactly.
                await chmod(temporary, before.mode);
            }
            const latest = await snapshotFile(args.root, file);
            if (!equal(latest, current.files[file])) {
                throw new Error(`File changed while preparing stash recovery: ${file}`);
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

/**
 * The text patch unapply walks, plus every changed path it cannot express: a symlink or a
 * binary file has no hunk and no marker, so unapply must name it and keep the application
 * active rather than report a complete removal while the change stays on disk.
 */
export async function applicationRestorePatch(args: {
    root: string;
    before: ApplyRecoverySnapshot;
}): Promise<{ patch: string; unsupportedFiles: string[] }> {
    const after = await captureApplySnapshot({ root: args.root, files: Object.keys(args.before.files) });
    const patches: string[] = [];
    const unsupportedFiles: string[] = [];
    for (const [file, before] of Object.entries(args.before.files)) {
        const current = after.files[file];
        if (SafeJSON.stringify(before) === SafeJSON.stringify(current)) {
            continue;
        }
        if (before.kind === "symlink" || current.kind === "symlink") {
            unsupportedFiles.push(file);
            continue;
        }
        const oldText = before.kind === "file" ? Buffer.from(before.data, "base64").toString("utf8") : "";
        const newText = current.kind === "file" ? Buffer.from(current.data, "base64").toString("utf8") : "";
        if (oldText.includes("\0") || newText.includes("\0")) {
            unsupportedFiles.push(file);
            continue;
        }
        patches.push(
            createTwoFilesPatch(
                before.kind === "missing" ? "/dev/null" : `a/${file}`,
                current.kind === "missing" ? "/dev/null" : `b/${file}`,
                oldText,
                newText
            )
        );
    }
    return { patch: patches.join("\n"), unsupportedFiles };
}

/** Rewrite only the opened regular inode, after validating its root, parents and leaf identity. */
export async function rewriteConfinedText(args: {
    root: string;
    file: string;
    transform: (content: string) => string | Promise<string>;
    skipNonRegular?: boolean;
}): Promise<void> {
    const absolute = await confinedPath(args.root, args.file);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        if (args.skipNonRegular) {
            return;
        }
        throw new Error(`Stash text rewrite requires a regular file: ${args.file}`);
    }
    const handle = await open(absolute, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
            throw new Error(`Stash file changed before opening: ${args.file}`);
        }
        const content = await handle.readFile("utf8");
        const replacement = await args.transform(content);
        await confinedPath(args.root, args.file);
        const current = await lstat(absolute);
        if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new Error(`Stash file changed before writing: ${args.file}`);
        }
        if (replacement === content) {
            return;
        }
        const bytes = Buffer.from(replacement);
        let written = 0;
        while (written < bytes.length) {
            const result = await handle.write(bytes, written, bytes.length - written, written);
            if (!result.bytesWritten) {
                throw new Error(`Stash rewrite made no progress: ${args.file}`);
            }
            written += result.bytesWritten;
        }
        await handle.truncate(bytes.length);
    } finally {
        await handle.close();
    }
}
