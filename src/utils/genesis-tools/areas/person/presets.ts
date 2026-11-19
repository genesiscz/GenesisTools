import { Delivery } from "./deliveries";
import { defineRequest, noticeInputSchema } from "./request";

export const notice = defineRequest({
    summary: "Ask a person to acknowledge a notice",
    args: noticeInputSchema.pick({ id: true, title: true, reason: true }),
    delivery: Delivery.askElseNotify,
    wait: "settled",
    build: (args) => ({ kind: "notice", ...args }),
});

export const windowNotice = defineRequest({
    summary: "Post a notice whose click opens a GenesisTools window",
    args: noticeInputSchema.omit({ kind: true }).required({ open: true }),
    delivery: Delivery.notifyThenAsk,
    wait: "posted",
    build: (args) => ({ kind: "notice", ...args }),
});
