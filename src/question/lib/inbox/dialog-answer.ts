import { planDialogKeys } from "@genesiscz/utils/agents/dialogs/keys";
import { openQuestions } from "@genesiscz/utils/agents/dialogs/store";
import { type DialogProvider, type OpenQuestion, openQuestionKey } from "@genesiscz/utils/agents/dialogs/types";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { paneMiss, type ToolRun } from "../decisions/deliver";
import type { InboxAnswerResult } from "./answer";

const { log } = logger.scoped("question-inbox");

/** What a dialog item's answer does: press the option in the live dialog, or refuse (widget `dialogAnswer`). */
export type DialogAnswerMode = "press" | "refuse";

export interface DialogAnswerDeps {
    /** The dialog records root, for tests. */
    recordsRoot?: string;
    /** Runs `tools <args>`; tests pass a fake that records the arguments. */
    runTool?: (args: string[]) => Promise<ToolRun>;
}

/** A dialog item's id, `provider:sessionId:toolCallId`; the tool call id may hold colons (`permission:<ISO>`). */
export function parseDialogKey(key: string): Pick<OpenQuestion, "provider" | "sessionId" | "toolCallId"> | null {
    const [provider, sessionId, ...rest] = key.split(":");
    const toolCallId = rest.join(":");

    if (!provider || !sessionId || !toolCallId || !isAccountProviderAlias(provider)) {
        return null;
    }

    return { provider: provider satisfies DialogProvider, sessionId, toolCallId };
}

function refused(session: string | null, error: string): InboxAnswerResult {
    log.warn({ session, error }, "dialog answer refused; no key was pressed");
    return { session, text: "", channel: "cmux", delivered: false, error, detail: error };
}

async function defaultRunTool(args: string[]): Promise<ToolRun> {
    return execTool(args, { timeout: 60_000 });
}

/**
 * Answers an inbox item that came from a dialog record (`source: "dialog"`, an agent's own question tool) by pressing
 * the option's key in the live dialog through `tools claude cmux send <session> --option <letter>`, never by typing
 * text: typed text plus Enter picks whatever row is highlighted (DecisionDetection.md, 2026-10-30 20:55). The harness
 * key map (`planDialogKeys`) decides whether the press is possible, so a Codex or Grok dialog refuses here, before any
 * process starts. Refuses too when the record is closed or gone, or when `mode` is "refuse".
 */
export async function answerDialogItem(
    {
        key,
        option,
        mode = "press",
        dryRun = false,
    }: { key: string; option: string; mode?: DialogAnswerMode; dryRun?: boolean },
    deps: DialogAnswerDeps = {}
): Promise<InboxAnswerResult> {
    const target = parseDialogKey(key);

    if (!target) {
        return refused(null, `"${key}" is not a dialog item id (provider:session:toolCallId)`);
    }

    if (mode === "refuse") {
        return refused(
            target.sessionId,
            "answers to an agent's own question dialog are set to refuse (widget setting dialogAnswer); answer it in the terminal"
        );
    }

    const record = openQuestions(target.provider, target.sessionId, deps.recordsRoot).find(
        (question) => openQuestionKey(question) === key
    );

    if (!record) {
        return refused(target.sessionId, "the dialog is no longer open; nothing was pressed");
    }

    const plan = planDialogKeys(record, option);

    if (!plan.ok) {
        return refused(target.sessionId, plan.reason);
    }

    if (dryRun) {
        return {
            session: target.sessionId,
            text: `${option}) ${plan.label}`,
            channel: "dry-run",
            delivered: false,
            detail: `Would press ${plan.presses.map((press) => ("key" in press ? press.key : press.text)).join(" ")} in the dialog`,
        };
    }

    const args = ["claude", "cmux", "send", target.sessionId, "--option", option, "--exact-session", "--json"];
    const run = await (deps.runTool ?? defaultRunTool)(args);
    let outcome: { sent?: unknown; reason?: unknown; ambiguous?: unknown } = {};

    try {
        const parsed: unknown = SafeJSON.parse(run.stdout, { strict: true });
        outcome = typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
        log.debug({ error, stdout: run.stdout.slice(0, 200) }, "cmux send --option printed no JSON outcome");
    }

    if (outcome.sent !== true) {
        // `--exact-session` refuses a pane found only by a title or a screen match, as the typed rung does.
        const why =
            typeof outcome.reason === "string"
                ? outcome.reason
                : outcome.ambiguous === true
                  ? "the session's cmux pane is not identified exactly (no recorded pane, only a weak match); nothing was pressed"
                  : paneMiss(run.stdout, run.stderr);
        return refused(target.sessionId, why);
    }

    log.info({ key, option, label: plan.label }, "dialog answered by its option key");
    return {
        session: target.sessionId,
        text: `${option}) ${plan.label}`,
        channel: "cmux",
        delivered: true,
        target: "the session's question dialog",
        detail: `Picked ${plan.label} in the dialog`,
    };
}
