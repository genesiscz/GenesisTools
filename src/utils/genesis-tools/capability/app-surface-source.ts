/**
 * Reads what GenesisTools.app answers from its Swift source: the `--rpc` method list. The generator
 * (`scripts/gen-genesis-app-surface.ts`) writes the `AppRpcMethod` union from it, and the app build writes the same
 * list into the install manifest, so a need can compare what the installed build answers with what the code asks.
 */

/** The Swift file that declares `let rpcMethods = [...]`, relative to the app package `src/macos/GenesisTools`. */
export const RPC_METHODS_SWIFT_FILE = "Sources/Host/Notify.swift";

const RPC_METHODS_LINE = /^let rpcMethods\s*=\s*\[([^\]]*)\]/m;

/** The method names of `let rpcMethods = ["a", "b"]`; throws when the declaration is missing or holds no string. */
export function parseSwiftRpcMethods(swiftSource: string): string[] {
    const match = RPC_METHODS_LINE.exec(swiftSource);

    if (!match) {
        throw new Error(`no "let rpcMethods = [...]" declaration in ${RPC_METHODS_SWIFT_FILE}`);
    }

    const methods = [...(match[1] ?? "").matchAll(/"([^"\\]+)"/g)].map((entry) => entry[1] ?? "");

    if (methods.length === 0) {
        throw new Error(`"let rpcMethods" in ${RPC_METHODS_SWIFT_FILE} lists no method`);
    }

    return methods;
}
