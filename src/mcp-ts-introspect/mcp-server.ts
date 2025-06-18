import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import logger from "../logger";
import { introspectPackage, introspectSource, introspectProject } from "./introspect";
import type { IntrospectOptions } from "./types";

// Zod schemas for parameter validation
const IntrospectPackageSchema = z.object({
    packageName: z.string().describe("The name of the npm package to introspect"),
    searchPaths: z.array(z.string()).optional().describe("Additional paths to search for the package"),
    searchTerm: z.string().optional().describe("Regex pattern to filter exports by name"),
    cache: z.boolean().optional().default(true).describe("Enable caching"),
    cacheDir: z.string().optional().default(".ts-morph-cache").describe("Cache directory"),
    limit: z.number().optional().describe("Maximum number of results to return"),
});

const IntrospectSourceSchema = z.object({
    sourceCode: z.string().describe("TypeScript source code to analyze"),
    searchTerm: z.string().optional().describe("Regex pattern to filter exports by name"),
    limit: z.number().optional().describe("Maximum number of results to return"),
});

const IntrospectProjectSchema = z.object({
    projectPath: z.string().optional().describe("Path to the TypeScript project (defaults to current directory)"),
    searchTerm: z.string().optional().describe("Regex pattern to filter exports by name"),
    cache: z.boolean().optional().default(true).describe("Enable caching"),
    cacheDir: z.string().optional().default(".ts-morph-cache").describe("Cache directory"),
    limit: z.number().optional().describe("Maximum number of results to return"),
});

export async function startMcpServer() {
    const server = new Server(
        {
            name: "mcp-ts-introspect",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // Register tools/call handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === "introspect-package") {
            try {
                const args = IntrospectPackageSchema.parse(request.params.arguments);
                const options: IntrospectOptions = {
                    searchPaths: args.searchPaths,
                    searchTerm: args.searchTerm,
                    cache: args.cache,
                    cacheDir: args.cacheDir,
                    limit: args.limit,
                };
                
                const exports = await introspectPackage(args.packageName, options);
                
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(exports, null, 2),
                        },
                    ],
                };
            } catch (error) {
                if (error instanceof z.ZodError) {
                    throw new Error(`Invalid arguments: ${error.errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
                }
                throw error;
            }
        }
        
        if (request.params.name === "introspect-source") {
            try {
                const args = IntrospectSourceSchema.parse(request.params.arguments);
                const options: IntrospectOptions = {
                    searchTerm: args.searchTerm,
                    limit: args.limit,
                };
                
                const exports = await introspectSource(args.sourceCode, options);
                
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(exports, null, 2),
                        },
                    ],
                };
            } catch (error) {
                if (error instanceof z.ZodError) {
                    throw new Error(`Invalid arguments: ${error.errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
                }
                throw error;
            }
        }
        
        if (request.params.name === "introspect-project") {
            try {
                const args = IntrospectProjectSchema.parse(request.params.arguments);
                const options: IntrospectOptions = {
                    searchTerm: args.searchTerm,
                    cache: args.cache,
                    cacheDir: args.cacheDir,
                    limit: args.limit,
                };
                
                const exports = await introspectProject(args.projectPath, options);
                
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(exports, null, 2),
                        },
                    ],
                };
            } catch (error) {
                if (error instanceof z.ZodError) {
                    throw new Error(`Invalid arguments: ${error.errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
                }
                throw error;
            }
        }
        
        throw new Error(`Unknown tool: ${request.params.name}`);
    });

    // Register tools/list handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "introspect-package",
                    description: "Introspect TypeScript exports from an npm package",
                    inputSchema: {
                        type: "object",
                        properties: {
                            packageName: {
                                type: "string",
                                description: "The name of the npm package to introspect",
                            },
                            searchPaths: {
                                type: "array",
                                items: { type: "string" },
                                description: "Additional paths to search for the package",
                            },
                            searchTerm: {
                                type: "string",
                                description: "Regex pattern to filter exports by name",
                            },
                            cache: {
                                type: "boolean",
                                description: "Enable caching",
                                default: true,
                            },
                            cacheDir: {
                                type: "string",
                                description: "Cache directory",
                                default: ".ts-morph-cache",
                            },
                            limit: {
                                type: "number",
                                description: "Maximum number of results to return",
                            },
                        },
                        required: ["packageName"],
                    },
                },
                {
                    name: "introspect-source",
                    description: "Introspect TypeScript exports from source code",
                    inputSchema: {
                        type: "object",
                        properties: {
                            sourceCode: {
                                type: "string",
                                description: "TypeScript source code to analyze",
                            },
                            searchTerm: {
                                type: "string",
                                description: "Regex pattern to filter exports by name",
                            },
                            limit: {
                                type: "number",
                                description: "Maximum number of results to return",
                            },
                        },
                        required: ["sourceCode"],
                    },
                },
                {
                    name: "introspect-project",
                    description: "Introspect TypeScript exports from a project",
                    inputSchema: {
                        type: "object",
                        properties: {
                            projectPath: {
                                type: "string",
                                description: "Path to the TypeScript project (defaults to current directory)",
                            },
                            searchTerm: {
                                type: "string",
                                description: "Regex pattern to filter exports by name",
                            },
                            cache: {
                                type: "boolean",
                                description: "Enable caching",
                                default: true,
                            },
                            cacheDir: {
                                type: "string",
                                description: "Cache directory",
                                default: ".ts-morph-cache",
                            },
                            limit: {
                                type: "number",
                                description: "Maximum number of results to return",
                            },
                        },
                        required: [],
                    },
                },
            ],
        };
    });

    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    logger.info("MCP TypeScript Introspect Server started");
}