import { registerTask } from "@app/daemon/lib/register";
import type { MemoActionKind } from "@app/dev-dashboard/contract/memos";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import { actOnMemo, listMemoActions, scanMemos } from "../lib/memos/index";

const ACTIONS: readonly MemoActionKind[] = ["reminders", "note", "agent"];

function actionArg(value: string): MemoActionKind {
    const action = ACTIONS.find((entry) => entry === value);

    if (!action) {
        throw new InvalidArgumentError(`one of ${ACTIONS.join(", ")}`);
    }

    return action;
}

/** The daemon task that scans for new memos. */
export const MEMO_SCAN_TASK = "hub-memo-scan";

/**
 * `tools hub memos`: Voice Memos turned into actions (F28), as the phone's Memos screen shows them
 * (`/api/gateway/memos`); `scan` (the daemon task), `act <id> <action>` (`POST /api/memos/act`) and `install`.
 */
export function registerMemosCommand(program: Command): void {
    const memos = program
        .command("memos")
        .description("Voice Memos turned into todos, a note and an agent task")
        .option("--json", "machine-readable output")
        .action((opts: { json?: boolean }) => {
            const result = listMemoActions();

            if (opts.json) {
                out.result(result);
                return;
            }

            renderCliHeader(
                "Memos",
                result.primedAt ? `${result.memos.length} memo(s)` : `not primed: ${toolCommand("hub memos scan")}`
            );
            const table = createBoxTable(["ID", "TITLE", "TODOS", "AGENT TASK", "DONE"]);

            for (const memo of result.memos) {
                table.push([
                    memo.id,
                    truncateDisplay(memo.title, 30),
                    String(memo.todos.length),
                    truncateDisplay(memo.agentTask ?? "", 30),
                    Object.keys(memo.done).join(", "),
                ]);
            }

            out.println(table.toString());
        });

    memos
        .command("scan")
        .description("Transcribe and split the memos recorded since the last scan (the first scan only primes)")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const fresh = await scanMemos();

            if (opts.json) {
                out.result({ fresh });
                return;
            }

            out.log.info(`${fresh.length} new memo(s).`);
        });

    memos
        .command("act")
        .description("Run one action of a memo once: reminders, note, or agent (with --session)")
        .argument("<id>", `a memo id from ${toolCommand("hub memos")}`)
        .argument("<action>", ACTIONS.join(", "), actionArg)
        .option("--session <key>", "agent: the agents board key of the session")
        .option("--json", "machine-readable output")
        .action(async (id: string, action: MemoActionKind, opts: { session?: string; json?: boolean }) => {
            const receipt = await actOnMemo({ id, action, sessionKey: opts.session });
            process.exitCode = receipt.ok ? 0 : 1;

            if (opts.json) {
                out.result(receipt);
                return;
            }

            out.log.info(receipt.detail);
        });

    memos
        .command("install")
        .description(`Register the ${MEMO_SCAN_TASK} daemon task: a scan every 10 minutes`)
        .action(async () => {
            await registerTask({
                name: MEMO_SCAN_TASK,
                command: toolCommand("hub memos scan"),
                every: "every 10 minutes",
                description: "Turn new Voice Memos into todos, a note and an agent task (needs Full Disk Access)",
                notify: "failure",
                overwrite: true,
            });
            out.log.success(`Registered ${MEMO_SCAN_TASK}. ${toolCommand("daemon status")} shows its next run.`);
        });
}
