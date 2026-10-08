import { z } from "zod";

const sweepConfigurationSchema = z
    .object({
        axes: z
            .array(
                z
                    .object({
                        quantityId: z.string().min(1).max(64),
                        values: z.array(z.number().finite()).min(1).max(10000),
                    })
                    .strict()
            )
            .min(1)
            .max(8),
        outputs: z.array(z.string().min(1).max(64)).min(1).max(32),
        scenarioId: z.string().min(1).max(64).optional(),
    })
    .strict();

export function readSweepConfiguration(input: unknown) {
    const configuration = sweepConfigurationSchema.parse(input);
    const total = configuration.axes.reduce((count, axis) => count * axis.values.length, 1);

    if (total > 10000) {
        throw new Error("A sweep may contain at most 10000 runs.");
    }

    return { ...configuration, total };
}
