import type { API, FileInfo } from "jscodeshift";

const SOURCE = "@app/utils/json";
const IMPORT_NAME = "SafeJSON";

const SKIP_PATTERNS = ["src/utils/json.ts", "src/utils/json.test.ts", "src/codemods/", ".d.ts"];

export const parser = "tsx";

export default function transformer(file: FileInfo, api: API) {
    if (SKIP_PATTERNS.some((p) => file.path.includes(p))) {
        return null;
    }

    const j = api.jscodeshift;
    const root = j(file.source);

    // Find JSON.parse(...) and JSON.stringify(...) member expressions
    const jsonParse = root.find(j.MemberExpression, {
        object: { type: "Identifier", name: "JSON" },
        property: { type: "Identifier", name: "parse" },
    });
    const jsonStringify = root.find(j.MemberExpression, {
        object: { type: "Identifier", name: "JSON" },
        property: { type: "Identifier", name: "stringify" },
    });

    if (jsonParse.size() === 0 && jsonStringify.size() === 0) {
        return null;
    }

    // Replace JSON.parse → SafeJSON.parse, JSON.stringify → SafeJSON.stringify
    [...jsonParse.paths(), ...jsonStringify.paths()].forEach((path) => {
        path.node.object = j.identifier(IMPORT_NAME);
    });

    // Check if file already imports from @app/utils/json
    const existingImport = root.find(j.ImportDeclaration, {
        source: { value: SOURCE },
    });

    if (existingImport.size() > 0) {
        const hasSpecifier = existingImport.find(j.ImportSpecifier, { imported: { name: IMPORT_NAME } }).size() > 0;

        if (!hasSpecifier) {
            existingImport.forEach((path) => {
                path.node.specifiers!.push(j.importSpecifier(j.identifier(IMPORT_NAME)));
            });
        }
    } else {
        const allImports = root.find(j.ImportDeclaration);
        const newImport = j.importDeclaration([j.importSpecifier(j.identifier(IMPORT_NAME))], j.literal(SOURCE));

        if (allImports.size() > 0) {
            allImports.at(-1).insertAfter(newImport);
        } else {
            const body = root.find(j.Program).get("body");

            if (body) {
                body.unshift(newImport);
            } else {
                return null;
            }
        }
    }

    return root.toSource();
}
