/**
 * `fsevents` ships its own types, but it is a macOS-only package. On Linux bun does not install it, so
 * the typecheck job there stopped at TS2307 and the whole tool had to sit outside the typecheck.
 * This declares the two functions the sampler calls; an ambient declaration wins over the package's own
 * types, so macOS and Linux check the same surface.
 */
declare module "fsevents" {
    export type FseventsEvent = "created" | "cloned" | "modified" | "deleted" | "moved" | "root-changed" | "unknown";
    export type FseventsItemType = "file" | "directory" | "symlink";

    export interface FseventsInfo {
        event: FseventsEvent;
        path: string;
        type: FseventsItemType;
        flags: number;
    }

    export function watch(
        path: string,
        handler: (path: string, flags: number, id: string) => void
    ): () => Promise<void>;
    export function getInfo(path: string, flags: number): FseventsInfo;
}
