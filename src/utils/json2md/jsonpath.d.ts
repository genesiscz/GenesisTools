/**
 * Local typings for `jsonpath`, which ships none.
 *
 * Declared here rather than adding `@types/jsonpath`, so `@genesiscz/utils/json2md` stays
 * inside the dependency set this repo already has. Follows the same pattern as
 * `src/utils/markdown/turndown-plugin-gfm.d.ts`.
 */
declare module "jsonpath" {
    /** A parsed path component: the root `$`, a property name, or an array index. */
    export type PathComponent = string | number;

    export function query(object: unknown, path: string, count?: number): unknown[];
    export function paths(object: unknown, path: string, count?: number): PathComponent[][];
    export function nodes(
        object: unknown,
        path: string,
        count?: number
    ): Array<{ path: PathComponent[]; value: unknown }>;
    export function value(object: unknown, path: string, newValue?: unknown): unknown;
    export function parent(object: unknown, path: string): unknown;
    export function apply(
        object: unknown,
        path: string,
        fn: (value: unknown) => unknown
    ): Array<{ path: PathComponent[]; value: unknown }>;
    export function stringify(path: PathComponent[]): string;
    export function parse(path: string): Array<{ expression: { type: string; value: PathComponent } }>;

    const jsonpath: {
        query: typeof query;
        paths: typeof paths;
        nodes: typeof nodes;
        value: typeof value;
        parent: typeof parent;
        apply: typeof apply;
        stringify: typeof stringify;
        parse: typeof parse;
    };

    export default jsonpath;
}
