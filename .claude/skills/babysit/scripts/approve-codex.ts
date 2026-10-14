#!/usr/bin/env bun
/**
 * The approval driver for one Codex `--write ask` worker. The daemon already accepts plainly read-only commands; this
 * approves what the brief allows and prints the rest as NEEDS LEAD for the master. One line per decision (a Monitor
 * feed). It reads the worker's entry in the run card:
 *   { "prs": [{ "name": "bs-511-sol", "cwd": "<abs>", "scope": ["src/a.ts", …], "subject": "fix(x): #511 followup - …",
 *               "verify": ["bun scripts/test.ts src/a.test.ts", "bunx tsgo --noEmit", "bunx biome check"] }] }
 * Approved: normalized in-scope file changes, path-limited git add and commit commands matching the brief's
 * subject, exact configured verification commands, and creation of the babysit scratch folder.
 * Configure the full round-summary command as a verify entry when it should be approved. Everything else waits:
 * chaining, redirection, expansion, sandbox escalations (their request shows the reason, not the command), rituals.
 *
 * Usage: bun .claude/skills/babysit/scripts/approve-codex.ts --run <run.json> --name <codex session>
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { strictShellWords } from "@app/codex/lib/bus-approval";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";

export interface RunEntry {
    name: string;
    cwd: string;
    scope: string[];
    subject: string;
    verify: string[];
}

const inScope = (entry: RunEntry, path: string) => {
    const root = resolve(entry.cwd);
    const target = resolve(root, path);
    const local = relative(root, target);

    if (!local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep) || /[:*?[\]]/.test(path)) {
        return false;
    }

    const scratch = resolve(root, ".claude/work/babysit");
    return entry.scope.some((allowed) => target === resolve(root, allowed)) || target.startsWith(scratch + sep);
};

/** Unwrap only an exactly parsed invocation of a known system shell. */
export function innerCommand(command: string): string {
    const words = strictShellWords(command);
    const shells = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"];
    return words?.length === 3 && shells.includes(words[0]) && ["-c", "-lc"].includes(words[1]) ? words[2] : command;
}

/** Whether a command approval is one the brief allows. Pure, so it can be replayed on a past session's requests. */
export function allowedCommand(entry: RunEntry, command: string): boolean {
    const words = strictShellWords(command);

    if (!words || words.length === 0) {
        return false;
    }

    if (words[0] === "git" && words[1] === "add" && words[2] === "--") {
        return words.length > 3 && words.slice(3).every((path) => inScope(entry, path));
    }

    if (words[0] === "git" && words[1] === "commit" && words[2] === "-m") {
        return (
            words[4] === "--" &&
            words.length > 5 &&
            words[3].startsWith(entry.subject.split(" - ")[0] + " - ") &&
            words.slice(5).every((path) => inScope(entry, path))
        );
    }

    if (words.length === 3 && words[0] === "mkdir" && words[1] === "-p" && words[2] === ".claude/work/babysit") {
        return true;
    }

    return entry.verify.some((verify) => {
        const allowed = strictShellWords(verify);
        return allowed?.length === words.length && allowed.every((word, index) => word === words[index]);
    });
}

interface ApprovalRequest {
    method?: string;
    detail?: string;
    /** Exact paths from the daemon's file-change item. Missing on older daemons: ask the lead. */
    paths?: unknown;
    command?: unknown;
    cwd?: unknown;
}

/** The decision for one pending request: approve, and the label to print. */
export function decide(entry: RunEntry, request: ApprovalRequest): { ok: boolean; label: string } {
    const method = request.method ?? "";
    const detail = String(request.detail ?? "");

    if (method.includes("fileChange")) {
        const paths = request.paths;

        return {
            ok:
                Array.isArray(paths) &&
                paths.length > 0 &&
                paths.every((path) => typeof path === "string" && path.length > 0 && inScope(entry, path)),
            label: detail,
        };
    }

    const isCommand = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
    const command = typeof request.command === "string" ? innerCommand(request.command) : null;
    const sameCwd =
        typeof request.cwd === "string" && isAbsolute(request.cwd) && resolve(request.cwd) === resolve(entry.cwd);

    return { ok: isCommand && sameCwd && command !== null && allowedCommand(entry, command), label: detail };
}

export async function watchApprovals({
    entry,
    exec = execTool,
    now = Date.now,
    sleep = Bun.sleep,
    timeoutMs = 1_800_000,
    pollMs = 1500,
}: {
    entry: RunEntry;
    exec?: typeof execTool;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<void> {
    const seen = new Set<string>();
    const failures = new Map<string, number>();
    const deadline = now() + timeoutMs;
    const options = () => ({ cwd: entry.cwd, timeout: Math.max(1, Math.min(30_000, deadline - now())) });
    while (now() < deadline) {
        const status = await exec(["codex", "status", "--name", entry.name, "--json"], options());
        let meta: { status?: string; pendingApprovals?: Record<string, ApprovalRequest> } | null = null;
        try {
            if (status.success && !status.timedOut) {
                meta = SafeJSON.parse(status.stdout, { strict: true });
            } else {
                console.error("[approver] status failed: " + status.stderr);
            }
        } catch (error) {
            console.error("[approver] invalid status: " + String(error));
        }

        if (meta?.status === "closed") {
            console.log("[approver] session " + entry.name + " closed");
            return;
        }

        for (const [id, request] of Object.entries(meta?.pendingApprovals ?? {})) {
            if (seen.has(id) || (failures.get(id) ?? 0) >= 3 || now() >= deadline) {
                continue;
            }
            const { ok, label } = decide(entry, request);
            const shown = label.replace(/\s+/g, " ").slice(0, 200);
            if (!ok) {
                seen.add(id);
                console.log("[approver] NEEDS LEAD #" + id + " " + shown);
                continue;
            }

            let acknowledged = false;
            try {
                const result = await exec(["codex", "approve", "--name", entry.name, "--request", id], options());
                acknowledged = result.success && !result.timedOut;
                if (!acknowledged) {
                    console.error(
                        "[approver] approval failed #" + id + " (exit " + result.exitCode + "): " + result.stderr
                    );
                }
            } catch (error) {
                console.error("[approver] approval failed #" + id + ": " + String(error));
            }

            if (acknowledged) {
                seen.add(id);
                console.log("[approver] approved #" + id + ": " + shown);
            } else {
                const count = (failures.get(id) ?? 0) + 1;
                failures.set(id, count);
                if (count >= 3) {
                    console.error("[approver] NEEDS LEAD #" + id + ": approval failed 3 times");
                }
            }
        }
        await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    console.error("[approver] watch deadline reached for " + entry.name);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const flag = (name: string) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const runPath = flag("--run");
    const name = flag("--name");

    if (!runPath || !name) {
        console.error("usage: approve-codex.ts --run <run.json> --name <codex session>");
        process.exit(2);
    }

    const card = SafeJSON.parse(readFileSync(runPath, "utf8"), { strict: true }) as { prs: RunEntry[] };
    const entry = card.prs.find((pr) => pr.name === name);

    if (!entry) {
        console.error(`no entry named ${name} in ${runPath}`);
        process.exit(2);
    }

    await watchApprovals({ entry });
}

if (import.meta.main) {
    await main();
}
