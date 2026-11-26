import { MacLiveTargetSchema } from "@app/dev-dashboard/lib/share/drivers/mac-live/options";
import { PairedTargetSchema } from "@app/dev-dashboard/lib/share/drivers/paired/options";
import { SshRsyncTargetSchema } from "@app/dev-dashboard/lib/share/drivers/ssh-rsync/options";
import { z } from "zod";

/** One line per driver: its target options. A new driver adds its folder, a line here and a line in `drivers/index.ts`. */
export const ShareTargetSchema = z.discriminatedUnion("driver", [
    MacLiveTargetSchema,
    PairedTargetSchema,
    SshRsyncTargetSchema,
]);

export type ShareTarget = z.infer<typeof ShareTargetSchema>;
export type ShareDriverKind = ShareTarget["driver"];
export type ShareTargetOf<K extends ShareDriverKind> = Extract<ShareTarget, { driver: K }>;

export const DEFAULT_SHARE_TARGET_NAME = "mac";

/** Where shares go: named targets, and the one used when no `--target` is given. */
export const ShareConfigSchema = z
    .object({
        defaults: z.object({ target: z.string().default(DEFAULT_SHARE_TARGET_NAME) }).prefault({}),
        targets: z.array(ShareTargetSchema).default([{ name: DEFAULT_SHARE_TARGET_NAME, driver: "mac-live" }]),
    })
    .superRefine((config, ctx) => {
        const names = config.targets.map((target) => target.name);
        const duplicate = names.find((name, index) => names.indexOf(name) !== index);

        if (duplicate) {
            ctx.addIssue({ code: "custom", path: ["targets"], message: `two share targets are named "${duplicate}"` });
        }
    });

export type ShareConfig = z.infer<typeof ShareConfigSchema>;

const LegacyShareConfigSchema = z.object({
    target: z.enum(["server", "mac"]),
    server: z
        .object({ host: z.string().optional(), dataDir: z.string().optional(), publicBase: z.string().optional() })
        .optional(),
});

/**
 * The loader's migration: the first design kept one `share.target` ("server" | "mac") and one `share.server`
 * block. It becomes the "mac" target plus, when the server block was complete, an ssh-rsync target "server".
 * Anything else passes through unchanged for the schema to judge.
 */
export function migrateShareConfig(raw: unknown): unknown {
    if (raw === undefined || raw === null) {
        return {};
    }

    const legacy = LegacyShareConfigSchema.safeParse(raw);

    if (!legacy.success || (typeof raw === "object" && "targets" in raw)) {
        return raw;
    }

    const { host, dataDir, publicBase } = legacy.data.server ?? {};
    const server =
        host && dataDir && publicBase ? [{ name: "server", driver: "ssh-rsync", host, dataDir, publicBase }] : [];

    return {
        defaults: {
            target: legacy.data.target === "server" && server.length > 0 ? "server" : DEFAULT_SHARE_TARGET_NAME,
        },
        targets: [{ name: DEFAULT_SHARE_TARGET_NAME, driver: "mac-live" }, ...server],
    };
}
