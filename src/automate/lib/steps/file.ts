// src/automate/lib/steps/file.ts

import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StepContext } from "@app/automate/lib/registry";
import { registerStepCatalog, registerStepHandler } from "@app/automate/lib/registry";
import type { FileStepParams, PresetStep, StepResult } from "@app/automate/lib/types";
import { glob } from "glob";
import { makeResult } from "./helpers";

async function fileHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
    const start = performance.now();
    const params = step.params as unknown as FileStepParams;
    const subAction = step.action.split(".")[1];

    try {
        switch (subAction) {
            case "read": {
                const filePath = resolve(ctx.interpolate(params.path!));
                if (!existsSync(filePath)) {
                    return makeResult("error", null, start, `File not found: ${filePath}`);
                }
                const content = await Bun.file(filePath).text();
                return makeResult("success", { path: filePath, content, size: content.length }, start);
            }

            case "write": {
                const filePath = resolve(ctx.interpolate(params.path!));
                const content = ctx.interpolate(params.content ?? "");
                const dir = dirname(filePath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                await Bun.write(filePath, content);
                return makeResult("success", { path: filePath, size: content.length }, start);
            }

            case "copy": {
                const source = resolve(ctx.interpolate(params.source!));
                const destination = resolve(ctx.interpolate(params.destination!));
                if (!existsSync(source)) {
                    return makeResult("error", null, start, `Source not found: ${source}`);
                }
                const destDir = dirname(destination);
                if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
                copyFileSync(source, destination);
                return makeResult("success", { source, destination }, start);
            }

            case "move": {
                const source = resolve(ctx.interpolate(params.source!));
                const destination = resolve(ctx.interpolate(params.destination!));
                if (!existsSync(source)) {
                    return makeResult("error", null, start, `Source not found: ${source}`);
                }
                const destDir = dirname(destination);
                if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
                renameSync(source, destination);
                return makeResult("success", { source, destination }, start);
            }

            case "delete": {
                const filePath = resolve(ctx.interpolate(params.path!));
                const existed = existsSync(filePath);
                if (existed) unlinkSync(filePath);
                return makeResult("success", { path: filePath, existed }, start);
            }

            case "glob": {
                const pattern = ctx.interpolate(params.pattern!);
                const cwd = params.cwd ? resolve(ctx.interpolate(params.cwd)) : process.cwd();
                const files = await glob(pattern, { absolute: true, nodir: true, cwd });
                return makeResult("success", { pattern, cwd, files, count: files.length }, start);
            }

            case "template": {
                let templateContent: string;
                if (params.templatePath) {
                    const tplPath = resolve(ctx.interpolate(params.templatePath));
                    if (!existsSync(tplPath)) {
                        return makeResult("error", null, start, `Template not found: ${tplPath}`);
                    }
                    templateContent = await Bun.file(tplPath).text();
                } else {
                    templateContent = params.content ?? "";
                }

                // Apply explicit variables first
                let rendered = templateContent;
                if (params.variables) {
                    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    for (const [key, value] of Object.entries(params.variables)) {
                        const resolvedValue = ctx.interpolate(value);
                        rendered = rendered.replace(
                            new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, "g"),
                            resolvedValue
                        );
                    }
                }
                // Then run through the main expression interpolator
                rendered = ctx.interpolate(rendered);

                // Write to file if path specified, otherwise return rendered content
                if (params.path) {
                    const outPath = resolve(ctx.interpolate(params.path));
                    const dir = dirname(outPath);
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                    await Bun.write(outPath, rendered);
                    return makeResult("success", { path: outPath, content: rendered }, start);
                }

                return makeResult("success", { content: rendered }, start);
            }

            default:
                return makeResult("error", null, start, `Unknown file action: ${subAction}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return makeResult("error", null, start, message);
    }
}

registerStepHandler("file", fileHandler);
registerStepCatalog({
    prefix: "file",
    description: "File system operations",
    actions: [
        {
            action: "file.read",
            description: "Read file contents",
            params: [{ name: "path", required: true, description: "File path" }],
        },
        {
            action: "file.write",
            description: "Write content to file",
            params: [
                { name: "path", required: true, description: "File path" },
                { name: "content", required: true, description: "Content to write" },
            ],
        },
        {
            action: "file.copy",
            description: "Copy a file",
            params: [
                { name: "source", required: true, description: "Source path" },
                { name: "destination", required: true, description: "Destination path" },
            ],
        },
        {
            action: "file.move",
            description: "Move/rename a file",
            params: [
                { name: "source", required: true, description: "Source path" },
                { name: "destination", required: true, description: "Destination path" },
            ],
        },
        {
            action: "file.delete",
            description: "Delete a file",
            params: [{ name: "path", required: true, description: "File path" }],
        },
        {
            action: "file.glob",
            description: "Find files by glob pattern",
            params: [
                { name: "pattern", required: true, description: "Glob pattern" },
                { name: "cwd", description: "Working directory" },
            ],
        },
        {
            action: "file.template",
            description: "Render a template",
            params: [
                { name: "templatePath", description: "Path to template file" },
                { name: "content", description: "Inline template string" },
                { name: "variables", description: "Template variables" },
                { name: "path", description: "Output file path (if omitted, returns content)" },
            ],
        },
    ],
});
