import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeTelegramWebhookIngress, type TelegramWebhookIngressRule } from "@app/ai-proxy/lib/tunnel/cloudflared";
import { renderUnifiedDiff } from "@genesiscz/utils/diff";
import { logger } from "@genesiscz/utils/logger";
import type { CaptureResult } from "@genesiscz/utils/process/ps";
import { assertTestSafePath } from "@genesiscz/utils/storage/real-home-guard";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export const CLOUDFLARED_LAUNCHD_LABEL = "com.cloudflare.cloudflared";

const { log } = logger.scoped("telegram-webhook-tunnel");

const COMMAND_TIMEOUT_MS = 30_000;

export interface TunnelPlan {
    configPath: string;
    before: string;
    after: string;
    changed: boolean;
    /** Existing rules for this hostname and path that the new rule replaces. */
    replacedRules: number;
    diff: string;
}

/** Pure: what the config would become, and the diff that shows it. Reads and writes nothing. */
export function planTunnelChange(options: {
    configPath: string;
    before: string;
    rule: TelegramWebhookIngressRule;
}): TunnelPlan {
    const merged = mergeTelegramWebhookIngress(options.before, options.rule);

    return {
        configPath: options.configPath,
        before: options.before,
        after: merged.yaml,
        changed: merged.changed,
        replacedRules: merged.removedLegacyRules,
        diff: renderUnifiedDiff({ before: options.before, after: merged.yaml, label: "cloudflared/config.yml" }),
    };
}

export function readTunnelConfig(configPath: string): string {
    if (!existsSync(configPath)) {
        throw new Error(`No cloudflared config at ${configPath}. Pass the right file with --config.`);
    }

    return readFileSync(configPath, "utf8");
}

export type CommandRunner = (command: string, args: string[], options: { timeoutMs: number }) => CaptureResult;

export interface ApplyTunnelOptions {
    plan: TunnelPlan;
    backupDir: string;
    run: CommandRunner;
    uid: number | undefined;
    now?: () => Date;
}

export interface ApplyTunnelResult {
    backupPath: string;
    restarted: boolean;
}

function stamp(date: Date): string {
    const part = (n: number) => String(n).padStart(2, "0");

    return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

const MAX_BACKUPS_PER_SECOND = 100;

function isAlreadyThere(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "EEXIST";
}

/**
 * Writes the backup under a name no earlier backup holds. `wx` fails when the file exists, so a second change
 * in the same second becomes `...-2.bak` instead of replacing the first backup, which is the only copy of the
 * config that change started from.
 */
function writeBackup({ dir, stamp, text }: { dir: string; stamp: string; text: string }): string {
    for (let n = 1; n <= MAX_BACKUPS_PER_SECOND; n++) {
        const path = join(dir, `config.yml.${stamp}${n === 1 ? "" : `-${n}`}.bak`);
        assertTestSafePath(path, "write");

        try {
            writeFileSync(path, text, { flag: "wx", mode: 0o600 });

            return path;
        } catch (err) {
            if (!isAlreadyThere(err)) {
                throw err;
            }
        }
    }

    throw new Error(`${MAX_BACKUPS_PER_SECOND} backups named config.yml.${stamp}*.bak already exist in ${dir}.`);
}

function failure(result: CaptureResult): string {
    return (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`).slice(0, 500);
}

/**
 * Back the file up, write the new rules, let cloudflared validate them, then restart the tunnel. The
 * backup is a copy of the exact text the plan was made from. A config that changed on disk since then is
 * refused rather than overwritten, and one cloudflared rejects is put back before anything restarts.
 */
export function applyTunnelChange(options: ApplyTunnelOptions): ApplyTunnelResult {
    const { plan, run } = options;

    if (readFileSync(plan.configPath, "utf8") !== plan.before) {
        throw new Error(`${plan.configPath} changed since it was read. Nothing was written; run the command again.`);
    }

    const mode = statSync(plan.configPath).mode & 0o777;
    mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
    const backupPath = writeBackup({
        dir: options.backupDir,
        stamp: stamp((options.now ?? (() => new Date()))()),
        text: plan.before,
    });
    log.info({ backupPath }, "backed up the cloudflared config");

    atomicWriteFileSync(plan.configPath, plan.after, { mode });
    log.info({ configPath: plan.configPath }, "wrote the new ingress rule");

    const validation = run("cloudflared", ["tunnel", "--config", plan.configPath, "ingress", "validate"], {
        timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (validation.status !== 0) {
        atomicWriteFileSync(plan.configPath, plan.before, { mode });
        log.error({ status: validation.status }, "cloudflared rejected the new rules; the original is back");
        throw new Error(
            `cloudflared rejected the new rules (${failure(validation)}). The original config is back in place.`
        );
    }

    if (options.uid === undefined) {
        return { backupPath, restarted: false };
    }

    const target = `gui/${options.uid}/${CLOUDFLARED_LAUNCHD_LABEL}`;
    const restart = run("launchctl", ["kickstart", "-k", target], { timeoutMs: COMMAND_TIMEOUT_MS });
    if (restart.status !== 0) {
        throw new Error(
            `The new rules are written and valid, but restarting ${target} failed (${failure(restart)}). Restart the tunnel yourself.`
        );
    }

    log.info({ target }, "restarted the tunnel");

    return { backupPath, restarted: true };
}
