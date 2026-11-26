import { SHARE_SLUG_RE } from "@app/dev-dashboard/lib/share/source";
import { PairedDeviceSchema } from "@genesiscz/utils/device-pairing/types";
import { z } from "zod";

export {
    PairCodeResponseSchema,
    type PairedDevice as ShareDevice,
    PairedDeviceSchema as ShareDeviceSchema,
    PairRequestSchema,
    PairResponseSchema,
} from "@genesiscz/utils/device-pairing/types";

/** The share server's upload API, below its share base (`https://host/share` + these paths). */
export const SHARE_API = {
    pair: "/_api/pair",
    snapshots: "/_api/snapshots",
    snapshot: (slug: string) => `/_api/snapshots/${encodeURIComponent(slug)}`,
} as const;

export const SnapshotListSchema = z.object({ slugs: z.array(z.string().regex(SHARE_SLUG_RE)) });

/** The admin API on the server's unix socket (`share-server pair`, `share-server devices`). */
export const ADMIN_API = {
    pairCode: "/admin/pair-code",
    devices: "/admin/devices",
    device: (id: string) => `/admin/devices/${encodeURIComponent(id)}`,
} as const;

export const DeviceListSchema = z.object({ devices: z.array(PairedDeviceSchema.omit({ tokenHash: true })) });
