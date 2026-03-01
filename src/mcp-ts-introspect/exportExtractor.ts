import { type Symbol as MorphSymbol, Node, type SourceFile } from "ts-morph";
import logger from "../logger";
import type { ExportInfo } from "./types";

export async function extractExports(sourceFile: SourceFile): Promise<ExportInfo[]> {
    const exports: ExportInfo[] = [];
    const exportedSymbols = sourceFile.getExportSymbols();

    logger.info(`Extracting exports from ${sourceFile.getFilePath()}, found ${exportedSymbols.length} export symbols`);

    for (const symbol of exportedSymbols) {
        const exportInfo = processSymbol(symbol);
        if (exportInfo) {
            exports.push(exportInfo);
        }
    }

    return exports;
}

function processSymbol(symbol: MorphSymbol): ExportInfo | null {
    const name = symbol.getName();

    // Skip default exports and internal symbols
    if (name === "default" || name.startsWith("_")) {
        return null;
    }

    const declarations = symbol.getDeclarations();
    if (declarations.length === 0) {
        return null;
    }

    const declaration = declarations[0];
    const node = declaration as Node;

    // Get type signature
    const type = symbol.getTypeAtLocation(node);
    const typeSignature = type.getText(node);

    // Get JSDoc description
    const description = getDescription(node);

    // Determine kind
    const kind = getExportKind(node);
    if (!kind) {
        return null;
    }

    return {
        name,
        kind,
        typeSignature,
        description,
    };
}

function getExportKind(node: Node): ExportInfo["kind"] | null {
    if (Node.isTypeAliasDeclaration(node)) {
        return "type";
    } else if (Node.isFunctionDeclaration(node)) {
        return "function";
    } else if (Node.isClassDeclaration(node)) {
        return "class";
    } else if (Node.isVariableDeclaration(node)) {
        return "const";
    } else if (Node.isExportSpecifier(node)) {
        // For re-exports, check the original declaration
        const symbol = node.getSymbol();
        if (symbol) {
            const valueDeclaration = symbol.getValueDeclaration();
            if (valueDeclaration) {
                return getExportKind(valueDeclaration);
            }
        }
    }

    // Default to const for other types
    return "const";
}

function getDescription(node: Node): string | null {
    // Try to get JSDoc comments
    if (!("getJsDocs" in node)) {
        return null;
    }

    const jsDocs = (node as unknown as { getJsDocs(): Array<{ getDescription(): string }> }).getJsDocs();

    for (const jsDoc of jsDocs) {
        const description = jsDoc.getDescription();
        if (description) {
            return description.trim();
        }
    }

    // Check parent node for JSDoc (useful for variable declarations)
    const parent = node.getParent();
    if (parent && "getJsDocs" in parent) {
        const parentJsDocs = (parent as unknown as { getJsDocs(): Array<{ getDescription(): string }> }).getJsDocs();
        for (const jsDoc of parentJsDocs) {
            const description = jsDoc.getDescription();
            if (description) {
                return description.trim();
            }
        }
    }

    return null;
}
