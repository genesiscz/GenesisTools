import {
    type ApiDescriptor,
    effectLabel,
    jsonSchemaOf,
    type MethodDescriptor,
    methodSignature,
} from "@genesiscz/utils/api-descriptor";
import { SafeJSON } from "@genesiscz/utils/json";

function entries(apis: readonly ApiDescriptor[]) {
    return apis.flatMap((api) => [
        ...api.methods.map((method) => ({ owner: api.global, alias: api.global, method })),
        ...(api.handles ?? []).flatMap((handle) =>
            handle.methods.map((method) => ({
                owner: `${api.global}.${handle.name}`,
                alias: handle.name.charAt(0).toLowerCase() + handle.name.slice(1),
                method,
            }))
        ),
    ]);
}

/** A result schema that says nothing (z.unknown()) is only its `$schema` key. */
function saysNothing(schema: unknown): boolean {
    return typeof schema === "object" && schema !== null && Object.keys(schema).every((key) => key === "$schema");
}

/** A JSON schema on one line without its `$schema` key: the signature above it already spells the types out. */
function compactSchema(schema: Record<string, unknown>): string {
    const { $schema: _dialect, ...rest } = schema;
    return SafeJSON.stringify(rest);
}

/**
 * One method in full. The doc comes right under the signature and the parameters' JSON schema last, on one line: the
 * pretty-printed schema ran to 80 lines for frame(), and an agent that read the first lines of several describe()
 * calls saw only signatures (round 5, item 8).
 */
function fullDescriptor(owner: string, method: MethodDescriptor): string {
    const result = jsonSchemaOf(method.result, "output");
    const resultLine = saysNothing(result)
        ? `Result: ${method.resultName ?? "unknown"}`
        : `Result: ${method.resultName ? `${method.resultName} ` : ""}${compactSchema(result)}`;
    return [
        methodSignature(owner, method),
        `Doc: ${method.doc}`,
        `Effect: ${effectLabel(method)}`,
        resultLine,
        `Parameters: ${compactSchema(jsonSchemaOf(method.params))}`,
        ...(method.mcp && Object.keys(method.mcp).length ? [`MCP: ${SafeJSON.stringify(method.mcp)}`] : []),
    ].join("\n");
}

/** A line spells a signature out up to this length; a longer one (an op list of 60 kinds) goes one level deep. */
const LINE_SIGNATURE_MAX = 600;

/** One method as search and a listing print it: its own signature, its effect and its doc (or the doc's start). */
function methodLine(owner: string, method: MethodDescriptor, doc = method.doc): string {
    const full = methodSignature(owner, method);
    const signature =
        full.length <= LINE_SIGNATURE_MAX
            ? full
            : `${methodSignature(owner, method, 1)} (describe("${owner}.${method.name}") prints it in full)`;
    return `${signature} [${effectLabel(method)}] — ${doc}`;
}

/** search() prints this many hits as lines and names the rest: "transcript" answered 24 lines, 12,235 chars (R2-NR1). */
const SEARCH_LINES = 10;
/** A search line's doc is its first sentence, cut at a word to this length; describe(name) prints all of it. */
const SEARCH_DOC_MAX = 200;

/** help(name) lists every method, so its lines are shorter than search's. */
const BRIEF_DOC_MAX = 120;

function docStart(doc: string, max = SEARCH_DOC_MAX): string {
    const end = doc.search(/[.!?](\s|$)/);
    const sentence = end === -1 ? doc : doc.slice(0, end + 1);

    if (sentence.length <= max) {
        return sentence;
    }

    const cut = sentence.slice(0, max);
    return `${cut.slice(0, cut.lastIndexOf(" "))} …`;
}

/**
 * A call's shape in names only: `movie.cut(from, to)`, `movie.frame(options?: { enabled, aspect, fit, … })`. The full
 * types are describe()'s; help(name) with them was 55,000 characters for movies (round 5, item 8).
 */
function briefSignature(owner: string, method: MethodDescriptor): string {
    const schema = jsonSchemaOf(method.params);
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const properties = typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {};
    const keys = Object.keys(properties);
    const named = (key: string) => `${key}${required.has(key) ? "" : "?"}`;
    const params = method.positional
        ? method.positional.map(named).join(", ")
        : keys.length === 0
          ? ""
          : `${required.size === 0 ? "options?" : "options"}: { ${keys.map(named).join(", ")} }`;
    return `${owner}.${method.name}(${params})`;
}

/** One line per method: names, effect and the doc's first sentence. */
function briefLines(owner: string, methods: readonly MethodDescriptor[]): string[] {
    return methods.map(
        (method) =>
            `- ${briefSignature(owner, method)} [${effectLabel(method)}]: ${docStart(method.doc, BRIEF_DOC_MAX)}`
    );
}

/**
 * A toolset as `help(name)` prints it: one line per method (names, effect, the doc's first sentence) and the notes.
 * describe("<owner>.<method>") prints one in full.
 */
export function renderBrief(api: ApiDescriptor): string {
    const lines = [`${api.title} (global \`${api.global}\`): ${api.summary}`, ...briefLines(api.global, api.methods)];

    for (const handle of api.handles ?? []) {
        const owner = handle.name.charAt(0).toLowerCase() + handle.name.slice(1);
        lines.push("", `${handle.name}: ${handle.summary}`, ...briefLines(owner, handle.methods));
    }

    if (api.notes?.length) {
        lines.push("", ...api.notes.map((note) => `Note: ${note}`));
    }

    const methods = [...api.methods, ...(api.handles ?? []).flatMap((handle) => handle.methods)];
    const positional = methods.find((method) => (method.positional?.length ?? 0) > 1);

    if (positional?.positional) {
        const names = positional.positional.join(", ");
        lines.push(
            `Note: a method with positional parameters also takes one object of their names: ${positional.name}(${names}) or ${positional.name}({ ${names} }).`
        );
    }

    const example = api.handles?.[0]?.methods[0] ?? api.methods[0];
    const exampleOwner = api.handles?.[0] ? `${api.global}.${api.handles[0].name}` : api.global;
    lines.push(
        "",
        `Each line is the method's names and the first sentence of its doc. describe("${example ? `${exampleOwner}.${example.name}` : api.global}") prints one in full: its types, its whole doc, its parameters and its result; search("words") finds methods by what they do.`
    );
    return lines.join("\n");
}

/** One line per method of an owner (`movies`, `movies.Movie`, or its alias `movie`), like search's lines. */
function ownerListing(list: ReturnType<typeof entries>, owner: string): string {
    return list
        .filter((entry) => entry.owner === owner)
        .map(({ method }) => methodLine(owner, method))
        .join("\n");
}

export function searchMethods(apis: readonly ApiDescriptor[], query: string): string {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const hits = entries(apis)
        .map((entry, index) => ({ entry, index, rank: searchRank(entry, terms) }))
        .filter((hit): hit is typeof hit & { rank: number } => hit.rank !== undefined)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(({ entry }) => entry);

    if (hits.length === 0) {
        return "No matching methods in the loaded toolsets.";
    }

    const lines = hits
        .slice(0, SEARCH_LINES)
        .map((entry) => methodLine(entry.owner, entry.method, docStart(entry.method.doc)));
    const rest = hits.slice(SEARCH_LINES).map((entry) => `${entry.owner}.${entry.method.name}`);

    if (rest.length > 0) {
        lines.push(`${rest.length} more: ${rest.join(", ")}`);
    }

    lines.push('Each line has the doc\'s first sentence; describe("<name>") prints a method in full.');
    return lines.join("\n");
}

/**
 * How well one method matches every term, lower first, or undefined when a term is missing: the method's name is the
 * term (0), the name holds it (1), the doc or a parameter holds it as a whole word (2), or only inside a word (3), so
 * `search("cut")` lists `Movie.cut` before "execution" and "shortcuts" (NR15).
 */
function searchRank(
    { owner, method }: { owner: string; method: MethodDescriptor },
    terms: readonly string[]
): number | undefined {
    const name = method.name.toLowerCase();
    const full = `${owner}.${method.name}`.toLowerCase();
    const text = `${full} ${method.doc} ${SafeJSON.stringify(jsonSchemaOf(method.params))}`.toLowerCase();
    let rank = 0;

    for (const term of terms) {
        if (!text.includes(term)) {
            return undefined;
        }

        const word = new RegExp(`(^|[^a-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_])`);
        rank +=
            name === term || full === term || full.endsWith(`.${term}`)
                ? 0
                : name.includes(term)
                  ? 1
                  : word.test(text)
                    ? 2
                    : 3;
    }

    return rank;
}

/**
 * One method in full (`movies.open`, `movies.Movie.cut`, its alias `movie.cut`, or a bare `cut` when only one
 * method has the name), or every method of a toolset or object (`movies`, `movies.Movie`, `Movie`, `movie`).
 * With no name it lists every toolset and object with its method names.
 */
export function describeMethod(apis: readonly ApiDescriptor[], name?: string): string {
    const list = entries(apis);
    const owners = [...new Set(list.map((entry) => entry.owner))];
    const index = owners
        .map(
            (owner) =>
                `${owner}: ${list
                    .filter((entry) => entry.owner === owner)
                    .map((entry) => entry.method.name)
                    .join(", ")}`
        )
        .join("\n");

    if (name === undefined || name.trim() === "") {
        return `${index}\n\ndescribe("<owner>") lists one of them with docs; describe("<owner>.<method>") prints one in full.`;
    }

    const wanted = name.trim();
    const owner = owners.find(
        (one) =>
            one === wanted ||
            one.split(".").at(-1) === wanted ||
            list.some((entry) => entry.owner === one && entry.alias === wanted && entry.alias !== entry.owner)
    );

    if (owner) {
        return ownerListing(list, owner);
    }

    const matches = list.filter(
        ({ owner, alias, method }) =>
            `${owner}.${method.name}` === wanted || `${alias}.${method.name}` === wanted || method.name === wanted
    );

    if (matches.length === 1) {
        return fullDescriptor(matches[0].owner, matches[0].method);
    }

    if (matches.length > 1) {
        throw new Error(
            `Ambiguous method: ${wanted}; use one of ${matches.map((entry) => `${entry.owner}.${entry.method.name}`).join(", ")}`
        );
    }

    throw new Error(`Unknown method: ${wanted}. The loaded names:\n${index}`);
}
