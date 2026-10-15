import { resolve } from "node:path";

export const REPO_ROOT = resolve(__dirname, "../../..");
export const RUNTIME_DIR = resolve(__dirname, "../runtime");

/** The kit gallery: one page per component, shown by `tools artifact library` as the built-in `kit-gallery`. */
export const GALLERY_DIR = resolve(__dirname, "../gallery");

/** The kit gallery's mount name in the library: `/a/<GALLERY_MOUNT>/`. */
export const GALLERY_MOUNT = "kit-gallery";
