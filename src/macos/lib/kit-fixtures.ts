import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The one copy of the Disk Manager fixtures: GenesisKit's test-only `GenesisKitFixtures` product. The Swift suites
 * load them through `KitFixture`; the bun tests read the same files here and check every `contract-*` file against the
 * real output of the code that prints it, so the CLI and the Swift decoders cannot drift apart unnoticed.
 */
export const KIT_FIXTURES_DIR = join(import.meta.dir, "..", "GenesisKit", "Sources", "GenesisKitFixtures", "Disk");

export function kitFixturePath(name: string): string {
    return join(KIT_FIXTURES_DIR, name);
}

export function readKitFixture(name: string): string {
    return readFileSync(kitFixturePath(name), "utf8");
}

export function readKitFixtureJson(name: string): unknown {
    return SafeJSON.parse(readKitFixture(name), { strict: true });
}

/** The lines of a `contract-*.ndjson` fixture, parsed. */
export function readKitFixtureLines(name: string): unknown[] {
    return readKitFixture(name)
        .trim()
        .split("\n")
        .map((line) => SafeJSON.parse(line, { strict: true }));
}

/** Paths are `$` for the root, `.key` for a member and `[]` for any element of an array: `$.items[].paths`. */
export interface ContractShapeOptions {
    /**
     * Arrays whose elements come in kinds with different keys (`$.items[]` by status and reason, `$.findings[]` by
     * `metadata.kind`): each element is checked against the contract element of the same kind, and a kind the
     * contract has no example of is a mismatch. Every other array's elements are checked against its first element.
     */
    kinds?: Record<string, (element: unknown) => string>;
    /** Objects whose keys are data, not fields (du's `meta`): only checked to be an object. */
    openMaps?: string[];
    /** Keys the code writes only in some states, so one example cannot carry both forms. */
    optionalKeys?: Record<string, string[]>;
}

/**
 * A `kinds` function: the values at these dotted paths, the absent ones left out, joined (`byKeys("status", "reason")`
 * gives `ok` or `refused:blocked`; `byKeys("metadata.kind")`).
 */
export function byKeys(...paths: string[]): (element: unknown) => string {
    const at = (element: unknown, path: string): unknown =>
        path.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), element);
    return (element) =>
        paths
            .map((path) => at(element, path))
            .filter((value) => value !== undefined)
            .map(String)
            .join(":");
}

type ValueKind = "null" | "array" | "object" | "string" | "number" | "boolean";

function kindOf(value: unknown): ValueKind {
    if (value === null || value === undefined) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "array";
    }

    const type = typeof value;

    if (type === "string" || type === "number" || type === "boolean") {
        return type;
    }

    return "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return kindOf(value) === "object";
}

function isStructural(kind: ValueKind): boolean {
    return kind === "array" || kind === "object";
}

function withArticle(kind: ValueKind): string {
    return isStructural(kind) ? `an ${kind}` : `a ${kind}`;
}

/**
 * One comparison. `path` addresses the options (`$.items[]`); `label` names the place in a problem
 * (`$.items[refused]`).
 */
interface Pair<A = unknown, C = unknown> {
    actual: A;
    contract: C;
    path: string;
    label: string;
}

class ShapeWalk {
    readonly problems = new Set<string>();

    constructor(private readonly options: ContractShapeOptions) {}

    value({ actual, contract, path, label }: Pair): void {
        const got = kindOf(actual);
        const want = kindOf(contract);

        if (want === "null") {
            if (isStructural(got)) {
                this.problems.add(
                    `${label}: ${withArticle(got)} where the contract has null, so its keys go unchecked`
                );
            }

            return;
        }

        if (got === "null") {
            if (isStructural(want)) {
                this.problems.add(
                    `${label}: null where the contract has ${withArticle(want)}, so its keys go unchecked`
                );
            }

            return;
        }

        if (got !== want) {
            this.problems.add(`${label}: ${withArticle(got)} where the contract has ${withArticle(want)}`);
            return;
        }

        if (Array.isArray(actual) && Array.isArray(contract)) {
            this.array({ actual, contract, path, label });
        } else if (isRecord(actual) && isRecord(contract)) {
            this.object({ actual, contract, path, label });
        }
    }

    private array({ actual, contract, path, label }: Pair<unknown[], unknown[]>): void {
        if (contract.length === 0) {
            if (actual.some((element) => isStructural(kindOf(element)))) {
                this.problems.add(`${label}: the contract's array is empty, so it cannot show these elements' keys`);
            }

            return;
        }

        if (actual.length === 0) {
            if (isStructural(kindOf(contract[0]))) {
                this.problems.add(`${label}: empty, so the keys of the contract's elements go unchecked`);
            }

            return;
        }

        const elementPath = `${path}[]`;
        const kind = this.options.kinds?.[elementPath];

        for (const [index, element] of actual.entries()) {
            if (!kind) {
                this.value({ actual: element, contract: contract[0], path: elementPath, label: `${label}[]` });
                continue;
            }

            const name = kind(element);
            const example = contract.find((candidate) => kind(candidate) === name);

            if (example === undefined) {
                this.problems.add(`${label}[${index}]: of kind "${name}", which the contract has no example of`);
                continue;
            }

            this.value({ actual: element, contract: example, path: elementPath, label: `${label}[${name}]` });
        }
    }

    private object({ actual, contract, path, label }: Pair<Record<string, unknown>, Record<string, unknown>>): void {
        if (this.options.openMaps?.includes(path)) {
            return;
        }

        const optional = new Set(this.options.optionalKeys?.[path] ?? []);

        for (const key of Object.keys(contract)) {
            if (!(key in actual) && !optional.has(key)) {
                this.problems.add(`${label}: missing "${key}", which the contract has`);
            }
        }

        for (const [key, value] of Object.entries(actual)) {
            if (key in contract) {
                this.value({
                    actual: value,
                    contract: contract[key],
                    path: `${path}.${key}`,
                    label: `${label}.${key}`,
                });
            } else if (!optional.has(key)) {
                this.problems.add(`${label}: has "${key}", which the contract does not`);
            }
        }
    }
}

/** `actual` as the CLI prints it: an undefined key is absent, as in the printed JSON. */
function asPrinted(actual: unknown): unknown {
    return SafeJSON.parse(SafeJSON.stringify(actual), { strict: true });
}

/**
 * Every place `actual` differs in shape from `contract`, one `path: problem` line each; empty when they match. Values
 * may differ, keys and nesting may not: the same key set on every object at every depth, each array element checked
 * against the contract element of its kind, and a value of the contract's type. A null stands for any value of the
 * contract's type, but not for an object or an array, whose keys it would hide.
 */
export function contractShapeMismatches(
    actual: unknown,
    contract: unknown,
    options: ContractShapeOptions = {}
): string[] {
    const walk = new ShapeWalk(options);
    walk.value({ actual: asPrinted(actual), contract, path: "$", label: "$" });
    return [...walk.problems];
}

function eventType(event: unknown): string {
    return isRecord(event) && typeof event.type === "string" ? event.type : "(no type)";
}

/**
 * The same check for an ndjson stream: each event against the contract line of its `type`, the first one of that
 * type. `types` (default: every type the contract shows) must each appear among the events, so a stream that never
 * produced a type cannot pass for it.
 */
export function ndjsonShapeMismatches(
    events: unknown[],
    contractLines: unknown[],
    options: ContractShapeOptions & { types?: string[] } = {}
): string[] {
    const examples = new Map<string, unknown>();

    for (const line of contractLines) {
        if (!examples.has(eventType(line))) {
            examples.set(eventType(line), line);
        }
    }

    const problems: string[] = [];
    const seen = new Set<string>();

    for (const event of events) {
        const type = eventType(event);
        seen.add(type);
        const example = examples.get(type);

        if (example === undefined) {
            problems.push(`[${type}] the contract has no event of this type`);
            continue;
        }

        for (const problem of contractShapeMismatches(event, example, options)) {
            problems.push(`[${type}] ${problem}`);
        }
    }

    for (const type of options.types ?? [...examples.keys()]) {
        if (!seen.has(type)) {
            problems.push(`[${type}] no event of this type was produced`);
        }
    }

    return [...new Set(problems)];
}
