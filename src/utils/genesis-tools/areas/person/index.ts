import { type ActionOutcome, defineAction, defineArea, type Pass } from "@genesiscz/utils/genesis-tools/actions/define";
import { Need } from "@genesiscz/utils/genesis-tools/capability/needs";
import { Delivery, personConfigSchema } from "./deliveries";
import { notice, windowNotice } from "./presets";
import { defineRequest, noticeInputSchema, type RequestOutcome, requestOutcomeSchema, requestSchema } from "./request";
import { notifyRequest, notifyViaChannels, presentInApp, presentInSystemDialog, printRequest } from "./surfaces";

export const person = defineArea({
    area: "person",
    summary: "Deliver requests to a person and keep their answers",
    config: personConfigSchema,
    actions: {
        ask: defineRequest({
            summary: "Post a request and ask the person now",
            args: noticeInputSchema,
            delivery: Delivery.askNow,
            wait: "settled",
            build: (args) => args,
        }),
        confirm: defineRequest({
            summary: "Ask the person to confirm an acknowledgement",
            args: noticeInputSchema,
            delivery: Delivery.askNow,
            wait: "settled",
            build: (args) => args,
        }),
        notice,
        windowNotice,
        showWindow: defineAction({
            summary: "Present a request using a connected face, the app, a system dialog or this terminal",
            args: requestSchema,
            result: requestOutcomeSchema,
            native: {
                needs: [Need.person.display, Need.service.client("request.present")],
                run: async (ctx) =>
                    ctx.service ? ctx.service.present(ctx.args, ctx.timeoutMs) : ctx.pass("No service door."),
            },
            fallback: {
                appProcess: { needs: [Need.person.display, Need.app.rpc("request.present")], run: presentInApp },
                systemDialog: { needs: [Need.person.display], run: presentInSystemDialog },
                terminal: {
                    needs: [Need.person.terminal],
                    run: async (ctx): Promise<RequestOutcome | Pass> => {
                        const outcome: ActionOutcome<RequestOutcome> = await ctx.terminal.prompt(ctx.args, {
                            timeoutMs: ctx.timeoutMs,
                        });
                        return outcome.status === "ran"
                            ? outcome.value
                            : ctx.pass(outcome.skipped.map((skip) => skip.reason).join("; "));
                    },
                },
            },
        }),
        notifyThenAsk: defineAction({
            summary: "Post a notification whose click opens the request",
            args: requestSchema,
            result: requestOutcomeSchema,
            native: { needs: [Need.app.rpc("notify.post")], run: notifyRequest },
            fallback: { channels: notifyViaChannels, print: printRequest },
        }),
        askNow: defineAction({
            summary: "Show the request now and wait for its answer",
            args: requestSchema,
            result: requestOutcomeSchema,
            native: async (ctx): Promise<RequestOutcome | Pass> => {
                const outcome: ActionOutcome<RequestOutcome> = await ctx.person.showWindow(ctx.args, {
                    timeoutMs: ctx.timeoutMs,
                });
                return outcome.status === "ran"
                    ? outcome.value
                    : ctx.pass(outcome.skipped.map((s) => s.reason).join("; "));
            },
        }),
        askElseNotify: defineAction({
            summary: "Ask now when a person can see a window; otherwise post a notification",

            args: requestSchema,
            result: requestOutcomeSchema,
            native: {
                needs: [Need.person.display],
                run: async (ctx): Promise<RequestOutcome | Pass> => {
                    if (ctx.facts.isAgent()) {
                        return ctx.pass("An agent posts a notification and does not wait for a person.");
                    }
                    const outcome: ActionOutcome<RequestOutcome> = await ctx.person.showWindow(ctx.args, {
                        timeoutMs: ctx.timeoutMs,
                    });
                    return outcome.status === "ran"
                        ? outcome.value
                        : ctx.pass(outcome.skipped.map((s) => s.reason).join("; "));
                },
            },
            fallback: {
                notification: async (ctx): Promise<RequestOutcome | Pass> => {
                    const outcome: ActionOutcome<RequestOutcome> = await ctx.person.notifyThenAsk(ctx.args, {
                        timeoutMs: ctx.timeoutMs,
                    });
                    return outcome.status === "ran"
                        ? outcome.value
                        : ctx.pass(outcome.skipped.map((s) => s.reason).join("; "));
                },
            },
        }),
    },
});

declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        person: typeof person;
    }
}
