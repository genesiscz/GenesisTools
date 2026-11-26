import type { PublishTarget, TransportKind } from "../targets";
import { macLiveTransport } from "./mac-live";
import { pairedTransport } from "./paired";
import { sshRsyncTransport } from "./ssh-rsync";
import type { PublishTransport } from "./types";

export const PUBLISH_TRANSPORTS: { readonly [K in TransportKind]: PublishTransport & { readonly kind: K } } = {
    "mac-live": macLiveTransport,
    paired: pairedTransport,
    "ssh-rsync": sshRsyncTransport,
};

export function isTransportKind(value: string): value is TransportKind {
    return Object.hasOwn(PUBLISH_TRANSPORTS, value);
}

export const TRANSPORT_KINDS: TransportKind[] = Object.keys(PUBLISH_TRANSPORTS).filter(isTransportKind);

export function transportFor(target: PublishTarget): PublishTransport {
    return PUBLISH_TRANSPORTS[target.transport.kind];
}
