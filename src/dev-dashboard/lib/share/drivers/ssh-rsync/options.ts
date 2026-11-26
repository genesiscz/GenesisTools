import { ShareTargetBaseSchema } from "@app/dev-dashboard/lib/share/drivers/target-base";
import { z } from "zod";

/** `user@host` or `host`: one ssh destination, nothing a shell or ssh would read as an option. */
export const SSH_HOST_RE = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/;
/** An absolute path a remote shell reads as one word. */
export const REMOTE_DIR_RE = /^\/[A-Za-z0-9._/-]+$/;

/** Snapshots go to `<host>:<dataDir>/<slug>/` with rsync over ssh; a share server there serves them. */
export const SshRsyncTargetSchema = ShareTargetBaseSchema.extend({
    driver: z.literal("ssh-rsync"),
    host: z.string().regex(SSH_HOST_RE),
    dataDir: z
        .string()
        .regex(REMOTE_DIR_RE)
        .transform((dir) => dir.replace(/\/+$/, "")),
    publicBase: ShareTargetBaseSchema.shape.publicBase.unwrap(),
});
