import { z } from "zod";

export interface PairedDevice {
    id: string;
    name: string;
    tokenHash: string;
    createdAt: string;
    lastUsedAt?: string;
}

export const PairRequestSchema = z.object({
    code: z.string().min(4).max(32),
    deviceName: z.string().trim().min(1).max(80),
});

export const PairResponseSchema = z.object({ deviceId: z.string().min(1), token: z.string().min(32) });

export const PairCodeResponseSchema = z.object({ code: z.string(), expiresAt: z.string() });

export const PairedDeviceSchema = z.object({
    id: z.string(),
    name: z.string(),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string(),
    lastUsedAt: z.string().optional(),
}) satisfies z.ZodType<PairedDevice>;
