import { logger } from "@genesiscz/utils/logger";
import { KIND_ID_RE, originOf } from "../ids";
import { isMountPath, PublishTargetSchema } from "../targets";
import { type PublishTransport, setupValue, targetWith, validateUrl } from "./types";

const { log } = logger.scoped("publish-mac-live");

function parseMounts(value: string): Record<string, string> {
    const mounts: Record<string, string> = {};

    for (const pair of value.split(",")) {
        const [kind, mount, ...extra] = pair.trim().split("=");
        if (
            !kind ||
            !mount ||
            extra.length ||
            !KIND_ID_RE.test(kind) ||
            !isMountPath(mount) ||
            Object.hasOwn(mounts, kind)
        ) {
            throw new Error("Enter mounts as comma-separated kind=/path pairs, e.g. md=/share");
        }

        mounts[kind] = mount;
    }

    return mounts;
}

export const macLiveTransport: PublishTransport & { readonly kind: "mac-live" } = {
    kind: "mac-live",
    summary: "the local dashboard serves the page live while this Mac is on",
    live: true,
    pageUrl: ({ target, kind, id }) => {
        const { publicBase, transport } = targetWith(target, "mac-live");
        const mount = Object.hasOwn(transport.mounts, kind) ? transport.mounts[kind] : undefined;
        return mount ? `${publicBase}${mount}/${encodeURIComponent(id)}` : null;
    },
    send: async ({ target, kind, id }) => {
        log.debug({ target: target.name, kind, id }, "live target serves the source directly");
    },
    remove: async ({ target, kind, id }) => {
        log.debug({ target: target.name, kind, id }, "live target removal is handled at the source");
    },
    list: async () => null,
    check: async (target) => {
        const { mounts } = targetWith(target, "mac-live").transport;
        const paths = Object.entries(mounts).map(([kind, path]) => `${kind}=${path}`);
        return [{ label: "Live mounts", ok: paths.length > 0, detail: paths.join(", ") || "No live kinds configured" }];
    },
    setup: async (input) => {
        const publicBase = originOf(
            await setupValue(input, {
                flag: "public-base",
                message: "Public origin of this Mac's dashboard",
                validate: validateUrl,
            })
        );
        const mounts = parseMounts(
            await setupValue(input, {
                flag: "mounts",
                message: "Live kind mounts",
                initial: "md=/share",
            })
        );

        return PublishTargetSchema.parse({ name: input.name, publicBase, transport: { kind: "mac-live", mounts } });
    },
    forget: async () => {
        log.debug("live targets store nothing outside the config");
    },
};
