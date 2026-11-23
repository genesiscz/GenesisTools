import { ast } from "@genesiscz/utils/ts/ast";
import { type Expression, type Statement, Visitor } from "oxc-parser";
import { type AstPatchMatch, definePatch } from "./define-patch";

// Claude Code 2.1.328, before the patch. This is the bundle's ternary expanded
// into if/else steps, using the identifier names from that build:
//
//   let e = j(), n;
//   if (!o.reviewed)                              n = "no_setup";
//   else if (!P() || !v() || e === "unread")       n = "admin_unread";
//   else if (e === "changed")                     n = "credential_changed";
//   else if (m())                                 n = "admin";
//   else if (S())                                 n = "compliance";
//   else if (T())                                 n = "otel";
//   else if (!A() || x())                         n = "provider";
//   else if (!czn(dt()))                          n = "model";
//   else                                          n = void 0;
//   if (n === void 0) return (o.signedInAs = F()), "none";
//   return g(n, "restart_without_mode");
//
// After the patch, the whole initializer for n becomes "admin_unread":
//
//   let e = j(), n = "admin_unread";
//   if (n === void 0) return (o.signedInAs = F()), "none";
//   return g(n, "restart_without_mode"); // Runs with n = "admin_unread".
//
// The matcher uses the ordered reason strings below across minified builds.
//
// The earlier startup check also changes:
//   if (!P() || !v()) return "admin_unread";
//   if (true) return "admin_unread"; // After the patch.
// This skips evaluating P() and v() at that guard. Earlier startup work,
// including policy loading and the credentials check, still runs.
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

function returnsReason(statement: Statement | undefined, reason: string): boolean {
    return (
        statement?.type === "IfStatement" &&
        statement.consequent.type === "ReturnStatement" &&
        ast.isLiteralValue(statement.consequent.argument, reason)
    );
}

export const restartWithoutModePatch = definePatch({
    id: "codemode-always-on",
    description: "Force the Code Mode admin_unread refusal at startup and after setup",
    // This is the first verified version. Newer versions still need a unique
    // structural match before the engine will apply the edit.
    versions: [">=2.1.328"],
    moduleHint: "restart_without_mode",
    ast(program, source) {
        const matches: AstPatchMatch[] = [];
        const startupGuards: AstPatchMatch[] = [];

        new Visitor({
            BlockStatement({ body }) {
                for (const [index, statement] of body.entries()) {
                    if (
                        statement.type === "IfStatement" &&
                        returnsReason(statement, "admin_unread") &&
                        returnsReason(body[index - 1], "credentials") &&
                        returnsReason(body[index + 1], "admin")
                    ) {
                        const { start, end } = statement.test;
                        const test = source.slice(start, end);
                        const isOriginalOrLegacy = /^![\w$]+\(\)\s*\|\|\s*![\w$]+\(\)(?:\|\|(?:true|false))?$/.test(
                            test
                        );

                        if (test === "true" || isOriginalOrLegacy) {
                            startupGuards.push({
                                start,
                                end,
                                replacement: "true",
                            });
                        }
                    }

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
                    // Accept the original chain, legacy numeric replacements,
                    // and the current explicit refusal reason.
                    const declaration = statement.declarations.at(-1);
                    const initializer = declaration?.init;

                    if (
                        declaration?.id.type === "Identifier" &&
                        declaration.id.name === name &&
                        initializer &&
                        (isRefusalChain(initializer) ||
                            ast.isZero(initializer) ||
                            ast.isLiteralValue(initializer, 1) ||
                            ast.isLiteralValue(initializer, "admin_unread"))
                    ) {
                        matches.push({ start: initializer.start, end: initializer.end, replacement: '"admin_unread"' });
                    }
                }
            },
        }).visit(program);

        const [startup] = startupGuards;
        const [postSetup] = matches;

        if (
            startupGuards.length !== 1 ||
            matches.length !== 1 ||
            !startup ||
            !postSetup ||
            startup.end > postSetup.start
        ) {
            return [];
        }

        // Keep both edits under one patch ID and reuse the padding left by
        // earlier versions so the embedded module stays the same size.
        const padding = /^ */.exec(source.slice(postSetup.end))?.[0].length ?? 0;
        const end = postSetup.end + padding;
        const replacement = startup.replacement + source.slice(startup.end, postSetup.start) + postSetup.replacement;
        return [{ start: startup.start, end, replacement: replacement.padEnd(end - startup.start) }];
    },
});
