import { rm } from "node:fs/promises";
import {
    REMOTE_DIR_RE,
    SSH_HOST_RE,
    SshRsyncTargetSchema,
} from "@app/dev-dashboard/lib/share/drivers/ssh-rsync/options";
import {
    pageUrlUnder,
    type ShareDriver,
    setupValue,
    targetOf,
    validateUrl,
} from "@app/dev-dashboard/lib/share/drivers/types";
import { withShareSnapshot } from "@app/dev-dashboard/lib/share/snapshot";
import { SHARE_SLUG_RE } from "@app/dev-dashboard/lib/share/source";
import { vaultShareSource } from "@app/dev-dashboard/lib/share/vault-source";
import { Executor } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { makeTempDir } from "@genesiscz/utils/paths";

const { log } = logger.scoped("share-ssh-rsync");

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const UPLOAD_DEADLINE = { ms: 300_000, reason: "an upload of a note with its attachments" };
const exec = new Executor({ label: "share-ssh-rsync", timeout: { ms: 30_000, reason: "one ssh command" } });

async function run(command: string[], timeout?: { ms: number; reason: string }): Promise<string> {
    const result = await exec.exec(command, timeout ? { timeout } : undefined);

    if (!result.success) {
        throw new Error(`${command[0]} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
    }

    return result.stdout;
}

/** `<dataDir>/<slug>`, both already proven to be one shell word each (`REMOTE_DIR_RE`, `SHARE_SLUG_RE`). */
function remoteDir(dataDir: string, slug: string): string {
    if (!SHARE_SLUG_RE.test(slug) || !REMOTE_DIR_RE.test(dataDir)) {
        throw new Error(`refusing a remote path for slug "${slug}" under "${dataDir}"`);
    }

    return `${dataDir}/${slug}`;
}

function rsync(from: string, host: string, to: string): Promise<string> {
    return run(
        ["rsync", "-a", "--delete", "-e", `ssh ${SSH_OPTIONS.join(" ")}`, `${from}/`, `${host}:${to}/`],
        UPLOAD_DEADLINE
    );
}

/**
 * Snapshots go to `<host>:<dataDir>/<slug>/` with rsync over ssh (a WireGuard host, for example), where
 * `tools dev-dashboard share-server up --data <dataDir>` serves them.
 */
export const sshRsyncDriver: ShareDriver = {
    kind: "ssh-rsync",
    summary: "rsync each snapshot over ssh into the data folder of a share server you can ssh to",
    pageUrl: async (target, slug) => pageUrlUnder(targetOf(target, "ssh-rsync").publicBase, slug),
    sync: async (target, note) => {
        const { host, dataDir } = targetOf(target, "ssh-rsync");
        const dir = remoteDir(dataDir, note.slug);

        await withShareSnapshot({
            source: vaultShareSource(),
            note,
            fn: async (local) => {
                await run(["ssh", ...SSH_OPTIONS, host, "mkdir", "-p", "--", dataDir]);
                await rsync(local, host, dir);
            },
        });
        log.info({ target: target.name, slug: note.slug }, "share snapshot sent with rsync");
    },
    remove: async (target, slug) => {
        const { host, dataDir } = targetOf(target, "ssh-rsync");
        const dir = remoteDir(dataDir, slug);
        const empty = makeTempDir("share-empty-");

        try {
            // rsync empties the folder, rmdir then removes it: nothing on the host is deleted by a recursive rm.
            await rsync(empty, host, dir);
            await run(["ssh", ...SSH_OPTIONS, host, "rmdir", "--", dir]);
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    },
    listSlugs: async (target) => {
        const { host, dataDir } = targetOf(target, "ssh-rsync");
        const listing = await run(["ssh", ...SSH_OPTIONS, host, "ls", "-1", "--", dataDir]);

        return listing.split("\n").filter((name) => SHARE_SLUG_RE.test(name));
    },
    setup: async (input) => {
        const host = await setupValue(input, {
            flag: "host",
            message: "ssh destination (user@host)",
            validate: (value) => (SSH_HOST_RE.test(value) ? undefined : "user@host or host"),
        });
        const dataDir = await setupValue(input, {
            flag: "data-dir",
            message: "Snapshot folder on that host (the share server's --data)",
            validate: (value) => (REMOTE_DIR_RE.test(value) ? undefined : "an absolute path of [A-Za-z0-9._/-]"),
        });
        const publicBase = await setupValue(input, {
            flag: "public-base",
            message: "Public base of the share pages there (https://host/share)",
            validate: validateUrl,
        });
        await run(["ssh", ...SSH_OPTIONS, host, "mkdir", "-p", "--", dataDir]);

        return SshRsyncTargetSchema.parse({ name: input.name, driver: "ssh-rsync", host, dataDir, publicBase });
    },
    forget: async (target) => {
        log.debug({ target: target.name }, "ssh-rsync stores nothing outside the config");
    },
};
