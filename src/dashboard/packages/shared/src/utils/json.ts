type JsonReviver = (this: unknown, key: string, value: unknown) => unknown;
type JsonReplacer = ((this: unknown, key: string, value: unknown) => unknown) | Array<number | string> | null;

const nativeJson = globalThis.JSON;

export const SafeJSON = {
    parse: <T = unknown>(text: string, reviver?: JsonReviver): T => {
        return nativeJson.parse(text, reviver) as T;
    },
    stringify: (value: unknown, replacer?: JsonReplacer, space?: string | number): string => {
        if (typeof replacer === "function") {
            return nativeJson.stringify(value, replacer, space);
        }

        return nativeJson.stringify(value, replacer, space);
    },
};
