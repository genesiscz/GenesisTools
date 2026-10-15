import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type GalleryEntry, type GalleryPageModule, galleryEntries } from "../gallery/_entries";
import { GALLERY_DIR, GALLERY_MOUNT } from "./paths";

/** The gallery's page files: every `.tsx` but the index and the `_` helpers, as `./<name>.tsx`. */
export function galleryPageFiles(dir = GALLERY_DIR): string[] {
    return readdirSync(dir)
        .filter((f) => f.endsWith(".tsx") && f !== "index.tsx" && !f.startsWith("_"))
        .sort();
}

function isPageModule(value: unknown): value is GalleryPageModule {
    return typeof value === "object" && value !== null;
}

/**
 * The gallery's pages as the browser index sees them. Imports each page module in this process (React and the kit,
 * no DOM is touched at import time), so `--list` and a page name resolve from the same `meta` the nav shows.
 */
export async function loadGalleryEntries(dir = GALLERY_DIR): Promise<GalleryEntry[]> {
    const modules: Record<string, GalleryPageModule> = {};

    for (const file of galleryPageFiles(dir)) {
        const mod: unknown = await import(join(dir, file));

        if (isPageModule(mod)) {
            modules[`./${file}`] = mod;
        }
    }

    return galleryEntries(modules);
}

/** Library path of the gallery, or of one page in it (`a/kit-gallery/index?page=gantt`). */
export function galleryPath(id?: string): string {
    const index = `a/${GALLERY_MOUNT}/index`;

    return id ? `${index}?page=${encodeURIComponent(id)}` : index;
}
