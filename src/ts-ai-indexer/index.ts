import minimist from "minimist";
import Enquirer from "enquirer";
import { resolve, join, relative } from "node:path";
import { existsSync, writeFileSync, statSync } from "node:fs";
import logger from "../logger";
import clipboardy from "clipboardy";
import {
    Project,
    SourceFile,
    ClassDeclaration,
    InterfaceDeclaration,
    FunctionDeclaration,
    EnumDeclaration,
    TypeAliasDeclaration,
    MethodDeclaration,
    PropertyDeclaration,
    ParameterDeclaration,
    Node,
    SyntaxKind,
} from "ts-morph";

interface Options {
    path?: string;
    output?: string;
    includePrivate?: boolean;
    includeProtected?: boolean;
    excludePattern?: string;
    includeNodeModules?: boolean;
    verbose?: boolean;
    help?: boolean;
    clipboard?: boolean;
    format?: "compact" | "detailed";
}

interface Args extends Options {
    _: string[];
}

interface FileInfo {
    path: string;
    imports: ImportInfo[];
    exports: ExportInfo[];
    classes: ClassInfo[];
    interfaces: InterfaceInfo[];
    functions: FunctionInfo[];
    enums: EnumInfo[];
    types: TypeInfo[];
    constants: ConstantInfo[];
}

interface ImportInfo {
    moduleSpecifier: string;
    namedImports?: string[];
    defaultImport?: string;
    namespaceImport?: string;
}

interface ExportInfo {
    name: string;
    isDefault: boolean;
    isTypeOnly: boolean;
}

interface ClassInfo {
    name: string;
    extends?: string;
    implements: string[];
    isAbstract: boolean;
    isExported: boolean;
    jsDoc?: string;
    typeParameters?: string[];
    decorators: string[];
    properties: PropertyInfo[];
    methods: MethodInfo[];
    accessors: AccessorInfo[];
}

interface InterfaceInfo {
    name: string;
    extends: string[];
    isExported: boolean;
    jsDoc?: string;
    typeParameters?: string[];
    properties: PropertyInfo[];
    methods: MethodSignature[];
}

interface PropertyInfo {
    name: string;
    type: string;
    visibility?: "public" | "protected" | "private";
    isStatic: boolean;
    isReadonly: boolean;
    isOptional: boolean;
    jsDoc?: string;
    decorators: string[];
    initializer?: string;
}

interface MethodInfo {
    name: string;
    visibility?: "public" | "protected" | "private";
    isStatic: boolean;
    isAbstract: boolean;
    isAsync: boolean;
    isGenerator: boolean;
    parameters: ParameterInfo[];
    returnType: string;
    jsDoc?: string;
    decorators: string[];
    typeParameters?: string[];
}

interface MethodSignature {
    name: string;
    parameters: ParameterInfo[];
    returnType: string;
    jsDoc?: string;
    typeParameters?: string[];
    isOptional: boolean;
}

interface AccessorInfo {
    name: string;
    type: string;
    visibility?: "public" | "protected" | "private";
    isStatic: boolean;
    hasGetter: boolean;
    hasSetter: boolean;
    jsDoc?: string;
}

interface ParameterInfo {
    name: string;
    type: string;
    isOptional: boolean;
    isRest: boolean;
    defaultValue?: string;
    decorators: string[];
}

interface FunctionInfo {
    name: string;
    isExported: boolean;
    isAsync: boolean;
    isGenerator: boolean;
    parameters: ParameterInfo[];
    returnType: string;
    jsDoc?: string;
    typeParameters?: string[];
}

interface EnumInfo {
    name: string;
    isExported: boolean;
    isConst: boolean;
    jsDoc?: string;
    members: Array<{ name: string; value?: string }>;
}

interface TypeInfo {
    name: string;
    isExported: boolean;
    typeParameters?: string[];
    type: string;
    jsDoc?: string;
}

interface ConstantInfo {
    name: string;
    type: string;
    value?: string;
    isExported: boolean;
    jsDoc?: string;
}

const prompter = new Enquirer();

function showHelp() {
    logger.info(`
Usage: tools ts-ai-context [options] <path>

Generate AI-friendly markdown documentation from TypeScript codebase.

Options:
  -o, --output FILE          Output markdown file (default: ts-ai-context.md)
  --include-private          Include private methods and properties
  --include-protected        Include protected methods and properties (default: true)
  --include-node-modules     Include files from node_modules (default: false)
  -e, --exclude PATTERN      Glob pattern to exclude files (e.g., "**/tests/**")
  -c, --clipboard            Copy output to clipboard instead of file
  -f, --format FORMAT        Output format: compact (default) or detailed
  -v, --verbose              Enable verbose logging
  -h, --help                 Show this help message

Examples:
  tools ts-ai-context src/
  tools ts-ai-context . --exclude "**/node_modules/**,**/tests/**"
  tools ts-ai-context src/ --output api-docs.md --include-private
  tools ts-ai-context lib/ --clipboard --format compact
`);
}

function getJsDoc(node: Node): string | undefined {
    if (!('getJsDocs' in node)) return undefined;
    
    const jsDocs = (node as any).getJsDocs();
    if (jsDocs.length === 0) return undefined;

    return jsDocs.map((jsDoc: any) => jsDoc.getCommentText()).join("\n");
}

function compactJsDoc(jsDoc: string | undefined): string {
    if (!jsDoc) return "";

    // Remove excessive whitespace and newlines
    const cleaned = jsDoc
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" ");

    // Truncate if too long
    if (cleaned.length > 150) {
        return `// ${cleaned.substring(0, 147)}...`;
    }

    return `// ${cleaned}`;
}

function getVisibility(node: Node): "public" | "protected" | "private" | undefined {
    if (!('hasModifier' in node)) return undefined;
    
    const modifierNode = node as any;
    if (modifierNode.hasModifier(SyntaxKind.PublicKeyword)) return "public";
    if (modifierNode.hasModifier(SyntaxKind.ProtectedKeyword)) return "protected";
    if (modifierNode.hasModifier(SyntaxKind.PrivateKeyword)) return "private";
    return undefined;
}

function getDecorators(node: Node): string[] {
    if (!Node.isDecoratable(node)) return [];

    const decoratableNode = node as any;
    return decoratableNode.getDecorators().map((decorator: any) => {
        const name = decorator.getName();
        const args = decorator.getArguments().map((arg: any) => arg.getText());
        return args.length > 0 ? `@${name}(${args.join(", ")})` : `@${name}`;
    });
}

function getTypeParameters(node: Node): string[] | undefined {
    if (!Node.isTypeParametered(node)) return undefined;

    const typeParams = (node as any).getTypeParameters();
    if (typeParams.length === 0) return undefined;

    return typeParams.map((tp: any) => {
        const constraint = tp.getConstraint();
        const defaultType = tp.getDefault();

        let result = tp.getName();
        if (constraint) result += ` extends ${constraint.getText()}`;
        if (defaultType) result += ` = ${defaultType.getText()}`;

        return result;
    });
}

function simplifyType(type: string): string {
    // Remove excessive whitespace
    type = type.replace(/\s+/g, " ").trim();

    // Shorten common verbose types
    type = type.replace(/import\([^)]+\)\./g, "");

    // Truncate very long types
    if (type.length > 100) {
        return type.substring(0, 97) + "...";
    }

    return type;
}

function extractParameterInfo(param: ParameterDeclaration): ParameterInfo {
    return {
        name: param.getName(),
        type: simplifyType(param.getType().getText(param)),
        isOptional: param.isOptional(),
        isRest: param.isRestParameter(),
        defaultValue: param.getInitializer()?.getText(),
        decorators: getDecorators(param),
    };
}

function extractPropertyInfo(prop: PropertyDeclaration): PropertyInfo {
    return {
        name: prop.getName(),
        type: simplifyType(prop.getType().getText(prop)),
        visibility: getVisibility(prop),
        isStatic: prop.isStatic(),
        isReadonly: prop.isReadonly(),
        isOptional: prop.hasQuestionToken(),
        jsDoc: getJsDoc(prop),
        decorators: getDecorators(prop),
        initializer: prop.getInitializer()?.getText(),
    };
}

function extractMethodInfo(method: MethodDeclaration): MethodInfo {
    return {
        name: method.getName(),
        visibility: getVisibility(method),
        isStatic: method.isStatic(),
        isAbstract: method.isAbstract(),
        isAsync: method.isAsync(),
        isGenerator: method.isGenerator(),
        parameters: method.getParameters().map(extractParameterInfo),
        returnType: simplifyType(method.getReturnType().getText(method)),
        jsDoc: getJsDoc(method),
        decorators: getDecorators(method),
        typeParameters: getTypeParameters(method),
    };
}

function extractAccessorInfo(cls: ClassDeclaration): AccessorInfo[] {
    const accessors = new Map<string, AccessorInfo>();

    // Process getters
    cls.getGetAccessors().forEach((getter) => {
        const name = getter.getName();
        const existing = accessors.get(name) || {
            name,
            type: simplifyType(getter.getReturnType().getText(getter)),
            visibility: getVisibility(getter),
            isStatic: getter.isStatic(),
            hasGetter: true,
            hasSetter: false,
            jsDoc: getJsDoc(getter),
        };
        existing.hasGetter = true;
        accessors.set(name, existing);
    });

    // Process setters
    cls.getSetAccessors().forEach((setter) => {
        const name = setter.getName();
        const param = setter.getParameters()[0];
        const existing = accessors.get(name) || {
            name,
            type: param ? simplifyType(param.getType().getText(param)) : "any",
            visibility: getVisibility(setter),
            isStatic: setter.isStatic(),
            hasGetter: false,
            hasSetter: true,
            jsDoc: getJsDoc(setter),
        };
        existing.hasSetter = true;
        accessors.set(name, existing);
    });

    return Array.from(accessors.values());
}

function extractClassInfo(cls: ClassDeclaration): ClassInfo | null {
    const name = cls.getName();
    if (!name) return null;

    return {
        name,
        extends: cls.getExtends()?.getText(),
        implements: cls.getImplements().map((i) => i.getText()),
        isAbstract: cls.isAbstract(),
        isExported: cls.isExported(),
        jsDoc: getJsDoc(cls),
        typeParameters: getTypeParameters(cls),
        decorators: getDecorators(cls),
        properties: cls.getProperties().map(extractPropertyInfo),
        methods: cls.getMethods().map(extractMethodInfo),
        accessors: extractAccessorInfo(cls),
    };
}

function extractInterfaceInfo(iface: InterfaceDeclaration): InterfaceInfo {
    return {
        name: iface.getName(),
        extends: iface.getExtends().map((e) => e.getText()),
        isExported: iface.isExported(),
        jsDoc: getJsDoc(iface),
        typeParameters: getTypeParameters(iface),
        properties: iface.getProperties().map((prop) => ({
            name: prop.getName(),
            type: simplifyType(prop.getType().getText(prop)),
            visibility: undefined,
            isStatic: false,
            isReadonly: prop.isReadonly(),
            isOptional: prop.hasQuestionToken(),
            jsDoc: getJsDoc(prop),
            decorators: [],
            initializer: undefined,
        })),
        methods: iface.getMethods().map((method) => ({
            name: method.getName(),
            parameters: method.getParameters().map(extractParameterInfo),
            returnType: simplifyType(method.getReturnType().getText(method)),
            jsDoc: getJsDoc(method),
            typeParameters: getTypeParameters(method),
            isOptional: method.hasQuestionToken(),
        })),
    };
}

function extractFunctionInfo(func: FunctionDeclaration): FunctionInfo | null {
    const name = func.getName();
    if (!name) return null;

    return {
        name,
        isExported: func.isExported(),
        isAsync: func.isAsync(),
        isGenerator: func.isGenerator(),
        parameters: func.getParameters().map(extractParameterInfo),
        returnType: simplifyType(func.getReturnType().getText(func)),
        jsDoc: getJsDoc(func),
        typeParameters: getTypeParameters(func),
    };
}

function extractEnumInfo(enumDecl: EnumDeclaration): EnumInfo {
    return {
        name: enumDecl.getName(),
        isExported: enumDecl.isExported(),
        isConst: enumDecl.isConstEnum(),
        jsDoc: getJsDoc(enumDecl),
        members: enumDecl.getMembers().map((member) => ({
            name: member.getName(),
            value: member.getValue()?.toString(),
        })),
    };
}

function extractTypeInfo(typeAlias: TypeAliasDeclaration): TypeInfo {
    return {
        name: typeAlias.getName(),
        isExported: typeAlias.isExported(),
        typeParameters: getTypeParameters(typeAlias),
        type: simplifyType(typeAlias.getType().getText(typeAlias)),
        jsDoc: getJsDoc(typeAlias),
    };
}

function analyzeSourceFile(sourceFile: SourceFile): FileInfo {
    const info: FileInfo = {
        path: sourceFile.getFilePath(),
        imports: [],
        exports: [],
        classes: [],
        interfaces: [],
        functions: [],
        enums: [],
        types: [],
        constants: [],
    };

    // Extract imports (simplified)
    sourceFile.getImportDeclarations().forEach((importDecl) => {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        const defaultImport = importDecl.getDefaultImport()?.getText();
        const namespaceImport = importDecl.getNamespaceImport()?.getText();
        const namedImports = importDecl.getNamedImports().map((ni) => ni.getName());

        info.imports.push({
            moduleSpecifier,
            defaultImport,
            namespaceImport,
            namedImports: namedImports.length > 0 ? namedImports : undefined,
        });
    });

    // Extract classes
    sourceFile.getClasses().forEach((cls) => {
        const classInfo = extractClassInfo(cls);
        if (classInfo) info.classes.push(classInfo);
    });

    // Extract interfaces
    sourceFile.getInterfaces().forEach((iface) => {
        info.interfaces.push(extractInterfaceInfo(iface));
    });

    // Extract functions
    sourceFile.getFunctions().forEach((func) => {
        const funcInfo = extractFunctionInfo(func);
        if (funcInfo) info.functions.push(funcInfo);
    });

    // Extract enums
    sourceFile.getEnums().forEach((enumDecl) => {
        info.enums.push(extractEnumInfo(enumDecl));
    });

    // Extract type aliases
    sourceFile.getTypeAliases().forEach((typeAlias) => {
        info.types.push(extractTypeInfo(typeAlias));
    });

    // Extract variable statements (constants)
    sourceFile.getVariableStatements().forEach((varStmt) => {
        varStmt.getDeclarations().forEach((varDecl) => {
            const name = varDecl.getName();
            if (typeof name === "string") {
                info.constants.push({
                    name,
                    type: simplifyType(varDecl.getType().getText(varDecl)),
                    value: varDecl.getInitializer()?.getText(),
                    isExported: varStmt.isExported(),
                    jsDoc: getJsDoc(varStmt),
                });
            }
        });
    });

    return info;
}

function generateCompactMarkdown(fileInfos: FileInfo[], options: Options): string {
    const lines: string[] = [];

    lines.push("# TypeScript Codebase Structure");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");

    // Group by directory
    const byDirectory = new Map<string, FileInfo[]>();
    for (const file of fileInfos) {
        const dir = file.path.substring(0, file.path.lastIndexOf("/")) || "/";
        if (!byDirectory.has(dir)) {
            byDirectory.set(dir, []);
        }
        byDirectory.get(dir)!.push(file);
    }

    // Generate content
    const dirEntries = Array.from(byDirectory.entries());
    for (const [dir, files] of dirEntries) {
        const relativeDir = relative(process.cwd(), dir) || ".";
        lines.push(`## ${relativeDir}`);

        for (const file of files) {
            const filename = file.path.substring(file.path.lastIndexOf("/") + 1);

            // Skip files with no exportable content
            const hasExportedContent =
                file.classes.some((c) => c.isExported) ||
                file.interfaces.some((i) => i.isExported) ||
                file.functions.some((f) => f.isExported) ||
                file.enums.some((e) => e.isExported) ||
                file.types.some((t) => t.isExported) ||
                file.constants.some((c) => c.isExported);

            if (!hasExportedContent && !options.includePrivate) continue;

            lines.push(`### 📄 ${filename}`);

            // Classes
            for (const cls of file.classes) {
                if (!cls.isExported && !options.includePrivate) continue;

                const decorators = cls.decorators.length > 0 ? cls.decorators.join(" ") + " " : "";
                const parts: string[] = [];
                if (cls.isExported) parts.push("export");
                if (cls.isAbstract) parts.push("abstract");
                parts.push("class");
                parts.push(cls.name);

                if (cls.typeParameters && cls.typeParameters.length > 0) {
                    parts.push(`<${cls.typeParameters.join(", ")}>`);
                }

                let signature = decorators + parts.join(" ");
                if (cls.extends) signature += ` extends ${cls.extends}`;
                if (cls.implements.length > 0) signature += ` implements ${cls.implements.join(", ")}`;

                lines.push(`#### ${signature}`);

                const jsDoc = compactJsDoc(cls.jsDoc);
                if (jsDoc) lines.push(jsDoc);

                // Properties
                const properties = cls.properties.filter((p) => {
                    if (p.visibility === "private" && !options.includePrivate) return false;
                    if (p.visibility === "protected" && !options.includeProtected) return false;
                    return true;
                });

                if (properties.length > 0) {
                    lines.push("Properties:");
                    for (const prop of properties) {
                        const propDecorators = prop.decorators.length > 0 ? prop.decorators.join(" ") + " " : "";
                        const propParts: string[] = [];
                        if (prop.visibility) propParts.push(prop.visibility);
                        if (prop.isStatic) propParts.push("static");
                        if (prop.isReadonly) propParts.push("readonly");
                        propParts.push(prop.name);
                        if (prop.isOptional) propParts.push("?");

                        const propDoc = compactJsDoc(prop.jsDoc);
                        lines.push(
                            `- ${propDecorators}${propParts.join(" ")}: ${prop.type}${
                                prop.initializer ? ` = ${prop.initializer}` : ""
                            }${propDoc ? ` ${propDoc}` : ""}`
                        );
                    }
                }

                // Accessors
                const accessors = cls.accessors.filter((a) => {
                    if (a.visibility === "private" && !options.includePrivate) return false;
                    if (a.visibility === "protected" && !options.includeProtected) return false;
                    return true;
                });

                if (accessors.length > 0) {
                    lines.push("Accessors:");
                    for (const accessor of accessors) {
                        const accParts: string[] = [];
                        if (accessor.visibility) accParts.push(accessor.visibility);
                        if (accessor.isStatic) accParts.push("static");

                        const accessType = [];
                        if (accessor.hasGetter) accessType.push("get");
                        if (accessor.hasSetter) accessType.push("set");

                        lines.push(
                            `- ${accParts.join(" ")} ${accessType.join("/")} ${accessor.name}: ${accessor.type}`
                        );
                    }
                }

                // Methods
                const methods = cls.methods.filter((m) => {
                    if (m.visibility === "private" && !options.includePrivate) return false;
                    if (m.visibility === "protected" && !options.includeProtected) return false;
                    return true;
                });

                if (methods.length > 0) {
                    lines.push("Methods:");
                    for (const method of methods) {
                        const methodDecorators = method.decorators.length > 0 ? method.decorators.join(" ") + " " : "";
                        const methodParts: string[] = [];
                        if (method.visibility) methodParts.push(method.visibility);
                        if (method.isStatic) methodParts.push("static");
                        if (method.isAbstract) methodParts.push("abstract");
                        if (method.isAsync) methodParts.push("async");

                        const params = method.parameters
                            .map((p) => {
                                let param = "";
                                if (p.isRest) param += "...";
                                param += p.name;
                                if (p.isOptional) param += "?";
                                param += `: ${p.type}`;
                                if (p.defaultValue) param += ` = ${p.defaultValue}`;
                                return param;
                            })
                            .join(", ");

                        const typeParams =
                            method.typeParameters && method.typeParameters.length > 0
                                ? `<${method.typeParameters.join(", ")}>`
                                : "";

                        const methodDoc = compactJsDoc(method.jsDoc);
                        lines.push(
                            `- ${methodDecorators}${methodParts.join(" ")} ${method.name}${typeParams}(${params}): ${
                                method.returnType
                            }${methodDoc ? ` ${methodDoc}` : ""}`
                        );
                    }
                }
                lines.push("");
            }

            // Interfaces
            for (const iface of file.interfaces) {
                if (!iface.isExported && !options.includePrivate) continue;

                let signature = "";
                if (iface.isExported) signature += "export ";
                signature += `interface ${iface.name}`;

                if (iface.typeParameters && iface.typeParameters.length > 0) {
                    signature += `<${iface.typeParameters.join(", ")}>`;
                }

                if (iface.extends.length > 0) {
                    signature += ` extends ${iface.extends.join(", ")}`;
                }

                lines.push(`#### ${signature}`);

                const jsDoc = compactJsDoc(iface.jsDoc);
                if (jsDoc) lines.push(jsDoc);

                // Properties
                if (iface.properties.length > 0) {
                    lines.push("Properties:");
                    for (const prop of iface.properties) {
                        lines.push(`- ${prop.name}${prop.isOptional ? "?" : ""}: ${prop.type}`);
                    }
                }

                // Methods
                if (iface.methods.length > 0) {
                    lines.push("Methods:");
                    for (const method of iface.methods) {
                        const params = method.parameters
                            .map((p) => {
                                let param = "";
                                if (p.isRest) param += "...";
                                param += p.name;
                                if (p.isOptional) param += "?";
                                param += `: ${p.type}`;
                                if (p.defaultValue) param += ` = ${p.defaultValue}`;
                                return param;
                            })
                            .join(", ");

                        const typeParams =
                            method.typeParameters && method.typeParameters.length > 0
                                ? `<${method.typeParameters.join(", ")}>`
                                : "";

                        lines.push(
                            `- ${method.name}${method.isOptional ? "?" : ""}${typeParams}(${params}): ${
                                method.returnType
                            }`
                        );
                    }
                }
                lines.push("");
            }

            // Functions
            const exportedFunctions = file.functions.filter((f) => f.isExported || options.includePrivate);
            if (exportedFunctions.length > 0) {
                lines.push("#### Functions");
                for (const func of exportedFunctions) {
                    const params = func.parameters
                        .map((p) => {
                            let param = "";
                            if (p.isRest) param += "...";
                            param += p.name;
                            if (p.isOptional) param += "?";
                            param += `: ${p.type}`;
                            if (p.defaultValue) param += ` = ${p.defaultValue}`;
                            return param;
                        })
                        .join(", ");

                    const funcParts: string[] = [];
                    if (func.isExported) funcParts.push("export");
                    if (func.isAsync) funcParts.push("async");
                    funcParts.push("function");

                    const typeParams =
                        func.typeParameters && func.typeParameters.length > 0
                            ? `<${func.typeParameters.join(", ")}>`
                            : "";

                    const jsDoc = compactJsDoc(func.jsDoc);
                    lines.push(
                        `- ${funcParts.join(" ")} ${func.name}${typeParams}(${params}): ${func.returnType}${
                            jsDoc ? ` ${jsDoc}` : ""
                        }`
                    );
                }
                lines.push("");
            }

            // Enums
            const exportedEnums = file.enums.filter((e) => e.isExported || options.includePrivate);
            if (exportedEnums.length > 0) {
                lines.push("#### Enums");
                for (const enumInfo of exportedEnums) {
                    const enumParts: string[] = [];
                    if (enumInfo.isExported) enumParts.push("export");
                    if (enumInfo.isConst) enumParts.push("const");
                    enumParts.push("enum");
                    enumParts.push(enumInfo.name);

                    const members = enumInfo.members.map((m) => `${m.name}${m.value ? `=${m.value}` : ""}`).join(", ");

                    lines.push(`- ${enumParts.join(" ")} { ${members} }`);
                }
                lines.push("");
            }

            // Type aliases
            const exportedTypes = file.types.filter((t) => t.isExported || options.includePrivate);
            if (exportedTypes.length > 0) {
                lines.push("#### Types");
                for (const typeInfo of exportedTypes) {
                    let typeSig = "";
                    if (typeInfo.isExported) typeSig += "export ";
                    typeSig += `type ${typeInfo.name}`;

                    if (typeInfo.typeParameters && typeInfo.typeParameters.length > 0) {
                        typeSig += `<${typeInfo.typeParameters.join(", ")}>`;
                    }

                    lines.push(`- ${typeSig} = ${typeInfo.type}`);
                }
                lines.push("");
            }

            // Constants
            const exportedConstants = file.constants.filter((c) => c.isExported || options.includePrivate);
            if (exportedConstants.length > 0) {
                lines.push("#### Constants");
                for (const constant of exportedConstants) {
                    // For function types, don't include the implementation
                    const isFunctionType = constant.type.includes("=>") || constant.type.startsWith("(");
                    const valueToShow = !isFunctionType && constant.value ? ` = ${constant.value}` : "";
                    
                    lines.push(
                        `- ${constant.isExported ? "export " : ""}const ${constant.name}: ${constant.type}${valueToShow}`
                    );
                }
                lines.push("");
            }
        }
    }

    return lines.join("\n");
}

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            o: "output",
            e: "exclude",
            v: "verbose",
            h: "help",
            c: "clipboard",
            f: "format",
        },
        boolean: ["includePrivate", "includeProtected", "includeNodeModules", "verbose", "help", "clipboard"],
        string: ["output", "exclude", "format"],
        default: {
            output: "ts-ai-context.md",
            includeProtected: true,
            includeNodeModules: false,
            format: "compact",
        },
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    // Get path from arguments or prompt
    let targetPath = argv._[0] || argv.path;

    if (!targetPath) {
        const response = (await prompter.prompt({
            type: "input",
            name: "path",
            message: "Enter the path to analyze:",
            initial: ".",
        })) as { path: string };

        targetPath = response.path;
    }

    targetPath = resolve(targetPath);

    if (!existsSync(targetPath)) {
        logger.error(`Path does not exist: ${targetPath}`);
        process.exit(1);
    }

    const isDirectory = statSync(targetPath).isDirectory();

    logger.info(`🔍 Analyzing TypeScript codebase at: ${targetPath}`);

    // Create ts-morph project
    const project = new Project({
        tsConfigFilePath: existsSync(join(targetPath, "tsconfig.json")) ? join(targetPath, "tsconfig.json") : undefined,
        skipAddingFilesFromTsConfig: true,
    });

    // Add source files
    if (isDirectory) {
        const patterns = ["**/*.ts", "**/*.tsx"];
        const excludePatterns = argv.exclude?.split(",").map((p) => p.trim()) || [];

        if (!argv.includeNodeModules) {
            excludePatterns.push("**/node_modules/**");
        }

        // Add common exclusions
        excludePatterns.push("**/*.d.ts", "**/*.test.ts", "**/*.spec.ts");

        project.addSourceFilesAtPaths(patterns.map((p: string) => join(targetPath, p)));
        
        // Filter out excluded files
        const allSourceFiles = project.getSourceFiles();
        const excludedPaths = excludePatterns.map((p: string) => join(targetPath, p));
        
        for (const sourceFile of allSourceFiles) {
            const filePath = sourceFile.getFilePath();
            for (const excludePattern of excludedPaths) {
                if (filePath.includes(excludePattern.replace(/\*\*/g, '').replace(/\*/g, ''))) {
                    project.removeSourceFile(sourceFile);
                    break;
                }
            }
        }
    } else {
        project.addSourceFileAtPath(targetPath);
    }

    const sourceFiles = project.getSourceFiles();

    if (sourceFiles.length === 0) {
        logger.error("No TypeScript files found!");
        process.exit(1);
    }

    logger.info(`📂 Found ${sourceFiles.length} TypeScript files`);

    // Analyze files
    const fileInfos: FileInfo[] = [];

    for (const sourceFile of sourceFiles) {
        if (argv.verbose) {
            logger.debug(`Analyzing: ${sourceFile.getFilePath()}`);
        }

        try {
            const fileInfo = analyzeSourceFile(sourceFile);
            fileInfos.push(fileInfo);
        } catch (error) {
            logger.error(`Error analyzing ${sourceFile.getFilePath()}: ${error}`);
        }
    }

    logger.info(`✅ Successfully analyzed ${fileInfos.length} files`);

    // Generate markdown
    const markdown = generateCompactMarkdown(fileInfos, argv);

    // Output
    if (argv.clipboard) {
        await clipboardy.write(markdown);
        logger.info("📋 Documentation copied to clipboard!");
    } else {
        const outputPath = resolve(argv.output!);
        writeFileSync(outputPath, markdown);
        logger.info(`📝 Documentation written to: ${outputPath}`);
        logger.info(`📊 Output size: ${(markdown.length / 1024).toFixed(2)} KB`);
    }
}

main().catch((err) => {
    logger.error(`Error: ${err.message}`);
    process.exit(1);
});
