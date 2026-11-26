import { publicBaseUrl } from "@app/dev-dashboard/lib/public-base";
import { MacLiveTargetSchema } from "@app/dev-dashboard/lib/share/drivers/mac-live/options";
import {
    pageUrlUnder,
    type ShareDriver,
    setupValue,
    targetOf,
    validateUrl,
} from "@app/dev-dashboard/lib/share/drivers/types";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("share-mac-live");

/**
 * The Mac's own dashboard: `/share/<slug>` is drawn from the vault at each request, for every published note. So
 * nothing is sent anywhere, and the link answers only while the Mac and its tunnel are up.
 */
export const macLiveDriver: ShareDriver = {
    kind: "mac-live",
    summary: "this Mac's dashboard serves the page live from the vault (needs the Mac on)",
    pageUrl: async (target, slug) => {
        const { publicBase } = targetOf(target, "mac-live");

        return pageUrlUnder(publicBase ?? `${await publicBaseUrl()}/share`, slug);
    },
    sync: async (target, note) => {
        log.debug({ target: target.name, slug: note.slug }, "mac-live serves the vault itself; nothing to send");
    },
    remove: async (target, slug) => {
        log.debug({ target: target.name, slug }, "mac-live stops serving a note when it is unpublished");
    },
    listSlugs: async () => null,
    setup: async (input) => {
        const fallback = `${await publicBaseUrl()}/share`;
        const publicBase = await setupValue(input, {
            flag: "public-base",
            message: "Public base of this Mac's share pages",
            initial: fallback,
            validate: validateUrl,
        });

        return MacLiveTargetSchema.parse({ name: input.name, driver: "mac-live", publicBase });
    },
    forget: async () => {
        log.debug("mac-live stores nothing outside the config");
    },
};
