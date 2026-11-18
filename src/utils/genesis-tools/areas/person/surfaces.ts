import { createInterface } from "node:readline/promises";
import { env } from "@genesiscz/utils/env";
import type { ActionContext, Pass } from "@genesiscz/utils/genesis-tools/actions/define";
import { genesisToolsRequestOpenCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { out } from "@genesiscz/utils/logger";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import { personConfigSchema } from "./deliveries";
import { type PersonRequest, type RequestOutcome, requestOutcomeSchema, requestWindowDeadline } from "./request";
import { DIALOG_SYSTEM, dialogEnvironment, PERSON_DIALOGS } from "./system-dialog";

export type RequestContext = ActionContext<PersonRequest, Record<string, unknown>>;

export async function presentInApp(ctx: RequestContext): Promise<RequestOutcome | Pass> {
    refuseHostEffectInTest("request.present", "Inject a request surface in tests.");
    const { windowSeconds, callTimeoutMs } = requestWindowDeadline(ctx.timeoutMs, ctx.args.deadlineSeconds);
    const reply = await ctx.app.rpc(
        "request.present",
        { ...ctx.args, deadlineSeconds: windowSeconds },
        { timeoutMs: callTimeoutMs }
    );
    return reply.ok
        ? { ...requestOutcomeSchema.parse(reply.result), via: "app-window", method: "click" as const }
        : reply.error.code === "timeout"
          ? { id: ctx.args.id, status: "pending", reason: "The request window has not answered yet." }
          : ctx.pass(`${reply.error.code}: ${reply.error.message}`);
}

export async function presentInSystemDialog(ctx: RequestContext): Promise<RequestOutcome | Pass> {
    refuseHostEffectInTest("request system dialog", "Inject a request surface in tests.");
    const dialog = PERSON_DIALOGS[ctx.facts.platform()];
    const argv = dialog?.command({ title: ctx.args.title, body: ctx.args.reason }, DIALOG_SYSTEM);
    if (!dialog || !argv) {
        return ctx.pass("No trusted system dialog program is installed.");
    }
    const timeout = Math.max(1, Math.min(ctx.timeoutMs, (ctx.args.deadlineSeconds ?? ctx.timeoutMs / 1000) * 1000));
    const input = dialog.input?.({ title: ctx.args.title, body: ctx.args.reason });
    const proc = Bun.spawn(argv, {
        env: dialogEnvironment(dialog.searchPath),
        stdin: input === undefined ? "ignore" : Buffer.from(input, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
        timeout,
    });
    const [, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    // `exited` resolves 143 for a process the timeout killed; `exitCode` stays null for it, so a deadline reads as one.
    const answer = dialog.answer({ exitCode: proc.exitCode, stdout, stderr });
    if (answer === "gave-up") {
        return {
            id: ctx.args.id,
            status: "pending",
            reason: "The system dialog was not answered before its deadline.",
        };
    }
    if (answer === "failed") {
        return ctx.pass(`System dialog failed: ${stderr.trim() || `exit ${proc.exitCode}`}`);
    }
    return {
        id: ctx.args.id,
        status: answer === "approved" ? "done" : "declined",
        reason: null,
        via: "system-dialog",
        method: "click",
    };
}

export async function presentInTerminal(ctx: RequestContext): Promise<RequestOutcome> {
    refuseHostEffectInTest("request terminal", "Inject a request surface in tests.");
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    const signal = AbortSignal.timeout(
        Math.max(1, Math.min(ctx.timeoutMs, (ctx.args.deadlineSeconds ?? ctx.timeoutMs / 1000) * 1000))
    );
    out.log.info(`${ctx.args.title}\n${ctx.args.reason}`);
    try {
        const answer = await terminal.question("Acknowledge? [y/N] ", { signal });
        return {
            id: ctx.args.id,
            status: /^y(?:es)?$/i.test(answer.trim()) ? "done" : "declined",
            reason: null,
            via: "terminal",
            method: "terminal",
        };
    } catch (error) {
        if (!signal.aborted) {
            throw error;
        }
        return { id: ctx.args.id, status: "pending", reason: "The terminal wait reached its deadline." };
    } finally {
        terminal.close();
    }
}

export async function notifyRequest(ctx: RequestContext): Promise<RequestOutcome | Pass> {
    refuseHostEffectInTest("request notification", "Inject a notification sender in tests.");
    const reply = await ctx.app.rpc(
        "notify.post",
        {
            id: ctx.args.id,
            title: ctx.args.title,
            message: ctx.args.reason,
            sound: personConfigSchema.parse(ctx.areaConfig).notification.sound,
            execute: genesisToolsRequestOpenCommand(ctx.args.id),
            genesisHome: env.tools.getHome(),
        },
        { timeoutMs: Math.min(ctx.timeoutMs, 10_000) }
    );
    return reply.ok
        ? { id: ctx.args.id, status: "pending", reason: "The notification opens this request when clicked." }
        : ctx.pass(`${reply.error.code}: ${reply.error.message}`);
}

export async function notifyViaChannels(ctx: RequestContext): Promise<RequestOutcome | Pass> {
    refuseHostEffectInTest("request notification channels", "Inject notification channels in tests.");
    const { dispatchNotificationReport, notificationsConfig, CHANNEL_NAMES } = await import(
        "@genesiscz/utils/notifications"
    );
    const channels = await notificationsConfig.getChannels("genesis-tools");
    const { unconfiguredChannel } = await import("@genesiscz/utils/notifications/dispatch");
    if (!CHANNEL_NAMES.some((name) => channels[name].enabled && !unconfiguredChannel(name, channels))) {
        return ctx.pass("No notification channel is enabled.");
    }
    const report = await dispatchNotificationReport({
        app: "genesis-tools",
        id: ctx.args.id,
        title: ctx.args.title,
        message: ctx.args.reason,
        execute: genesisToolsRequestOpenCommand(ctx.args.id),
        sound: personConfigSchema.parse(ctx.areaConfig).notification.sound,
    });
    if (report.sent.length === 0) {
        // Nothing reached the person: the next way prints the command that opens the request.
        return ctx.pass("Every enabled notification channel failed to send the request.");
    }
    return report.delivered
        ? {
              id: ctx.args.id,
              status: "pending",
              reason: "The request was handed to the configured notification channels.",
          }
        : {
              id: ctx.args.id,
              status: "pending",
              reason: `Only ${report.sent.join(", ")} sent the request; it stays open.`,
          };
}

export async function printRequest(ctx: RequestContext): Promise<RequestOutcome | Pass> {
    if (ctx.facts.isTest()) {
        return ctx.pass("in-test: a test process never delivers a request");
    }
    const manual = genesisToolsRequestOpenCommand(ctx.args.id);
    out.log.info(`${ctx.args.title}\n${ctx.args.reason}\n${manual}`);
    return {
        id: ctx.args.id,
        status: "unreachable",
        reason: `No person surface answered. Open the request with ${manual}`,
        manual,
    };
}
