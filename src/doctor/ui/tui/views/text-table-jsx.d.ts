import type { TextTableRenderable } from "@opentui/core";

declare module "@opentui/solid/src/types/elements.js" {
    interface OpenTUIComponents {
        text_table: typeof TextTableRenderable;
    }
}
