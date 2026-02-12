/**
 * JSON Schema inference utility.
 *
 * Infers a schema from a JSON value by analyzing its structure.
 * Handles arrays by merging all items into a unified schema.
 *
 * Output modes:
 * - "schema"    → Compact JSON Schema object
 * - "skeleton"  → Flat tree with types: { id: number, items: [{ title: string }] }
 * - "typescript" → TypeScript interfaces with smart naming (Item[] for repeated objects)
 *
 * pretty: false (default) → compact one-line output
 * pretty: true → multi-line indented output
 */

// ─── Types ───────────────────────────────────────────────────────────

interface SchemaNode {
	type: string | string[]; // "string", "number", "object", "array", "boolean", "null", or union
	properties?: Record<string, SchemaNode>;
	required?: string[];
	items?: SchemaNode;
	enum?: unknown[];
}

type OutputMode = "schema" | "skeleton" | "typescript";

interface FormatOptions {
	/** Max depth to recurse (default: 20) */
	maxDepth?: number;
	/** Multi-line indented output (default: false → compact one-line) */
	pretty?: boolean;
}

// ─── Core inference ──────────────────────────────────────────────────

/**
 * Infer a schema node from any JSON value.
 */
function inferNode(value: unknown, depth: number, maxDepth: number): SchemaNode {
	if (depth > maxDepth) return { type: "unknown" };

	if (value === null) return { type: "null" };

	const t = typeof value;

	if (t === "string") return { type: "string" };
	if (t === "number") return { type: Number.isInteger(value as number) ? "integer" : "number" };
	if (t === "boolean") return { type: "boolean" };

	if (Array.isArray(value)) {
		if (value.length === 0) return { type: "array", items: { type: "unknown" } };

		const merged = value.reduce<SchemaNode | null>((acc, item) => {
			const node = inferNode(item, depth + 1, maxDepth);
			return acc ? mergeNodes(acc, node) : node;
		}, null);

		return { type: "array", items: merged ?? { type: "unknown" } };
	}

	if (t === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj);
		const properties: Record<string, SchemaNode> = {};

		for (const key of keys) {
			properties[key] = inferNode(obj[key], depth + 1, maxDepth);
		}

		return { type: "object", properties, required: keys };
	}

	return { type: "unknown" };
}

/**
 * Merge two schema nodes into a union.
 * For objects: merge properties, mark missing ones as optional.
 * For arrays: merge items.
 * For different types: create a type union.
 */
function mergeNodes(a: SchemaNode, b: SchemaNode): SchemaNode {
	const aType = normalizeType(a.type);
	const bType = normalizeType(b.type);

	if (aType === "object" && bType === "object") {
		const aProps = a.properties ?? {};
		const bProps = b.properties ?? {};
		const aRequired = new Set(a.required ?? []);
		const bRequired = new Set(b.required ?? []);
		const allKeys = new Set([...Object.keys(aProps), ...Object.keys(bProps)]);

		const merged: Record<string, SchemaNode> = {};
		const required: string[] = [];

		for (const key of allKeys) {
			const inA = key in aProps;
			const inB = key in bProps;

			if (inA && inB) {
				merged[key] = mergeNodes(aProps[key], bProps[key]);
				if (aRequired.has(key) && bRequired.has(key)) {
					required.push(key);
				}
			} else if (inA) {
				merged[key] = aProps[key];
			} else {
				merged[key] = bProps[key];
			}
		}

		return { type: "object", properties: merged, required };
	}

	if (aType === "array" && bType === "array") {
		const mergedItems = a.items && b.items ? mergeNodes(a.items, b.items) : (a.items ?? b.items ?? { type: "unknown" });
		return { type: "array", items: mergedItems };
	}

	if (aType === bType) return a;

	const types = new Set([
		...(Array.isArray(a.type) ? a.type : [a.type]),
		...(Array.isArray(b.type) ? b.type : [b.type]),
	]);

	return { type: [...types] };
}

function normalizeType(type: string | string[]): string {
	return Array.isArray(type) ? type[0] : type;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Infer a schema from a JSON value.
 * Returns a SchemaNode tree.
 */
export function inferSchema(value: unknown, options?: FormatOptions): SchemaNode {
	return inferNode(value, 0, options?.maxDepth ?? 20);
}

/**
 * Format a schema in the given output mode.
 * Default (pretty: false): compact one-line output.
 * pretty: true: multi-line indented output.
 */
export function formatSchema(value: unknown, mode: OutputMode, options?: FormatOptions): string {
	const schema = inferSchema(value, options);
	const pretty = options?.pretty ?? false;

	switch (mode) {
		case "schema":
			return pretty ? JSON.stringify(schema, null, 2) : JSON.stringify(schema);
		case "skeleton":
			return pretty ? formatSkeletonPretty(schema, 0) : formatSkeletonCompact(schema);
		case "typescript":
			return pretty ? formatTypeScriptPretty(schema) : formatTypeScriptCompact(schema);
		default:
			return pretty ? JSON.stringify(schema, null, 2) : JSON.stringify(schema);
	}
}

// ─── Skeleton: compact (default) ─────────────────────────────────────

function formatSkeletonCompact(node: SchemaNode): string {
	const type = Array.isArray(node.type) ? node.type.join(" | ") : node.type;

	if (type === "object" && node.properties) {
		const required = new Set(node.required ?? []);
		const entries = Object.entries(node.properties);
		if (entries.length === 0) return "{}";

		const parts = entries.map(([key, child]) => {
			const opt = required.has(key) ? "" : "?";
			return `${key}${opt}: ${formatSkeletonCompact(child)}`;
		});

		return `{ ${parts.join(", ")} }`;
	}

	if (type === "array" && node.items) {
		const itemStr = formatSkeletonCompact(node.items);
		return `${itemStr}[]`;
	}

	return type;
}

// ─── Skeleton: pretty ────────────────────────────────────────────────

function formatSkeletonPretty(node: SchemaNode, indent: number): string {
	const pad = "  ".repeat(indent);
	const type = Array.isArray(node.type) ? node.type.join(" | ") : node.type;

	if (type === "object" && node.properties) {
		const required = new Set(node.required ?? []);
		const entries = Object.entries(node.properties);
		if (entries.length === 0) return "{}";

		const lines: string[] = ["{"];
		for (const [key, child] of entries) {
			const opt = required.has(key) ? "" : "?";
			const childStr = formatSkeletonPretty(child, indent + 1);
			lines.push(`${pad}  ${key}${opt}: ${childStr}`);
		}
		lines.push(`${pad}}`);
		return lines.join("\n");
	}

	if (type === "array" && node.items) {
		const itemStr = formatSkeletonPretty(node.items, indent);
		if (itemStr.includes("\n")) {
			return `[${itemStr}]`;
		}
		return `${itemStr}[]`;
	}

	return type;
}

// ─── TypeScript: compact (default) ───────────────────────────────────

function formatTypeScriptCompact(schema: SchemaNode): string {
	const interfaces: CollectedInterface[] = [];
	const nameCounters = new Map<string, number>();

	function uniqueName(base: string): string {
		const count = nameCounters.get(base) ?? 0;
		nameCounters.set(base, count + 1);
		return count === 0 ? base : `${base}${count + 1}`;
	}

	function nodeToType(node: SchemaNode, contextName: string): string {
		const type = Array.isArray(node.type) ? node.type : [node.type];

		if (type.includes("object") && node.properties) {
			const iName = uniqueName(contextName);
			collectInterface(node, iName);
			return iName;
		}

		if (type.includes("array") && node.items) {
			const singularName = singularize(contextName);
			const itemType = nodeToType(node.items, pascalCase(singularName));
			return `${itemType}[]`;
		}

		return type.map(mapPrimitive).join(" | ");
	}

	function collectInterface(node: SchemaNode, name: string): void {
		const required = new Set(node.required ?? []);
		const fields: CollectedInterface["fields"] = [];

		for (const [key, child] of Object.entries(node.properties ?? {})) {
			const childType = nodeToType(child, pascalCase(key));
			fields.push({ key, type: childType, optional: !required.has(key) });
		}

		interfaces.push({ name, fields });
	}

	const rootType = nodeToType(schema, "Root");

	if (interfaces.length === 0) {
		return `type Root = ${rootType};`;
	}

	// 1 interface = 1 line
	return interfaces
		.map((iface) => {
			const fields = iface.fields
				.map((f) => `${f.key}${f.optional ? "?" : ""}: ${f.type}`)
				.join("; ");
			return `interface ${iface.name} { ${fields} }`;
		})
		.join("\n");
}

// ─── TypeScript: pretty ──────────────────────────────────────────────

/**
 * Generate TypeScript interfaces from a schema (multi-line).
 * Smart naming: Root for top-level, singularized parent key for nested objects.
 */
function formatTypeScriptPretty(schema: SchemaNode): string {
	const interfaces: CollectedInterface[] = [];
	const nameCounters = new Map<string, number>();

	function uniqueName(base: string): string {
		const count = nameCounters.get(base) ?? 0;
		nameCounters.set(base, count + 1);
		return count === 0 ? base : `${base}${count + 1}`;
	}

	function nodeToType(node: SchemaNode, contextName: string): string {
		const type = Array.isArray(node.type) ? node.type : [node.type];

		if (type.includes("object") && node.properties) {
			const iName = uniqueName(contextName);
			collectInterface(node, iName);
			return iName;
		}

		if (type.includes("array") && node.items) {
			const singularName = singularize(contextName);
			const itemType = nodeToType(node.items, pascalCase(singularName));
			return `${itemType}[]`;
		}

		return type.map(mapPrimitive).join(" | ");
	}

	function collectInterface(node: SchemaNode, name: string): void {
		const required = new Set(node.required ?? []);
		const fields: CollectedInterface["fields"] = [];

		for (const [key, child] of Object.entries(node.properties ?? {})) {
			const childType = nodeToType(child, pascalCase(key));
			fields.push({ key, type: childType, optional: !required.has(key) });
		}

		interfaces.push({ name, fields });
	}

	const rootType = nodeToType(schema, "Root");

	if (interfaces.length === 0) {
		return `type Root = ${rootType};\n`;
	}

	const lines: string[] = [];
	for (const iface of interfaces) {
		lines.push(`interface ${iface.name} {`);
		for (const f of iface.fields) {
			const opt = f.optional ? "?" : "";
			lines.push(`  ${f.key}${opt}: ${f.type};`);
		}
		lines.push("}");
		lines.push("");
	}

	return lines.join("\n").trimEnd() + "\n";
}

// ─── Shared helpers ──────────────────────────────────────────────────

interface CollectedInterface {
	name: string;
	fields: Array<{ key: string; type: string; optional: boolean }>;
}

function mapPrimitive(type: string): string {
	switch (type) {
		case "integer":
			return "number";
		case "null":
			return "null";
		case "unknown":
			return "unknown";
		default:
			return type;
	}
}

function pascalCase(str: string): string {
	return str
		.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase())
		.replace(/^\w/, (c) => c.toUpperCase());
}

function singularize(str: string): string {
	if (str.endsWith("ies")) return `${str.slice(0, -3)}y`;
	if (str.endsWith("ses") || str.endsWith("xes") || str.endsWith("zes")) return str.slice(0, -2);
	if (str.endsWith("s") && !str.endsWith("ss")) return str.slice(0, -1);
	return str;
}
