import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { isProcessAlive } from "@app/task/lib/process-alive";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { CODEX_SCHEMA_VERSION } from "./_generated/protocol";
import { sessionDaemonLogPath, sessionLaunchPath } from "./paths";
import { type CodexSessionMeta, CodexSessionStore, type CodexWritePolicy } from "./store";
import { detectCodexVersion } from "./version";

export interface SpawnOptions {
    name: string;
    cwd?: string;
    home?: string;
    model?: string;
    effort?: string;
    write?: CodexWritePolicy;
    mode?: "review" | "task";
    prompt?: string;
    agents?: boolean;
    rendezvousSession?: string;
    writableRoots?: string[];
}

export interface LaunchConfig {
    name: string;
    prompt?: string;
    mode: "review" | "task";
    writableRoots: string[];
}

export function parseWritePolicy(value: string | undefined): CodexWritePolicy | undefined {
    if (value === undefined || value === "ask" || value === "allow" || value === "deny") {
        return value;
    }

    throw new Error("--write must be ask, allow, or deny");
}

export function resolveWritePolicy(
    write?: CodexWritePolicy
): Pick<CodexSessionMeta, "writePolicy" | "sandbox" | "approvalPolicy"> {
    if (write === "ask") {
        return { writePolicy: "ask", sandbox: "workspace-write", approvalPolicy: "untrusted" };
    }

    if (write === "allow") {
        return { writePolicy: "allow", sandbox: "workspace-write", approvalPolicy: "never" };
    }

    return { writePolicy: "deny", sandbox: "read-only", approvalPolicy: "never" };
}

export async function spawnCodexSession(options: SpawnOptions): Promise<CodexSessionMeta> {
    const store = new CodexSessionStore();
    const existing = await store.readMeta(options.name);
    if (
        existing &&
        existing.status !== "closed" &&
        existing.status !== "failed" &&
        isProcessAlive(existing.daemonPid)
    ) {
        throw new Error(`Codex session "${options.name}" is already active (pid ${existing.daemonPid})`);
    }

    const rendezvousSession =
        options.rendezvousSession ??
        env.ai.getByEnvKey("CLAUDE_CODE_SESSION_ID") ??
        env.getTrimmed("GT_RENDEZVOUS_SESSION");
    const agentsEnabled = options.agents ?? true;
    if (agentsEnabled && !rendezvousSession) {
        throw new Error("A parent agents session is required. Run from Claude Code or pass --session <id>.");
    }

    const codexVersion = await detectCodexVersion();
    const now = new Date().toISOString();
    const cwd = resolve(options.cwd ?? process.cwd());
    const policy = resolveWritePolicy(options.write);
    const writableRoots = [...(options.writableRoots ?? [])];

    if (agentsEnabled && policy.sandbox === "workspace-write") {
        writableRoots.push(join(env.tools.getHome(), ".genesis-tools"));
    }

    const launch: LaunchConfig = {
        name: options.name,
        mode: options.mode ?? "task",
        writableRoots: [...new Set(writableRoots.map((path) => resolve(path)))],
        ...(options.prompt ? { prompt: options.prompt } : {}),
    };
    atomicWriteFileSync(sessionLaunchPath(options.name), SafeJSON.stringify(launch, null, 2));

    const daemonEntry = resolve(import.meta.dir, "../daemon.ts");
    const logFd = openSync(sessionDaemonLogPath(options.name), "a");
    const meta: CodexSessionMeta = {
        name: options.name,
        daemonPid: 0,
        cwd,
        ...(options.home ? { home: resolve(options.home) } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...policy,
        status: "starting",
        agentName: `codex_${options.name}`,
        rendezvousSession: rendezvousSession ?? `codex-${options.name}`,
        agentsEnabled,
        startedAt: now,
        lastEventAt: now,
        codexVersion,
        pendingApprovals: {},
    };
    store.writeMeta(meta);

    const proc = (() => {
        try {
            return Bun.spawn({
                cmd: [process.execPath, daemonEntry, "--name", options.name],
                cwd,
                env: {
                    ...env.getProcessEnv(),
                    ...(rendezvousSession ? { GT_RENDEZVOUS_SESSION: rendezvousSession } : {}),
                },
                stdin: "ignore",
                stdout: logFd,
                stderr: logFd,
                detached: true,
            });
        } finally {
            closeSync(logFd);
        }
    })();
    proc.unref();
    store.writeMeta({ ...meta, daemonPid: proc.pid });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const current = await store.readMeta(options.name);
        if (current?.status === "ready" || current?.status === "running") {
            return current;
        }

        if (current?.status === "failed" || current?.status === "closed") {
            throw new Error(`Codex daemon failed to start. See ${sessionDaemonLogPath(options.name)}`);
        }

        await Bun.sleep(50);
    }

    throw new Error(`Timed out starting Codex session. See ${sessionDaemonLogPath(options.name)}`);
}

export function schemaDriftWarning(version: string): string | null {
    return version === CODEX_SCHEMA_VERSION
        ? null
        : `Installed codex ${version} differs from generated app-server schema ${CODEX_SCHEMA_VERSION}`;
}
