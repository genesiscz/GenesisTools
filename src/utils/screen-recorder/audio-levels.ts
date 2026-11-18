import { z } from "zod";

/** RMS relative to digital full scale over one 100 ms capture interval. Null means no readable samples. */
export const audioLevelBlockSchema = z.object({
    atMs: z.number().finite(),
    mic: z.number().nonnegative().nullable(),
    system: z.number().nonnegative().nullable(),
    input: z.string().nullable(),
    output: z.string().nullable(),
});
export type AudioLevelBlock = z.infer<typeof audioLevelBlockSchema>;
export const audioLevelEvent = audioLevelBlockSchema.extend({ event: z.literal("levels") });
