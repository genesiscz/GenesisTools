import { z } from "zod";

/** A target's name: what `--target <name>` and `share.defaults.target` say. */
export const SHARE_TARGET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What every target has, whatever its driver. */
export const ShareTargetBaseSchema = z.object({
    name: z.string().regex(SHARE_TARGET_NAME_RE),
    /** The link a person gets is `<publicBase>/<slug>`, e.g. `https://example.com/share`. */
    publicBase: z
        .string()
        .url()
        .transform((url) => url.replace(/\/+$/, ""))
        .optional(),
});
