import { rm } from "node:fs/promises";
import { posix } from "node:path";
import { Executor } from "@genesiscz/utils/cli";
import { shareServerServeCommand } from "@genesiscz/utils/genesis-tools/tools/publish";
import { logger } from "@genesiscz/utils/logger";
import { makeTempDir } from "@genesiscz/utils/paths";
import { isSnapshotId, KIND_ID_RE, originOf } from "../ids";
import { isRemoteDataDir, isSshHost, PublishTargetSchema } from "../targets";
import { type PublishTransport, setupValue, targetWith, validateUrl } from "./types";

const { log } = logger.scoped("publish-ssh-rsync");

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const UPLOAD_DEADLINE = { ms: 300_000, reason: "sync a snapshot and its assets" };
const exec = new Executor({ label: "publish-ssh-rsync", timeout: { ms: 30_000, reason: "one ssh command" } });

export interface SshRsyncDeps {
    run: (command: string[], timeout?: { ms: number; reason: string }) => Promise<string>;
}

const liveDeps: SshRsyncDeps = {
    run: async (command, timeout) => {
        const result = await exec.exec(command, timeout ? { timeout } : undefined);
        if (!result.success) {
            throw new Error(`${command[0]} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
        }

        return result.stdout;
    },
};

function remoteKindDir(dataDir: string, kind: string): string {
    if (!isRemoteDataDir(dataDir) || !KIND_ID_RE.test(kind)) {
        throw new Error("invalid remote data directory or kind");
    }

    return posix.join(dataDir, kind);
}

function remoteSnapshotDir(kindDir: string, id: string): string {
    if (!isSnapshotId(id)) {
        throw new Error(`invalid snapshot id: ${id}`);
    }

    return posix.join(kindDir, id);
}

export function createSshRsyncTransport(
    deps: SshRsyncDeps = liveDeps
): PublishTransport & { readonly kind: "ssh-rsync" } {
    const ssh = (host: string, ...args: string[]) => deps.run(["ssh", ...SSH_OPTIONS, "--", host, ...args]);
    const rsync = (from: string, host: string, to: string) =>
        deps.run(
            [
                "rsync",
                "-a",
                "--delete",
                "--chmod=D755,F644",
                "-e",
                `ssh ${SSH_OPTIONS.join(" ")}`,
                "--",
                `${from}/`,
                `${host}:${to}/`,
            ],
            UPLOAD_DEADLINE
        );

    return {
        kind: "ssh-rsync",
        summary: "sync snapshots over SSH into a publish server's data directory",
        live: false,
        pageUrl: ({ target, kind, id }) => `${target.publicBase}/${kind}/${encodeURIComponent(id)}`,
        send: async ({ target, kind, id, dir }) => {
            const { host, dataDir } = targetWith(target, "ssh-rsync").transport;
            const kindDir = remoteKindDir(dataDir, kind);
            const remote = remoteSnapshotDir(kindDir, id);
            await ssh(host, "mkdir", "-p", "--", kindDir);
            await rsync(dir, host, remote);
            log.info({ target: target.name, kind, id }, "snapshot uploaded with rsync");
        },
        remove: async ({ target, kind, id }) => {
            const { host, dataDir } = targetWith(target, "ssh-rsync").transport;
            const remote = remoteSnapshotDir(remoteKindDir(dataDir, kind), id);
            const empty = makeTempDir("publish-empty-");

            try {
                // Copy an empty directory first so rmdir only removes the requested snapshot folder.
                await rsync(empty, host, remote);
                await ssh(host, "rmdir", "--", remote);
            } finally {
                await rm(empty, { recursive: true, force: true });
            }
        },
        list: async ({ target, kind }) => {
            const { host, dataDir } = targetWith(target, "ssh-rsync").transport;
            const dir = remoteKindDir(dataDir, kind);
            const listing = await ssh(host, "if", "test", "-d", dir, ";", "then", "ls", "-1", "--", dir, ";", "fi");
            return listing.split("\n").filter(isSnapshotId);
        },
        check: async (target) => {
            const { host, dataDir } = targetWith(target, "ssh-rsync").transport;
            try {
                await ssh(host, "test", "-d", dataDir);
                return [{ label: "SSH data directory", ok: true, detail: `${host}:${dataDir}` }];
            } catch (err) {
                return [
                    {
                        label: "SSH data directory",
                        ok: false,
                        detail: err instanceof Error ? err.message : String(err),
                    },
                ];
            }
        },
        setup: async (input) => {
            const host = await setupValue(input, {
                flag: "host",
                message: "SSH destination (user@host)",
                validate: (value) => (isSshHost(value) ? undefined : "user@host or host"),
            });
            const dataDir = await setupValue(input, {
                flag: "data-dir",
                message: `Snapshot directory on that host (see ${shareServerServeCommand()} --data)`,
                validate: (value) => (isRemoteDataDir(value) ? undefined : "an absolute directory path"),
            });
            const publicBase = originOf(
                await setupValue(input, {
                    flag: "public-base",
                    message: "Public origin of the publish server",
                    validate: validateUrl,
                })
            );
            const target = PublishTargetSchema.parse({
                name: input.name,
                publicBase,
                transport: { kind: "ssh-rsync", host, dataDir },
            });
            await ssh(host, "mkdir", "-p", "--", dataDir);
            return target;
        },
        forget: async (target) => {
            log.debug({ target: target.name }, "SSH targets store nothing outside the config");
        },
    };
}

export const sshRsyncTransport = createSshRsyncTransport();
