import { z } from "zod";

export const Delivery = {
    askNow: "askNow",
    notifyThenAsk: "notifyThenAsk",
    askElseNotify: "askElseNotify",
} as const;

export const deliverySchema = z.enum([Delivery.askNow, Delivery.notifyThenAsk, Delivery.askElseNotify]);
export type DeliveryName = z.infer<typeof deliverySchema>;

export const personConfigSchema = z.object({
    notification: z
        .object({ sound: z.string().default("default"), repeatAfterMinutes: z.number().min(0).default(30) })
        .default({ sound: "default", repeatAfterMinutes: 30 }),
    dialog: z.object({ takesFocus: z.boolean().default(true) }).default({ takesFocus: true }),
});
