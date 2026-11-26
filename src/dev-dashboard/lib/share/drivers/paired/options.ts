import { ShareTargetBaseSchema } from "@app/dev-dashboard/lib/share/drivers/target-base";
import { isSecureRef, type SecureRef } from "@genesiscz/utils/security";
import { z } from "zod";

/** A share server this Mac paired with: snapshots go up over HTTPS with a per-device token. */
export const PairedTargetSchema = ShareTargetBaseSchema.extend({
    driver: z.literal("paired"),
    /** The server's share base; its upload API is `<url>/_api/...`. */
    url: z
        .string()
        .url()
        .transform((url) => url.replace(/\/+$/, "")),
    deviceId: z.string().min(1),
    /** The upload token, in the vault; the config holds only this pointer. */
    token: z.custom<SecureRef>(isSecureRef, { message: "token must be a vault reference" }),
});
