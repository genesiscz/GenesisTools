#!/usr/bin/env bun
/**
 * The approval driver for one Codex `--write ask` worker. The daemon already accepts plainly read-only commands; this
 * approves what the brief allows and prints the rest as NEEDS LEAD for the master. One line per decision (a Monitor
 * feed). It reads the worker's entry in the run card:
 *   { "prs": [{ "name": "bs-511-sol", "cwd": "<abs>", "scope": ["src/a.ts", …], "subject": "fix(x): #511 followup - …",
 *               "verify": ["bun scripts/test.ts src/a.test.ts", "bunx tsgo --noEmit", "bunx biome check"] }] }
 * Approved: a file change whose every path is in scope or under .claude/work/babysit/; `git add` of scope paths; one
 * `git commit -m` whose subject starts with the brief's subject up to " - "; a command that starts with a verify
 * entry; `mkdir -p .claude/work/babysit`; the review-loop round-summary renderer. Everything else waits for the lead:
 * chaining, redirection, expansion, sandbox escalations (their request shows the reason, not the command), rituals.
 *
 * Usage: bun .claude/skills/babysit/scripts/approve-codex.ts --run <run.json> --name <codex session>
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export interface RunEntry {
    name: string;
    cwd: string;
    scope: string[];
    subject: string;
    verify: string[];
}

const inScope = (entry: RunEntry, path: string) =>
    entry.scope.includes(path) || path.startsWith(".claude/work/babysit/");

/** The script inside `/bin/zsh -lc '…'`, or the command itself. */
export function innerCommand(detail: string): string {
    const match =
        detail.match(/^\S*(zsh|bash|sh) -l?c '([\s\S]*)'$/) ?? detail.match(/^\S*(zsh|bash|sh) -l?c "([\s\S]*)"$/);
    return (match ? match[2] : detail).trim();
}

/** Whether a command approval is one the brief allows. Pure, so it can be replayed on a past session's requests. */
export function allowedCommand(entry: RunEntry, command: string): boolean {
    // One command only: chaining, redirection and expansion always go to the lead.
    if (/[;&|<>`$\n]/.test(command.replace(/'[^']*'|"[^"$`]*"/g, "''"))) {
        return false;
    }

    const add = command.match(/^git add (?:-- )?(.+)$/);

    if (add) {
        return add[1].split(/\s+/).every((path) => inScope(entry, path.replace(/^['"]|['"]$/g, "")));
    }

    if (/^git commit -m /.test(command)) {
        const paths = command.includes(" -- ") ? command.slice(command.lastIndexOf(" -- ") + 4).split(/\s+/) : [];
        const pathsOk = paths.every((path) => inScope(entry, path.replace(/^['"]|['"]$/g, "")));

        return (
            pathsOk && command.includes(entry.subject.split(" - ")[0]) && !/--amend|--no-verify|\s-a\b/.test(command)
        );
    }

    if (/^mkdir -p \.claude\/work\/babysit\/?$/.test(command)) {
        return true;
    }

    if (/^bun \S*review-loop\/scripts\/round-summary\.ts /.test(command)) {
        return true;
    }

    return entry.verify.some((verify) => command.startsWith(verify));
}

/** The paths a file-change approval names: `edit a, b (reason)` since 886b44308, else none known. */
export function fileChangeDetailPaths(detail: string): string[] {
    return detail.startsWith("edit ")
        ? detail
              .slice(5)
              .replace(/\s+\(.*$/, "")
              .split(/,\s*/)
        : [];
}

/** Paths of the newest file change in the raw event log, for a daemon older than 886b44308. */
function fileChangePathsFromLog(entry: RunEntry): string[] {
    const tail = Bun.spawnSync(["tools", "codex", "tail", "--name", entry.name, "--tail", "10"], { stdout: "pipe" });
    const raw = tail.stdout.toString();
    const last = raw.lastIndexOf('"type":"fileChange"');
    const slice = last >= 0 ? raw.slice(last, last + 20_000) : "";
    const end = slice.indexOf('"method"', 1);

    return [...(end > 0 ? slice.slice(0, end) : slice).matchAll(/"path":"([^"]+)"/g)].map((match) =>
        relative(entry.cwd, match[1])
    );
}

/** The decision for one pending request: approve, and the label to print. */
export function decide(
    entry: RunEntry,
    request: { method?: string; detail?: string },
    readLog: () => string[] = () => fileChangePathsFromLog(entry)
): { ok: boolean; label: string } {
    const method = request.method ?? "";
    const detail = String(request.detail ?? "");

    if (method.includes("fileChange")) {
        const named = fileChangeDetailPaths(detail);
        const paths = named.length > 0 ? named : readLog();

        return {
            ok: paths.length > 0 && paths.every((path) => inScope(entry, path)),
            label: `edit ${paths.join(", ")}`,
        };
    }

    const command = innerCommand(detail);
    const isCommand = method.includes("commandExecution") || method === "execCommandApproval";

    return { ok: isCommand && allowedCommand(entry, command), label: command };
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

    const seen = new Set<string>();
    console.log(`approver for ${name}: ${entry.scope.length} scope file(s), ${entry.verify.length} verify command(s)`);

    for (;;) {
        const status = Bun.spawnSync(["tools", "codex", "status", "--name", name, "--json"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        let meta: { status?: string; pendingApprovals?: Record<string, { method?: string; detail?: string }> } | null =
            null;

        try {
            meta = SafeJSON.parse(status.stdout.toString(), { strict: true });
        } catch {
            // a transient read; try again
        }

        if (meta?.status === "closed") {
            console.log(`[approver] session ${name} closed`);
            return;
        }

        for (const [id, request] of Object.entries(meta?.pendingApprovals ?? {})) {
            if (seen.has(id)) {
                continue;
            }

            seen.add(id);
            const { ok, label } = decide(entry, request);
            const shown = label.replace(/\s+/g, " ").slice(0, 200);

            if (ok) {
                const result = Bun.spawnSync(["tools", "codex", "approve", "--name", name, "--request", id], {
                    stdout: "pipe",
                    stderr: "pipe",
                });
                console.log(`[approver] approved #${id} (exit ${result.exitCode}): ${shown}`);
            } else {
                console.log(`[approver] NEEDS LEAD #${id} ${request.method ?? ""}: ${shown}`);
            }
        }

        await Bun.sleep(1500);
    }
}

if (import.meta.main) {
    await main();
}
