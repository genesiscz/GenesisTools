import { SHARE_SLUG_RE } from "@app/dev-dashboard/lib/share/source";
import { z } from "zod";

/** The share server's upload API, below its share base (`https://host/share` + these paths). */
export const SHARE_API = {
    pair: "/_api/pair",
    snapshots: "/_api/snapshots",
    snapshot: (slug: string) => `/_api/snapshots/${encodeURIComponent(slug)}`,
} as const;

export const PairRequestSchema = z.object({
    code: z.string().min(4).max(32),
    deviceName: z.string().trim().min(1).max(80),
});

export const PairResponseSchema = z.object({ deviceId: z.string().min(1), token: z.string().min(32) });

export const SnapshotListSchema = z.object({ slugs: z.array(z.string().regex(SHARE_SLUG_RE)) });

/** The admin API on the server's unix socket (`share-server pair`, `share-server devices`). */
export const ADMIN_API = {
    pairCode: "/admin/pair-code",
    devices: "/admin/devices",
    device: (id: string) => `/admin/devices/${encodeURIComponent(id)}`,
} as const;

export const PairCodeResponseSchema = z.object({ code: z.string(), expiresAt: z.string() });

export const ShareDeviceSchema = z.object({
    id: z.string(),
    name: z.string(),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string(),
    lastUsedAt: z.string().optional(),
});

export type ShareDevice = z.infer<typeof ShareDeviceSchema>;

export const DeviceListSchema = z.object({ devices: z.array(ShareDeviceSchema.omit({ tokenHash: true })) });
