import { type RGBA, type TextTableOptions, TextTableRenderable } from "@opentui/core";
import type { JSX, Ref } from "solid-js";

declare module "@opentui/solid/src/types/elements.js" {
    interface OpenTUIComponents {
        text_table: typeof TextTableRenderable;
    }
}

declare module "@opentui/solid/jsx-runtime" {
    namespace JSX {
        interface IntrinsicElements {
            span: SpanLikeProps;
            strong: SpanLikeProps;
            b: SpanLikeProps;
            text_table: TextTableElementProps;
        }
    }
}

interface SpanLikeProps {
    fg?: string | RGBA;
    bg?: string | RGBA;
    attributes?: number;
    link?: { url: string };
    ref?: Ref<unknown>;
    children?: JSX.Element | Array<JSX.Element>;
}

type TextTableElementProps = Omit<TextTableOptions, "content"> & {
    content?: TextTableOptions["content"];
    flexGrow?: number;
    ref?: Ref<TextTableRenderable>;
};
