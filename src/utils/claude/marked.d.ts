declare module "marked" {
    export class Renderer {
        parser: {
            parseInline(tokens: unknown[]): string;
            parse(tokens: unknown[]): string;
        };
        code: (token: { text: string; lang?: string }) => string;
        codespan: (token: { text: string }) => string;
        strong: (token: { tokens: unknown[] }) => string;
        em: (token: { tokens: unknown[] }) => string;
        heading: (token: { tokens: unknown[] }) => string;
        link: (token: { href: string }) => string;
        paragraph: (token: { tokens: unknown[] }) => string;
        list: (token: { ordered: boolean; start?: number; items: Array<{ tokens: unknown[] }> }) => string;
        listitem: (token: { tokens: unknown[] }) => string;
        blockquote: (token: { tokens: unknown[] }) => string;
        hr: () => string;
        br: () => string;
        html: (token: { text: string }) => string;
        table: (token: { header: Array<{ tokens: unknown[] }>; rows: Array<Array<{ tokens: unknown[] }>> }) => string;
        checkbox: (token: { checked: boolean }) => string;
        del: (token: { tokens: unknown[] }) => string;
        image: (token: { href: string }) => string;
        text: (token: { text: string; tokens?: unknown[] }) => string;
        space: () => string;
        def: () => string;
    }

    export function marked(src: string, options: { renderer?: Renderer; async: true }): Promise<string>;
    export function marked(src: string, options?: { renderer?: Renderer; async?: false }): string;
}
