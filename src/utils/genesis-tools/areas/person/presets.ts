import { z } from "zod";
import { Delivery } from "./deliveries";
import { defineRequest } from "./request";

export const notice = defineRequest({
    summary: "Ask a person to acknowledge a notice",
    args: z.object({
        id: z.string().regex(/^[a-zA-Z0-9:._-]{1,500}$/),
        title: z.string().min(1).max(200),
        reason: z.string().min(1).max(20_000),
    }),
    delivery: Delivery.askElseNotify,
    wait: "settled",
    build: (args) => ({ kind: "notice", ...args }),
});
