import { z } from "zod";
import { type PairedDevice, PairedDeviceSchema } from "../device-pairing/types";
import { API_SEGMENT, isSnapshotId, KIND_ID_RE } from "./ids";

export const PUBLISH_SERVER_HEADER = "X-Share-Server";
export const PUBLISH_SERVER_ID = "genesis-tools";

export const PUBLISH_API = {
    health: "/_api/health",
    pair: "/_api/pair",
    whoami: "/_api/whoami",
    snapshots: (kind: string) => `/${kind}/${API_SEGMENT}/snapshots`,
    snapshot: (kind: string, id: string) => `${PUBLISH_API.snapshots(kind)}/${encodeURIComponent(id)}`,
} as const;

export const ADMIN_API = {
    pairCode: "/admin/pair-code",
    devices: "/admin/devices",
    device: (id: string) => `/admin/devices/${encodeURIComponent(id)}`,
};

export const HealthSchema: z.ZodType<{ server: "genesis-tools"; api: 1; kinds: string[] }> = z.object({
    server: z.literal(PUBLISH_SERVER_ID),
    api: z.literal(1),
    kinds: z.array(z.string().regex(KIND_ID_RE)),
});

export const WhoamiSchema: z.ZodType<{ deviceId: string; name: string }> = z.object({
    deviceId: z.string(),
    name: z.string(),
});

const snapshotIds = z.array(z.string().refine(isSnapshotId));

export const SnapshotListSchema: z.ZodType<{ ids: string[] }> = z
    .union([z.object({ ids: snapshotIds }), z.object({ slugs: snapshotIds })])
    .transform((list) => ("ids" in list ? list : { ids: list.slugs }));

export const DeviceListSchema: z.ZodType<{ devices: Array<Omit<PairedDevice, "tokenHash">> }> = z.object({
    devices: z.array(PairedDeviceSchema.omit({ tokenHash: true })),
});
