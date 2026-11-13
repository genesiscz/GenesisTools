import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { z } from "zod";
import { FINDING_KINDS } from "./findings";

export const rejectFilterSchema = z
    .object({
        kind: z.enum(FINDING_KINDS).optional(),
        where: z.string().trim().min(1).optional(),
    })
    .strict();
export type RejectFilter = z.infer<typeof rejectFilterSchema>;

/** A small comparison grammar, never JavaScript evaluation. Missing confidence never matches a number. */
export function rejectFilterIds(items: readonly MeetingItem[], raw: RejectFilter): string[] {
    const filter = rejectFilterSchema.parse(raw);

    if (!filter.kind && !filter.where) {
        throw new Error("reject by filter needs --kind or --where");
    }

    const match = filter.where?.match(
        /^(confidence|priority)\s*(<=|>=|==|!=|<|>)\s*(0(?:\.\d+)?|1(?:\.0+)?|\d+(?:\.\d+)?)$/
    );

    if (filter.where && !match) {
        throw new Error("--where must compare confidence or priority with a number, for example confidence<0.6");
    }

    return items
        .filter((item) => {
            if (item.status !== "suggested" || (filter.kind && item.kind !== filter.kind)) {
                return false;
            }

            if (!match) {
                return true;
            }

            const value =
                match[1] === "confidence" ? item.confidence : item.kind === "question" ? item.priority : undefined;

            if (value === undefined) {
                return false;
            }

            const limit = Number(match[3]);
            switch (match[2]) {
                case "<":
                    return value < limit;
                case "<=":
                    return value <= limit;
                case ">":
                    return value > limit;
                case ">=":
                    return value >= limit;
                case "==":
                    return value === limit;
                case "!=":
                    return value !== limit;
                default:
                    throw new Error("unknown comparison");
            }
        })
        .map((item) => item.id);
}
