import { ShareTargetBaseSchema } from "@app/dev-dashboard/lib/share/drivers/target-base";
import { z } from "zod";

/** The Mac's own dashboard serves the page live from the vault (`/share/<slug>` behind its public host). */
export const MacLiveTargetSchema = ShareTargetBaseSchema.extend({ driver: z.literal("mac-live") });
