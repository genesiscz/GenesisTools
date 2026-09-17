export const CIRCUIT_REVISION = "5423f89274742055e1084f09a38ce10f8d07a7cc";
export const CIRCUIT_SOURCE = "https://github.com/hrook1/Swat";
export const CIRCUIT_TIERS = [
    {
        id: "compact",
        label: "Compact",
        file: "circuit-compact.json",
        neurons: 1088,
        edges: 71681,
        bytes: 1176728,
        blob: "02eaf6e53f84bd2740fcf1be0dc690a026815dfc",
    },
    {
        id: "balanced",
        label: "Balanced",
        file: "circuit-balanced.json",
        neurons: 1788,
        edges: 215329,
        bytes: 3504454,
        blob: "b6b8546e53c2a8cea7d8f4a1714063eb7db4ae3d",
    },
    {
        id: "standard",
        label: "Standard",
        file: "circuit.json",
        neurons: 2888,
        edges: 470170,
        bytes: 7707666,
        blob: "5c1c26f3de4b70c34dbf416da75f20071fd329fa",
    },
    {
        id: "expanded",
        label: "Expanded",
        file: "circuit-expanded.json",
        neurons: 6000,
        edges: 1275994,
        bytes: 21167933,
        blob: "48f6ea2cbeb7f45861bd23864a9a65204a47228c",
    },
] as const;
export type CircuitTierId = (typeof CIRCUIT_TIERS)[number]["id"];
export interface CircuitTier {
    id: string;
    label: string;
    file: string;
    neurons: number;
    edges: number;
    bytes: number;
    blob: string;
}
export interface CircuitNeuron {
    id: string;
    type: string;
    side: string;
    nt: string;
    role: string;
    x: number;
    y: number;
    z: number;
}
export interface CircuitGraph {
    version: string;
    neurons: CircuitNeuron[];
    edges: Array<[number, number, number, number]>;
    manifest: {
        dataset: string;
        neuronCount: number;
        edgeCount: number;
        contactCount: number;
        outputIds: string[];
        sensoryIds: string[];
        assumptions: string[];
        attribution: string;
        license: string;
        licenseUrl: string;
        sources: Array<{ file: string; url: string; sha256: string }>;
        modelParameters: {
            synapseMvPerContact: number;
            sensoryCurrentMv: number;
            decoderHz: number;
            turnHz: number;
        };
    };
}
export interface CircuitStatus extends CircuitTier {
    cached: boolean;
}

export function parseCircuit(value: unknown, tier: CircuitTier): CircuitGraph {
    if (!value || typeof value !== "object") {
        throw new Error("Invalid MaleCNS circuit.");
    }
    const graph = value as CircuitGraph;
    if (
        !Array.isArray(graph.neurons) ||
        graph.neurons.length !== tier.neurons ||
        !Array.isArray(graph.edges) ||
        graph.edges.length !== tier.edges ||
        graph.manifest?.dataset !== "male-cns:v1.0" ||
        graph.manifest.neuronCount !== tier.neurons ||
        graph.manifest.edgeCount !== tier.edges ||
        !Array.isArray(graph.manifest.outputIds) ||
        !Array.isArray(graph.manifest.sensoryIds)
    ) {
        throw new Error("MaleCNS circuit does not match the pinned dataset.");
    }
    const ids = new Set<string>();
    for (const neuron of graph.neurons) {
        if (
            typeof neuron.id !== "string" ||
            ids.has(neuron.id) ||
            typeof neuron.type !== "string" ||
            typeof neuron.side !== "string" ||
            ![neuron.x, neuron.y, neuron.z].every(Number.isFinite)
        ) {
            throw new Error("Invalid or duplicate neuron in MaleCNS circuit.");
        }
        ids.add(neuron.id);
    }

    for (const edge of graph.edges) {
        if (
            !Array.isArray(edge) ||
            edge.length !== 4 ||
            !Number.isInteger(edge[0]) ||
            edge[0] < 0 ||
            edge[0] >= tier.neurons ||
            !Number.isInteger(edge[1]) ||
            edge[1] < 0 ||
            edge[1] >= tier.neurons ||
            !Number.isInteger(edge[2]) ||
            edge[2] < 1 ||
            ![-1, 0, 1].includes(edge[3])
        ) {
            throw new Error("Invalid connection in MaleCNS circuit.");
        }
    }

    const parameters = graph.manifest.modelParameters;
    if (
        !parameters ||
        !Object.values(parameters).every(Number.isFinite) ||
        parameters.synapseMvPerContact < 0 ||
        parameters.synapseMvPerContact > 1 ||
        parameters.sensoryCurrentMv < 0 ||
        parameters.sensoryCurrentMv > 100 ||
        parameters.decoderHz <= 0 ||
        parameters.turnHz <= 0 ||
        !graph.manifest.outputIds.every((id) => ids.has(id)) ||
        !graph.manifest.sensoryIds.every((id) => ids.has(id))
    ) {
        throw new Error("Invalid MaleCNS model parameters or input/output identities.");
    }

    return graph;
}
