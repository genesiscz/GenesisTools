import { ast } from "@genesiscz/utils/ts/ast";
import { type Expression, Visitor } from "oxc-parser";
import { type AstPatchMatch, definePatch } from "./define-patch";

// The initializer is a nested ternary. Each true arm produces one of these
// reason strings in this order. The false arms lead to the next check, and
// the final false arm produces `void 0` when no check supplies a reason.
// These strings survive identifier minification, so they help identify the
// post-setup check across builds with different local variable names.
const refusalReasons = [
    "no_setup",
    "admin_unread",
    "credential_changed",
    "admin",
    "compliance",
    "otel",
    "provider",
    "model",
];

function isRefusalChain(initializer: Expression): boolean {
    if (initializer.type !== "ConditionalExpression") {
        return false;
    }

    // The first condition has the shape `!state.reviewed`. The receiver
    // can be renamed. Later conditions are identified by their reason strings.
    const { test } = initializer;

    if (
        test.type !== "UnaryExpression" ||
        test.operator !== "!" ||
        test.argument.type !== "MemberExpression" ||
        test.argument.computed ||
        test.argument.property.type !== "Identifier" ||
        test.argument.property.name !== "reviewed"
    ) {
        return false;
    }

    const tail = ast.conditionalTail(initializer, refusalReasons);
    return tail !== undefined && ast.isUndefined(tail);
}

export const restartWithoutModePatch = definePatch({
    id: "codemode-always-on",
    description: "Force the post-setup restart without Code Mode",
    // This is the first verified version. Newer versions still need a unique
    // structural match before the engine will apply the edit.
    versions: [">=2.1.328"],
    moduleHint: "restart_without_mode",
    ast(program) {
        const matches: AstPatchMatch[] = [];

        new Visitor({
            BlockStatement({ body }) {
                for (const [index, statement] of body.entries()) {
                    // Look for a let declaration immediately followed by a
                    // return guard that compares a local variable to `void 0`.
                    const guard = body[index + 1];
                    if (
                        statement.type !== "VariableDeclaration" ||
                        statement.kind !== "let" ||
                        guard?.type !== "IfStatement" ||
                        guard.alternate ||
                        guard.consequent.type !== "ReturnStatement" ||
                        guard.test.type !== "BinaryExpression" ||
                        (guard.test.operator !== "===" && guard.test.operator !== "!==") ||
                        guard.test.left.type !== "Identifier" ||
                        !ast.isUndefined(guard.test.right)
                    ) {
                        continue;
                    }

                    // Recognize both layouts:
                    // if (reason !== void 0) return restart(reason, "restart_without_mode");
                    // if (reason === void 0) return success();
                    // return restart(reason, "restart_without_mode");
                    const fallback = guard.test.operator === "!==" ? guard.consequent : body[index + 2];

                    if (fallback?.type !== "ReturnStatement" || fallback.argument?.type !== "CallExpression") {
                        continue;
                    }

                    // The guard and the restart call must use the same reason
                    // variable. The mode string identifies the call without
                    // depending on the minified name of the restart function.
                    const name = guard.test.left.name;
                    const [reason, mode] = fallback.argument.arguments;

                    if (
                        fallback.argument.arguments.length !== 2 ||
                        reason?.type !== "Identifier" ||
                        reason.name !== name ||
                        !ast.isLiteralValue(mode, "restart_without_mode")
                    ) {
                        continue;
                    }

                    // The reason is the final binding in the let declaration.
                    // Match its name against the guard and accept the original
                    // ternary, the legacy 0, or the current 1. Status reports
                    // "applied" when the initializer already contains 1.
                    const declaration = statement.declarations.at(-1);
                    const initializer = declaration?.init;

                    if (
                        declaration?.id.type === "Identifier" &&
                        declaration.id.name === name &&
                        initializer &&
                        (isRefusalChain(initializer) || ast.isZero(initializer) || ast.isLiteralValue(initializer, 1))
                    ) {
                        // Replace only the initializer. The engine pads the
                        // shorter edit to preserve the embedded byte length.
                        // Since 1 is defined, the retained guard takes the
                        // restart-without-mode path and passes 1 as the reason.
                        matches.push({ start: initializer.start, end: initializer.end, replacement: "1" });
                    }
                }
            },
        }).visit(program);

        // Return every candidate so the engine can reject ambiguity.
        return matches;
    },
});
