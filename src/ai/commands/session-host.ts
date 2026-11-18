import { sessionHostActJson, sessionHostDescribeJson } from "@app/ai/lib/session-host/output";
import { actOnSessionHost, describeSessionHosts } from "@app/ai/lib/session-host/registry";
import { SESSION_HOST_ACTIONS, type SessionHostAction } from "@app/ai/lib/session-host/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

function printAnswerLines(answers: Awaited<ReturnType<typeof describeSessionHosts>>): void {
    for (const answer of answers) {
        const id = pc.magenta(answer.sessionId.slice(0, 8));

        if (!answer.host) {
            out.println(`${id} ${pc.dim(answer.reason)}`);
            continue;
        }

        const { host } = answer;
        const live = host.live === null ? pc.dim("unknown") : host.live ? pc.green("live") : pc.yellow("idle");
        out.println(`${id} ${pc.bold(host.place)} ${host.label} ${pc.dim("·")} ${live} ${pc.dim(`· ${host.note}`)}`);

        for (const action of SESSION_HOST_ACTIONS) {
            const state = host.actions[action];
            out.println(
                `    ${action.padEnd(9)} ${state.enabled ? pc.green(state.tip) : pc.dim(`off: ${state.reason}`)}`
            );
        }
    }
}

/**
 * `tools ai session-host`: where a session lives (a cmux pane, a T3 Code thread) and the actions there. The Genesis
 * session window reads the same answers; `--json` prints them as it decodes them.
 */
export function registerSessionHostCommands(program: Command): void {
    const host = program
        .command("session-host")
        .description("Where a session lives (cmux pane, T3 Code thread), and focus, wake or keepalive it there");

    host.command("describe <session-ids...>")
        .description("The host of each session, with each action's state")
        .option("--json", "Print the answers as JSON")
        .action(async (sessionIds: string[], opts: { json?: boolean }) => {
            if (opts.json) {
                out.result(await sessionHostDescribeJson(sessionIds));
                return;
            }

            printAnswerLines(await describeSessionHosts(sessionIds));
        });

    const verbs: Record<SessionHostAction, string> = {
        focus: "Raise the session where it lives (its cmux pane, its thread in T3 Code)",
        wake: "Send a short poke to the session",
        keepalive: "Send /keepalive to the session, where its host has one",
    };

    for (const action of SESSION_HOST_ACTIONS) {
        host.command(`${action} <session-id>`)
            .description(verbs[action])
            .option("--json", "Print the result as JSON")
            .action(async (sessionId: string, opts: { json?: boolean }) => {
                if (opts.json) {
                    const { json, ok } = await sessionHostActJson({ sessionId, action });
                    process.exitCode = ok ? 0 : 1;
                    out.result(json);
                    return;
                }

                const result = await actOnSessionHost({ sessionId, action });

                if (!result.ok) {
                    process.exitCode = 1;
                }

                if (result.ok) {
                    out.println(`${pc.green("✔")} ${result.detail}`);
                    return;
                }

                out.error(pc.red(result.reason));
            });
    }
}
