import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assignedSessionId, resolveAgentHost } from "@genesiscz/utils/agent/host";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { primaryCodexHome } from "@genesiscz/utils/providers/session-paths";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { CODEX_SCHEMA_VERSION } from "./_generated/protocol";
import { CodexAccountBinding } from "./account";
import { computerUseOverrides } from "./computer-use";
import { sessionDaemonLogPath, sessionLaunchPath } from "./paths";
import { type CodexSessionMeta, CodexSessionStore, type CodexWritePolicy } from "./store";
import { detectCodexVersion } from "./version";

export interface SpawnOptions {
    computerUse?: boolean;
    account?: string;
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
    computerUse?: boolean;
    accountId?: string;
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

/**
 * True when the recorded daemon pid is alive AND still is this session's
 * daemon. A recycled pid (unrelated process inheriting the number) used to
 * block respawn forever with "already active" — verify the command line
 * matches the `bun daemon.ts --name <name>` shape before trusting it.
 */
function isCodexDaemonPid(pid: number, name: string): boolean {
    const identity = classifyPid(
        pid,
        (command) => command.includes(`--name ${name}`) && (command.includes("daemon") || command.includes("codex"))
    );

    if (identity.status === "foreign") {
        logger.warn(
            { pid, name, command: identity.command },
            "codex spawn: recorded daemon pid belongs to another process (pid reuse) — treating session as inactive"
        );
        return false;
    }

    return identity.status === "live" || identity.status === "unverified";
}

export async function spawnCodexSession(options: SpawnOptions): Promise<CodexSessionMeta> {
    const account = options.account
        ? await CodexAccountBinding.create(options.account, { allowRefresh: true })
        : undefined;
    await account?.tokens();
    const store = new CodexSessionStore();
    const existing = await store.readMeta(options.name);
    if (
        existing &&
        existing.status !== "closed" &&
        existing.status !== "failed" &&
        isCodexDaemonPid(existing.daemonPid, options.name)
    ) {
        throw new Error(`Codex session "${options.name}" is already active (pid ${existing.daemonPid})`);
    }

    // Any host session works as the parent swarm, not just Claude Code — grok and
    // codex publish their own ids and used to be turned away here.
    // Assigned first, host second: a nested worker that preferred its own host
    // id would put its children in a swarm its parent is not in.
    const rendezvousSession =
        options.rendezvousSession ??
        assignedSessionId(env.getProcessEnv()) ??
        resolveAgentHost(env.getProcessEnv()).sessionId;
    const agentsEnabled = options.agents ?? true;
    if (agentsEnabled && !rendezvousSession) {
        throw new Error(
            "A parent agents session is required. Run from a Claude Code, Codex or grok session, or pass --session <id>."
        );
    }

    const codexVersion = await detectCodexVersion();
    const now = new Date().toISOString();
    const cwd = resolve(options.cwd ?? process.cwd());
    const policy = resolveWritePolicy(options.write);
    const writableRoots = [...(options.writableRoots ?? [])];

    if (agentsEnabled && policy.sandbox === "workspace-write") {
        writableRoots.push(join(env.tools.getHome(), ".genesis-tools"));
    }

    // Always record the home this session will actually run in. Leaving it unset let the daemon
    // configure Computer Use against ~/.codex while the app-server inherited an ambient
    // CODEX_HOME, so the MCP runtime and the server it serves pointed at different directories.
    const home = resolve(options.home ?? primaryCodexHome() ?? join(homedir(), ".codex"));

    const launch: LaunchConfig = {
        ...(options.computerUse ? { computerUse: true } : {}),
        ...(account ? { accountId: account.accountId } : {}),
        name: options.name,
        mode: options.mode ?? "task",
        writableRoots: [...new Set(writableRoots.map((path) => resolve(path)))],
        ...(options.prompt ? { prompt: options.prompt } : {}),
    };
    if (options.computerUse) {
        // Validate here, in the process the user is watching. The daemon is already detached by
        // the time it reads this, so a missing runtime used to report a started session that was
        // in fact dead, with the reason only in the daemon log.
        computerUseOverrides({ home });
    }

    atomicWriteFileSync(sessionLaunchPath(options.name), SafeJSON.stringify(launch, null, 2));

    const daemonEntry = resolve(import.meta.dir, "../daemon.ts");
    const logFd = openSync(sessionDaemonLogPath(options.name), "a");
    const meta: CodexSessionMeta = {
        ...(account ? { accountId: account.accountId, accountName: account.name } : {}),
        name: options.name,
        daemonPid: 0,
        cwd,
        home,
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
