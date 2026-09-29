import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dir } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import ignore, { type Ignore } from "ignore";

const { log } = logger.scoped("jev-grep");

/** Independent switches. Each one broadens only its own exclusion category. */
export interface FilesystemPolicy {
    hidden?: boolean;
    noIgnore?: boolean;
    includeDependencies?: boolean;
    includeSensitive?: boolean;
}

export type Snapshot = Readonly<{ path: string; contentHash: string; source: string }>;

export interface FilesystemIssue {
    kind: "unreadable" | "changed" | "resource_limit" | "interrupted";
    path: string;
}

interface Excluded {
    status: "excluded";
    reason: string;
}

interface Issue {
    status: "issue";
    issue: FilesystemIssue;
}

export type SnapshotResult = { status: "ok"; snapshot: Snapshot } | Excluded | Issue;
export type LookupResult = { status: "file" } | Excluded | Issue;

export interface DirectoryEntry {
    path: string;
    kind: "file" | "directory";
}

export interface DirectoryPage {
    entries: DirectoryEntry[];
    nextCursor?: string;
    issues: FilesystemIssue[];
}

/** The exact default name policy from upstream `filesystemDefaults`. Dot paths need `hidden` on their own. */
export const filesystemDefaults = Object.freeze({
    dependencyDirectories: [
        "node_modules",
        "vendor",
        "venv",
        ".venv",
        ".tox",
        "__pycache__",
        "dist",
        "build",
        "coverage",
        "target",
        ".next",
        ".nuxt",
        ".turbo",
    ] as readonly string[],
    sensitiveNames: [
        "credentials",
        "credentials.json",
        "secrets.json",
        "secrets.yaml",
        "secrets.yml",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        ".netrc",
        ".npmrc",
        ".pypirc",
    ] as readonly string[],
    sensitiveSuffixes: [".pem", ".key", ".p12", ".pfx"] as readonly string[],
    pageSize: 128,
    maxOpenDirectories: 64,
    maxFileBytes: 16 * 1024 * 1024,
    maxIgnoreBytes: 1024 * 1024,
});

type Limits = Pick<typeof filesystemDefaults, "pageSize" | "maxOpenDirectories" | "maxFileBytes" | "maxIgnoreBytes">;

export interface FilesystemOptions {
    root: string;
    policy?: FilesystemPolicy;
    /** Absolute paths that are never listed or read: the jev config file and the grep cache. */
    protectedPaths?: readonly string[];
    limits?: Partial<Limits>;
    signal?: AbortSignal;
}

interface Scope {
    directory: string;
    git?: Ignore;
    search?: Ignore;
}

interface Eligible {
    status: "eligible";
    path: string;
    absolute: string;
    stat: BigIntStats;
    ancestors: Array<{ path: string; stat: BigIntStats }>;
}

type Eligibility = Eligible | Excluded | Issue;

interface Cursor {
    directory: string;
    handle: Dir;
    identity: Eligible;
}

const excluded = (reason: string): Excluded => ({ status: "excluded", reason });
const issue = (kind: FilesystemIssue["kind"], path: string): Issue => ({ status: "issue", issue: { kind, path } });

function same(a: BigIntStats, b: BigIntStats): boolean {
    return (
        a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
    );
}

function within(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function errnoCode(error: unknown): string | undefined {
    return error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
}

function errorKind(error: unknown): FilesystemIssue["kind"] {
    const code = errnoCode(error);
    return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ? "changed" : "unreadable";
}

function isSensitive(name: string): boolean {
    const lower = name.toLowerCase();
    return (
        lower === ".env" ||
        lower.startsWith(".env.") ||
        filesystemDefaults.sensitiveNames.includes(lower) ||
        filesystemDefaults.sensitiveSuffixes.some((suffix) => lower.endsWith(suffix))
    );
}

/** One invocation-scoped owner for eligibility, metadata reads, enumeration and content snapshots. */
export async function createFilesystem(options: FilesystemOptions) {
    const root = await realpath(resolve(options.root));
    const rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory()) {
        throw new Error("Search root must be a directory");
    }

    const policy = Object.freeze({ ...options.policy });
    const limits: Limits = { ...filesystemDefaults, ...options.limits };
    for (const name of ["pageSize", "maxOpenDirectories", "maxFileBytes", "maxIgnoreBytes"] as const) {
        if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) {
            throw new Error(`Invalid filesystem limit: ${name}`);
        }
    }

    const protectedPaths = await Promise.all(
        (options.protectedPaths ?? []).map(async (path) => {
            const absolute = resolve(path);
            try {
                return await realpath(absolute);
            } catch (error) {
                log.debug(
                    { path: absolute, code: errnoCode(error) },
                    "Protected path not resolvable; using it as given"
                );
                return absolute;
            }
        })
    );
    log.debug({ root, policy, protectedPaths: protectedPaths.length }, "Opened grep search root");
    const cursors = new Map<string, Cursor>();
    let closed = false;
    let openingDirectories = 0;

    function pathName(path: string): { absolute: string; path: string } | undefined {
        if (isAbsolute(path)) {
            return undefined;
        }

        const absolute = resolve(root, path);
        return within(root, absolute) ? { absolute, path: relative(root, absolute).split(sep).join("/") } : undefined;
    }

    function stopped(path: string): Issue | undefined {
        return closed || options.signal?.aborted ? issue("interrupted", path) : undefined;
    }

    function hardExcluded(path: string): boolean {
        return path.split(sep).includes(".git") || protectedPaths.some((protectedPath) => within(protectedPath, path));
    }

    async function stable(identity: Eligible): Promise<boolean> {
        for (const ancestor of identity.ancestors) {
            const current = await lstat(ancestor.path, { bigint: true });
            // Child edits legitimately change a directory's timestamps; its identity must stay fixed.
            if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino) {
                return false;
            }
        }

        return (
            same(identity.stat, await lstat(identity.absolute, { bigint: true })) &&
            (await realpath(identity.absolute)) === identity.absolute
        );
    }

    async function readBytes(identity: Eligible, ceiling: number): Promise<{ status: "ok"; bytes: Buffer } | Issue> {
        const interrupted = stopped(identity.path);
        if (interrupted) {
            return interrupted;
        }

        if (identity.stat.size > BigInt(ceiling)) {
            return issue("resource_limit", identity.path);
        }

        let handle: FileHandle | undefined;
        try {
            // NONBLOCK keeps a concurrent swap to a FIFO from hanging the process.
            handle = await open(identity.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || !same(identity.stat, before)) {
                return issue("changed", identity.path);
            }

            const chunks: Buffer[] = [];
            let total = 0;
            while (true) {
                const interruption = stopped(identity.path);
                if (interruption) {
                    return interruption;
                }

                const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, ceiling - total + 1));
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
                if (!bytesRead) {
                    break;
                }

                total += bytesRead;
                if (total > ceiling) {
                    return issue("resource_limit", identity.path);
                }

                chunks.push(chunk.subarray(0, bytesRead));
            }

            if (!same(before, await handle.stat({ bigint: true })) || !(await stable(identity))) {
                return issue("changed", identity.path);
            }

            return { status: "ok", bytes: Buffer.concat(chunks, total) };
        } catch (error) {
            log.debug({ path: identity.path, code: errnoCode(error) }, "Grep read failed");
            return issue(errorKind(error), identity.path);
        } finally {
            await handle?.close();
        }
    }

    // Search-local reuse. Eviction only costs a reparse; it never changes eligibility.
    const ruleCache = new Map<string, { stat: BigIntStats; rules: Ignore }>();

    async function ruleFile(directory: string, name: string): Promise<Ignore | Issue | undefined> {
        const absolute = join(directory, name);
        const identity = (stat: BigIntStats): Eligible => ({
            status: "eligible",
            path: relative(root, absolute),
            absolute,
            stat,
            ancestors: [],
        });
        try {
            const stat = await lstat(absolute, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink()) {
                ruleCache.delete(absolute);
                return undefined;
            }

            const cached = ruleCache.get(absolute);
            if (cached && same(cached.stat, stat)) {
                if (!(await stable(identity(stat)))) {
                    return issue("changed", relative(root, absolute));
                }

                ruleCache.delete(absolute);
                ruleCache.set(absolute, cached);
                return cached.rules;
            }

            const bytes = await readBytes(identity(stat), limits.maxIgnoreBytes);
            if (bytes.status === "issue") {
                return bytes;
            }

            try {
                const rules = ignore().add(new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes));
                ruleCache.delete(absolute);
                ruleCache.set(absolute, { stat, rules });
                if (ruleCache.size > 64) {
                    const oldest = ruleCache.keys().next().value;
                    if (oldest !== undefined) {
                        ruleCache.delete(oldest);
                    }
                }

                return rules;
            } catch (error) {
                log.debug({ path: relative(root, absolute), error }, "Ignore file is not valid UTF-8");
                return issue("unreadable", relative(root, absolute));
            }
        } catch (error) {
            if (errnoCode(error) === "ENOENT") {
                ruleCache.delete(absolute);
                return undefined;
            }

            return issue(errorKind(error), relative(root, absolute));
        }
    }

    async function eligibility(input: string, allowMissing = false): Promise<Eligibility> {
        const named = pathName(input);
        if (!named) {
            return excluded("outside_root");
        }

        const interruption = stopped(named.path);
        if (interruption) {
            return interruption;
        }

        if (hardExcluded(named.absolute)) {
            return excluded("protected");
        }

        const components = named.path ? named.path.split("/") : [];
        const scopes: Scope[] = [];
        const ancestors: Eligible["ancestors"] = [];
        let directory = root;
        try {
            const currentRoot = await lstat(root, { bigint: true });
            if (!currentRoot.isDirectory() || currentRoot.ino !== rootStat.ino || currentRoot.dev !== rootStat.dev) {
                return issue("changed", named.path);
            }

            if (!components.length) {
                return { status: "eligible", ...named, stat: currentRoot, ancestors };
            }

            ancestors.push({ path: root, stat: currentRoot });
            for (let index = 0; index < components.length; index++) {
                if (!policy.noIgnore) {
                    if (directory !== root) {
                        try {
                            const git = await lstat(join(directory, ".git"));
                            // A nested repository starts its own .gitignore chain; inherited .ignore stays.
                            if (git.isDirectory() || git.isFile()) {
                                for (const scope of scopes) {
                                    delete scope.git;
                                }
                            }
                        } catch (error) {
                            if (errnoCode(error) !== "ENOENT") {
                                return issue(errorKind(error), named.path);
                            }
                        }
                    }

                    const git = await ruleFile(directory, ".gitignore");
                    if (git && "status" in git) {
                        return git;
                    }

                    const search = await ruleFile(directory, ".ignore");
                    if (search && "status" in search) {
                        return search;
                    }

                    scopes.push({ directory, git, search });
                }

                const name = components[index]!;
                const absolute = join(directory, name);
                if (hardExcluded(absolute)) {
                    return excluded("protected");
                }

                if (!policy.hidden && name.startsWith(".")) {
                    return excluded("hidden");
                }

                if (!policy.includeSensitive && isSensitive(name)) {
                    return excluded("sensitive_name");
                }

                const stat = await lstat(absolute, { bigint: true });
                if (stat.isSymbolicLink()) {
                    return excluded("symlink");
                }

                if (!stat.isDirectory() && !stat.isFile()) {
                    return excluded("special_file");
                }

                if (
                    stat.isDirectory() &&
                    !policy.includeDependencies &&
                    filesystemDefaults.dependencyDirectories.includes(name)
                ) {
                    return excluded("dependency");
                }

                // Closer scopes come later, and `.ignore` follows `.gitignore` in the same scope, so the
                // last matching rule wins in exactly the precedence the policy describes.
                let ignored = false;
                for (const scope of scopes) {
                    const candidate =
                        relative(scope.directory, absolute).split(sep).join("/") + (stat.isDirectory() ? "/" : "");
                    for (const matcher of [scope.git, scope.search]) {
                        if (!matcher) {
                            continue;
                        }

                        const result = matcher.test(candidate);
                        if (result.ignored) {
                            ignored = true;
                        } else if (result.unignored) {
                            ignored = false;
                        }
                    }
                }

                if (ignored) {
                    return excluded("ignored");
                }

                if (index === components.length - 1) {
                    return { status: "eligible", ...named, stat, ancestors };
                }

                if (!stat.isDirectory()) {
                    return excluded("not_directory");
                }

                ancestors.push({ path: absolute, stat });
                directory = absolute;
            }

            return excluded("outside_root");
        } catch (error) {
            if (allowMissing && errnoCode(error) === "ENOENT") {
                return excluded("missing");
            }

            return issue(errorKind(error), named.path);
        }
    }

    async function lookupFile(path: string): Promise<LookupResult> {
        const result = await eligibility(path, true);
        if (result.status !== "eligible") {
            return result;
        }

        return result.stat.isFile() ? { status: "file" } : excluded("not_file");
    }

    /** `maxBytes` skips a larger file before any byte is read: a sample, not a finding, so it is no issue. */
    async function readSnapshot(path: string, options: { maxBytes?: number } = {}): Promise<SnapshotResult> {
        const admitted = await eligibility(path);
        if (admitted.status !== "eligible") {
            return admitted;
        }

        if (!admitted.stat.isFile()) {
            return excluded("not_file");
        }

        // Over `maxFileBytes` is an exclusion (the spec's filesystem policy), so a large generated file
        // does not turn a healthy search incomplete. One that grows past it mid-read is still an issue.
        if (admitted.stat.size > BigInt(limits.maxFileBytes)) {
            return excluded("too_large");
        }

        if (options.maxBytes !== undefined && admitted.stat.size > BigInt(options.maxBytes)) {
            return excluded("over_sample_bytes");
        }

        const read = await readBytes(admitted, limits.maxFileBytes);
        if (read.status !== "ok") {
            return read;
        }

        const current = await eligibility(path);
        if (current.status !== "eligible") {
            return current;
        }

        if (!same(admitted.stat, current.stat)) {
            return issue("changed", admitted.path);
        }

        // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what marks a binary
        if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(read.bytes.toString("latin1"))) {
            return excluded("binary");
        }

        let source: string;
        try {
            source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
        } catch {
            return excluded("invalid_utf8");
        }

        if (!policy.includeSensitive && /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(source)) {
            return excluded("private_key");
        }

        return {
            status: "ok",
            snapshot: Object.freeze({
                path: admitted.path,
                source,
                contentHash: createHash("sha256").update(read.bytes).digest("hex"),
            }),
        };
    }

    async function discard(token: string): Promise<void> {
        const cursor = cursors.get(token);
        cursors.delete(token);
        if (cursor) {
            await cursor.handle.close();
        }
    }

    /** Consume a cursor serially. `closeCursor` releases a pruned directory without draining it. */
    async function listPage(path = ".", token?: string): Promise<DirectoryPage> {
        const entries: DirectoryEntry[] = [];
        const issues: FilesystemIssue[] = [];
        const named = pathName(path);
        if (!named) {
            return { entries, issues };
        }

        let cursor = token ? cursors.get(token) : undefined;
        if (token && (!cursor || cursor.directory !== named.path)) {
            throw new Error("Invalid directory cursor");
        }

        try {
            if (!cursor) {
                const admitted = await eligibility(path);
                if (admitted.status === "issue") {
                    return { entries, issues: [admitted.issue] };
                }

                if (admitted.status !== "eligible" || !admitted.stat.isDirectory()) {
                    return { entries, issues };
                }

                if (cursors.size + openingDirectories >= limits.maxOpenDirectories) {
                    return { entries, issues: [issue("resource_limit", named.path).issue] };
                }

                openingDirectories++;
                try {
                    cursor = {
                        directory: named.path,
                        handle: await opendir(admitted.absolute, { bufferSize: limits.pageSize }),
                        identity: admitted,
                    };
                } finally {
                    openingDirectories--;
                }

                if (stopped(named.path)) {
                    await cursor.handle.close();
                    return { entries, issues: [issue("interrupted", named.path).issue] };
                }

                token = randomUUID();
                cursors.set(token, cursor);
            }

            const active = token as string;
            if (stopped(named.path) || !(await stable(cursor.identity))) {
                issues.push(issue(stopped(named.path) ? "interrupted" : "changed", named.path).issue);
                await discard(active);
                return { entries, issues };
            }

            for (let scanned = 0; scanned < limits.pageSize; scanned++) {
                const entry = await cursor.handle.read();
                if (!entry) {
                    const unchanged = await stable(cursor.identity);
                    await discard(active);
                    return unchanged
                        ? { entries, issues }
                        : { entries: [], issues: [...issues, issue("changed", named.path).issue] };
                }

                const relativePath = named.path ? `${named.path}/${entry.name}` : entry.name;
                const admitted = await eligibility(relativePath);
                if (admitted.status === "issue") {
                    issues.push(admitted.issue);
                    if (admitted.issue.kind === "interrupted") {
                        await discard(active);
                        return { entries, issues };
                    }
                } else if (admitted.status === "eligible") {
                    entries.push({ path: relativePath, kind: admitted.stat.isDirectory() ? "directory" : "file" });
                }
            }

            if (!(await stable(cursor.identity))) {
                await discard(active);
                return { entries: [], issues: [...issues, issue("changed", named.path).issue] };
            }

            return { entries, nextCursor: active, issues };
        } catch (error) {
            if (token) {
                await discard(token);
            }

            return { entries: [], issues: [...issues, issue(errorKind(error), named.path).issue] };
        }
    }

    async function close(): Promise<void> {
        closed = true;
        ruleCache.clear();
        await Promise.all([...cursors.keys()].map(discard));
    }

    return { root, readSnapshot, lookupFile, listPage, closeCursor: discard, close };
}

export type FilesystemReader = Awaited<ReturnType<typeof createFilesystem>>;
