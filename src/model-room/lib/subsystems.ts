import { rewriteExpressionReferences } from "@genesiscz/utils/quantities/expression";
import { parseUnit, sameDimension } from "@genesiscz/utils/quantities/units";
import { z } from "zod";
import { compileModel } from "./compiler";
import { type ModelDocument, modelDocumentSchema, type Quantity, readModelDocument } from "./document";
import { convertModelTime } from "./document-operations";
import { evaluateDocument } from "./evaluation";
import type { RunControl } from "./simulation";

const ids = z.array(z.string().min(1).max(64)).max(256);
const subsystemSchema = z
    .object({
        format: z.literal("genesis-model-room-subsystem"),
        version: z.literal(1),
        model: modelDocumentSchema,
        members: ids.min(1),
        boundaryInputs: ids,
        outputs: ids.min(1).max(32),
    })
    .strict();

export type SubsystemPackage = z.infer<typeof subsystemSchema>;

function uniqueIDs(values: string[], label: string): Set<string> {
    const set = new Set(values);

    if (set.size !== values.length) {
        throw new Error(`${label} must not contain duplicate identifiers.`);
    }

    return set;
}

export function readSubsystemPackage(input: unknown): SubsystemPackage {
    const packageFile = subsystemSchema.parse(input);
    const model = compileModel({ input: packageFile.model });
    const members = uniqueIDs(packageFile.members, "Subsystem members");
    const boundary = uniqueIDs(packageFile.boundaryInputs, "Boundary inputs");
    const outputs = uniqueIDs(packageFile.outputs, "Subsystem outputs");

    if (
        packageFile.model.scenarios.length ||
        packageFile.model.subsystems.length ||
        packageFile.model.presentation.steps.length
    ) {
        throw new Error(
            "A reusable subsystem contains a baseline model without scenarios, nested groups or presentation steps."
        );
    }

    if ([...members].some((id) => !model.quantities.has(id) || boundary.has(id))) {
        throw new Error("Subsystem members must exist and must be distinct from its boundary inputs.");
    }

    if ([...boundary].some((id) => model.quantities.get(id)?.quantity.kind !== "input")) {
        throw new Error("Every boundary input must name an input quantity.");
    }

    if (members.size + boundary.size !== model.quantities.size || [...outputs].some((id) => !members.has(id))) {
        throw new Error("The manifest must cover every quantity, and outputs must be selected members.");
    }

    return packageFile;
}

export function inspectSubsystemSelection({ input, members }: { input: unknown; members: string[] }) {
    ids.min(1).parse(members);
    const compiled = compileModel({ input });
    const selected = uniqueIDs(members, "Selection");

    for (const id of selected) {
        if (!compiled.quantities.has(id)) {
            throw new Error(`Unknown selected quantity: ${id}`);
        }
    }

    const boundary = new Set<string>();
    const missing = new Map<string, Set<string>>();
    const visited = new Set<string>();
    const queue = [...selected];
    for (let index = 0; index < queue.length; index++) {
        const id = queue[index];

        if (visited.has(id)) {
            continue;
        }

        visited.add(id);
        const entry = compiled.quantities.get(id);

        if (!entry) {
            throw new Error(`Missing dependency: ${id}`);
        }

        for (const reference of new Set([...entry.references.immediate, ...entry.references.delayed])) {
            if (reference === "time" || reference === "step" || selected.has(reference)) {
                continue;
            }

            const dependency = compiled.quantities.get(reference);

            if (dependency?.quantity.kind === "input") {
                boundary.add(reference);
            } else {
                const owners = missing.get(reference) ?? new Set<string>();
                owners.add(id);
                missing.set(reference, owners);
                queue.push(reference);
            }
        }
    }

    return {
        members: compiled.document.quantities.filter((entry) => selected.has(entry.id)),
        boundaryInputs: compiled.document.quantities.filter((entry) => boundary.has(entry.id)),
        missingDependencies: [...missing].map(([id, requiredBy]) => {
            const quantity = compiled.quantities.get(id)?.quantity;

            if (!quantity) {
                throw new Error(`Missing dependency: ${id}`);
            }

            return { quantity, requiredBy: [...requiredBy] };
        }),
    };
}

async function requireExecutable({
    document,
    control,
}: {
    document: ModelDocument;
    control?: RunControl;
}): Promise<void> {
    const evaluation = await evaluateDocument({ input: document, control });
    const invalid = evaluation.scenarios.find((scenario) => scenario.error);

    if (invalid) {
        throw new Error(`${invalid.label}: ${invalid.error}`);
    }
}

export async function extractSubsystem({
    input,
    members,
    outputs,
    label,
    control,
}: {
    input: unknown;
    members: string[];
    outputs: string[];
    label: string;
    control?: RunControl;
}): Promise<SubsystemPackage> {
    const document = readModelDocument(input);
    const selection = inspectSubsystemSelection({ input: document, members });

    if (selection.missingDependencies.length) {
        throw new Error(
            "Include these dynamic dependencies before saving: " +
                selection.missingDependencies.map((entry) => entry.quantity.label).join(", ") +
                "."
        );
    }

    const included = new Set([...members, ...selection.boundaryInputs.map((entry) => entry.id)]);
    const quantities = structuredClone(document.quantities.filter((entry) => included.has(entry.id)));
    const model: ModelDocument = {
        format: "genesis-model-room",
        version: 1,
        id: "subsystem",
        title: label,
        description: `Reusable subsystem from ${document.title}. ${document.description}`.slice(0, 32000),
        time: { ...document.time },
        quantities,
        scenarios: [],
        subsystems: [],
        presentation: {
            controls: quantities
                .filter((entry) => entry.kind === "input")
                .slice(0, 32)
                .map((entry) => entry.id),
            outputs,
            steps: [],
        },
    };
    const packageFile = readSubsystemPackage({
        format: "genesis-model-room-subsystem",
        version: 1,
        model,
        members,
        boundaryInputs: selection.boundaryInputs.map((entry) => entry.id),
        outputs,
    });
    await requireExecutable({ document: packageFile.model, control });
    return packageFile;
}

function allocateID(label: string, existing: Set<string>): string {
    const base = label.slice(0, 64);
    let candidate = base;
    let suffix = 2;
    while (existing.has(candidate)) {
        const end = `_${suffix++}`;
        candidate = base.slice(0, 64 - end.length) + end;
    }

    existing.add(candidate);
    return candidate;
}

function placeQuantities(quantities: Quantity[], destination: ModelDocument): void {
    if (!quantities.length) {
        return;
    }

    const minX = Math.min(...quantities.map((entry) => entry.position.x));
    const minY = Math.min(...quantities.map((entry) => entry.position.y));
    const spanX = Math.max(...quantities.map((entry) => entry.position.x)) - minX;
    const spanY = Math.max(...quantities.map((entry) => entry.position.y)) - minY;
    const startsX = [0, ...Array.from({ length: 34 }, (_, index) => 40 + index * 240)];
    const startsY = [0, ...Array.from({ length: 51 }, (_, index) => 40 + index * 160)];
    for (const y of startsY) {
        for (const x of startsX) {
            if (x + spanX > 8192 || y + spanY > 8192) {
                continue;
            }

            const collides = destination.quantities.some(
                ({ position }) =>
                    x < position.x + 240 &&
                    x + spanX + 240 > position.x &&
                    y < position.y + 160 &&
                    y + spanY + 160 > position.y
            );

            if (!collides) {
                for (const quantity of quantities) {
                    quantity.position = { x: x + quantity.position.x - minX, y: y + quantity.position.y - minY };
                }

                return;
            }
        }
    }

    throw new Error(
        "The subsystem layout does not fit a free area of this board. Arrange its quantities more compactly before importing."
    );
}

export function subsystemBindingChoices({ input, packageInput }: { input: unknown; packageInput: unknown }) {
    const destination = compileModel({ input });
    const packageFile = readSubsystemPackage(packageInput);
    return packageFile.model.quantities
        .filter((entry) => entry.kind === "input")
        .map((quantity) => ({
            quantity,
            candidates: [...destination.quantities.values()]
                .filter(
                    (entry) =>
                        entry.quantity.kind === "input" &&
                        sameDimension(entry.unit, parseUnit({ source: quantity.unit }))
                )
                .map((entry) => entry.quantity),
        }));
}

export async function importSubsystem({
    input,
    packageInput,
    namespace,
    bindings = {},
    control,
}: {
    input: unknown;
    packageInput: unknown;
    namespace: string;
    bindings?: Record<string, string>;
    control?: RunControl;
}) {
    if (!/^[A-Za-z][A-Za-z_0-9]{0,31}$/.test(namespace)) {
        throw new Error("Choose a namespace of 1–32 letters, digits or underscores, beginning with a letter.");
    }

    const destination = readModelDocument(input);
    const packageFile = readSubsystemPackage(packageInput);
    const converted = convertModelTime({ input: packageFile.model, unit: destination.time.unit });

    if (
        Math.abs(converted.time.step - destination.time.step) >
        Math.max(converted.time.step, destination.time.step) * 1e-10
    ) {
        throw new Error(
            "The subsystem uses a " +
                converted.time.step +
                " " +
                destination.time.unit +
                " step; this model uses " +
                destination.time.step +
                ". Match physical step durations before importing to preserve lag behavior."
        );
    }

    z.record(z.string().min(1).max(64), z.string().min(1).max(64)).parse(bindings);
    const sourceInputs = new Set(
        converted.quantities.filter((entry) => entry.kind === "input").map((entry) => entry.id)
    );
    for (const id of Object.keys(bindings)) {
        if (!sourceInputs.has(id)) {
            throw new Error(`Only subsystem inputs can bind to an existing input; ${id} is not one.`);
        }
    }

    const existing = new Set([
        ...destination.quantities.map((entry) => entry.id),
        ...destination.scenarios.flatMap((scenario) => scenario.replacements.map((entry) => entry.id)),
    ]);
    const mapping = new Map<string, string>();
    const added: Quantity[] = [];
    for (const quantity of converted.quantities) {
        const boundID = Object.hasOwn(bindings, quantity.id) ? bindings[quantity.id] : undefined;

        if (boundID !== undefined) {
            const target = destination.quantities.find((entry) => entry.id === boundID);

            if (
                quantity.kind !== "input" ||
                target?.kind !== "input" ||
                !sameDimension(parseUnit({ source: quantity.unit }), parseUnit({ source: target.unit }))
            ) {
                throw new Error(`${quantity.label} must bind to an existing input of compatible units.`);
            }

            mapping.set(quantity.id, boundID);
        } else {
            const id = allocateID(`${namespace}_${quantity.id}`, existing);
            mapping.set(quantity.id, id);
            added.push({ ...structuredClone(quantity), id });
        }
    }

    for (const quantity of added) {
        if (quantity.kind === "formula") {
            quantity.expression = rewriteExpressionReferences({ source: quantity.expression, mapping });
        } else if (quantity.kind === "stock") {
            quantity.derivative = rewriteExpressionReferences({ source: quantity.derivative, mapping });
        }
    }

    const result = structuredClone(destination);
    placeQuantities(added, destination);
    result.quantities.push(...added);
    const groupID = allocateID(`subsystem_${namespace}`, new Set(result.subsystems.map((entry) => entry.id)));
    const groupMembers = [...new Set(packageFile.members.map((id) => mapping.get(id) ?? id))];
    result.subsystems.push({
        id: groupID,
        label: packageFile.model.title,
        description: packageFile.model.description.slice(0, 8000),
        quantities: groupMembers,
    });
    await requireExecutable({ document: result, control });
    return {
        document: result,
        subsystemId: groupID,
        mapping: Object.fromEntries(mapping),
        added: added.map((entry) => entry.id),
        bound: Object.keys(bindings),
        outputs: packageFile.outputs.map((id) => mapping.get(id) ?? id),
    };
}
