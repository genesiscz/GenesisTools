import type { YoutubeConfigShape } from "@app/youtube/lib/config.types";

export type DeepPartial<T> = T extends readonly (infer Item)[]
    ? Item[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export interface YoutubeConfigInit {
    baseDir?: string;
}

export type YoutubeConfigPatch = DeepPartial<YoutubeConfigShape>;
