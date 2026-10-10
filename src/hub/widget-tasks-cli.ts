import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import {
    createWidgetTask,
    editWidgetTask,
    listWidgetTasks,
    updateWidgetTask,
    WIDGET_TASK_ACTIONS,
    WIDGET_TASK_SCOPES,
    WIDGET_TASK_STATES,
} from "./lib/widget/tasks";

/** Thin adapter; Tasks use the existing shared Decisions TODO ledger, never Widget state storage. */
export function registerWidgetTasks(widget: Command): void {
    const tasks = widget.command("tasks").description("Local tasks from the existing Decisions TODO ledger");
    tasks
        .command("list")
        .option("--json")
        .option("--scope [scope]", "active, completed, dismissed or all")
        .option("--project <project...>", "Exact stored project names")
        .option("--session <identity...>", "Exact provider:session identities")
        .option("--limit <count>", "Maximum rows (1–250)", Number, 200)
        .action(async (options) => {
            const scope = await pickEnumFlag({
                tool: "tools",
                subcommand: ["hub", "widget", "tasks", "list"],
                flag: "--scope",
                given: options.scope,
                values: WIDGET_TASK_SCOPES,
                fallback: "active",
                accepts: (value): value is (typeof WIDGET_TASK_SCOPES)[number] =>
                    WIDGET_TASK_SCOPES.some((item) => item === value),
            });
            if (!scope) {
                return;
            }
            out.result(
                listWidgetTasks({
                    filters: { scope, projects: options.project, sessions: options.session, limit: options.limit },
                })
            );
        });
    tasks
        .command("update <id>")
        .requiredOption("--action [action]", "acknowledge, complete, reopen or dismiss")
        .requiredOption("--revision <revision>", "Revision shown by list", Number)
        .requiredOption("--state [state]", "open, acknowledged, implemented or dismissed; use the state shown by list")
        .requiredOption("--updated-at <timestamp>", "Stored updatedTs shown by list")
        .requiredOption("--session <id>", "Stored source session")
        .requiredOption("--provider <provider>", "Stored source provider")
        .action(async (id: string, options) => {
            const subcommand = ["hub", "widget", "tasks", "update", id];
            const action = await pickEnumFlag({
                tool: "tools",
                subcommand,
                flag: "--action",
                given: options.action,
                values: WIDGET_TASK_ACTIONS,
                fallback: "acknowledge",
                accepts: (value): value is (typeof WIDGET_TASK_ACTIONS)[number] =>
                    WIDGET_TASK_ACTIONS.some((item) => item === value),
            });
            const state = await pickEnumFlag({
                tool: "tools",
                subcommand,
                flag: "--state",
                given: options.state,
                values: WIDGET_TASK_STATES,
                fallback: "open",
                accepts: (value): value is (typeof WIDGET_TASK_STATES)[number] =>
                    WIDGET_TASK_STATES.some((item) => item === value),
            });
            if (!action || !state) {
                return;
            }
            await withInterrupt(
                async (signal) => {
                    out.result(
                        await updateWidgetTask({
                            signal,
                            input: {
                                id,
                                action,
                                expected: {
                                    revision: options.revision,
                                    state,
                                    updatedTs: options.updatedAt,
                                    sessionId: options.session,
                                    provider: options.provider,
                                },
                            },
                        })
                    );
                },
                { handleTermination: true }
            );
        });
    tasks
        .command("create")
        .description("Add a task by hand: on a chosen session, or on the local task list")
        .option("--json")
        .requiredOption("--title <title>", "One line; up to 180 characters")
        .option("--details <text>", "The longer text; up to 2000 characters")
        .option("--session <identity>", "provider:sessionId the task belongs to (default: local tasks)")
        .option("--session-title <title>", "Title shown for that session")
        .option("--project <project>", "Project name the task files under")
        .option("--cwd <path>", "Working directory of that project")
        .action(async (options) => {
            await withInterrupt(
                async (signal) => {
                    out.result(
                        await createWidgetTask({
                            signal,
                            input: {
                                title: options.title,
                                details: options.details,
                                session: options.session,
                                sessionTitle: options.sessionTitle,
                                project: options.project,
                                cwd: options.cwd,
                            },
                        })
                    );
                },
                { handleTermination: true }
            );
        });
    tasks
        .command("edit <id>")
        .description("New title and text for an open task; the earlier text stays as a prior version")
        .option("--json")
        .requiredOption("--title <title>", "One line; up to 180 characters")
        .option("--details <text>", "The longer text; omit to keep only the title")
        .requiredOption("--revision <revision>", "Revision shown by list", Number)
        .requiredOption("--state [state]", "The state shown by list; only open tasks can be edited")
        .requiredOption("--updated-at <timestamp>", "Stored updatedTs shown by list")
        .requiredOption("--session <id>", "Stored source session")
        .requiredOption("--provider <provider>", "Stored source provider")
        .action(async (id: string, options) => {
            const state = await pickEnumFlag({
                tool: "tools",
                subcommand: ["hub", "widget", "tasks", "edit", id],
                flag: "--state",
                given: options.state,
                values: WIDGET_TASK_STATES,
                fallback: "open",
                accepts: (value): value is (typeof WIDGET_TASK_STATES)[number] =>
                    WIDGET_TASK_STATES.some((item) => item === value),
            });
            if (!state) {
                return;
            }

            await withInterrupt(
                async (signal) => {
                    out.result(
                        await editWidgetTask({
                            signal,
                            input: {
                                id,
                                title: options.title,
                                details: options.details,
                                expected: {
                                    revision: options.revision,
                                    state,
                                    updatedTs: options.updatedAt,
                                    sessionId: options.session,
                                    provider: options.provider,
                                },
                            },
                        })
                    );
                },
                { handleTermination: true }
            );
        });
}
