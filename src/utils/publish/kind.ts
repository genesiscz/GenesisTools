import { KIND_ID_RE } from "./ids";

export type SnapshotCheck = { ok: true } | { ok: false; error: string };

export interface PublishedKind {
    /** The URL namespace and the data folder. Pages are /<id>/<snapshot id>. */
    readonly id: string;
    readonly title: string;
    readonly maxUploadBytes: number;
    /** The generic path guard has already passed. */
    isEntryName(name: string): boolean;
    /** manifest.json has already passed SnapshotManifestBaseSchema. */
    checkSnapshot(input: { id: string; files: ReadonlyMap<string, Uint8Array> }): SnapshotCheck;
}

export function definePublishedKind<const K extends PublishedKind>(kind: K): K {
    if (!KIND_ID_RE.test(kind.id)) {
        throw new Error(`Invalid published kind id: ${kind.id}`);
    }

    return kind;
}

export interface KindRequest {
    request: Request;
    url: URL;
    id: string;
    rest: string;
    kindDir: string;
    origin: string;
}

export interface KindServer {
    readonly kind: PublishedKind;
    serve(request: KindRequest): Promise<Response | null>;
}

export function serveKind(kind: PublishedKind, serve: KindServer["serve"]): KindServer {
    return { kind, serve };
}
