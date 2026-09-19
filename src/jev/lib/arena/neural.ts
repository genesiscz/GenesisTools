import type { CircuitGraph } from "./circuit";
import { type NeuralSnapshot, seededRandom, type Wiring } from "./types";

export class MaleCnsCircuit {
    private readonly voltage: Float32Array;
    private readonly current: Float32Array;
    private readonly refractory: Uint8Array;
    private readonly rates: Float32Array;
    private readonly queue: Float32Array[];
    private readonly offsets: Uint32Array;
    private readonly targets: Uint32Array;
    private readonly gains: Float32Array;
    private readonly sensory: Int8Array;
    private readonly outputs: number[];
    private tick = 0;
    private recentSpikes = 0;

    constructor(
        private readonly graph: CircuitGraph,
        options: { seed: number; wiring: Wiring }
    ) {
        const count = graph.neurons.length;
        const random = seededRandom(options.seed);
        this.voltage = Float32Array.from({ length: count }, () => -52 + (random() - 0.5) * 0.2);
        this.current = new Float32Array(count);
        this.refractory = new Uint8Array(count);
        this.rates = new Float32Array(count);
        this.queue = Array.from({ length: 3 }, () => new Float32Array(count));
        const sensoryIds = new Set(graph.manifest.sensoryIds);
        const outputIds = new Set(graph.manifest.outputIds);
        this.sensory = Int8Array.from(graph.neurons, (neuron) =>
            sensoryIds.has(neuron.id) ? (neuron.side === "L" ? -1 : 1) : 0
        );
        this.outputs = graph.neurons.flatMap((neuron, index) => (outputIds.has(neuron.id) ? [index] : []));
        this.offsets = new Uint32Array(count + 1);
        for (const [source] of graph.edges) {
            this.offsets[source + 1]++;
        }

        for (let i = 1; i <= count; i++) {
            this.offsets[i] += this.offsets[i - 1];
        }
        this.targets = new Uint32Array(graph.edges.length);
        this.gains = new Float32Array(graph.edges.length);
        const cursor = this.offsets.slice();
        const permutation = Uint32Array.from({ length: count }, (_, index) => index);
        if (options.wiring === "shuffled") {
            for (let i = count - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
            }
        }

        for (const [source, target, contacts, sign] of graph.edges) {
            const index = cursor[source]++;
            this.targets[index] = permutation[target];
            this.gains[index] =
                options.wiring === "disconnected"
                    ? 0
                    : contacts * sign * graph.manifest.modelParameters.synapseMvPerContact;
        }
    }

    advance({ milliseconds, left, right }: { milliseconds: number; left: number; right: number }): void {
        const membraneDecay = Math.exp(-1 / 20);
        const synapseDecay = Math.exp(-1 / 5);
        const rateDecay = Math.exp(-1 / 80);
        this.recentSpikes = 0;
        for (let step = 0; step < Math.max(0, Math.min(100, Math.floor(milliseconds))); step++) {
            const incoming = this.queue[this.tick % 3];
            const delayed = this.queue[(this.tick + 2) % 3];
            for (let i = 0; i < this.voltage.length; i++) {
                this.current[i] = this.current[i] * synapseDecay + incoming[i];
                incoming[i] = 0;
                this.rates[i] *= rateDecay;
                if (this.refractory[i] > 0) {
                    this.refractory[i]--;
                    continue;
                }
                const drive = this.sensory[i] === -1 ? left : this.sensory[i] === 1 ? right : 0;
                this.voltage[i] = Math.max(
                    -120,
                    -52 +
                        (this.voltage[i] + 52) * membraneDecay +
                        (this.current[i] +
                            Math.max(0, Math.min(1, drive)) * this.graph.manifest.modelParameters.sensoryCurrentMv) *
                            (1 - membraneDecay)
                );
                if (this.voltage[i] >= -45) {
                    this.voltage[i] = -52;
                    this.refractory[i] = 2;
                    this.rates[i] += 1000 * (1 - rateDecay);
                    this.recentSpikes++;
                    for (let edge = this.offsets[i]; edge < this.offsets[i + 1]; edge++) {
                        delayed[this.targets[edge]] += this.gains[edge];
                    }
                }
            }
            this.tick++;
        }
    }

    snapshot(): NeuralSnapshot {
        const mean = (indices: number[]) =>
            indices.length ? indices.reduce((sum, index) => sum + this.rates[index], 0) / indices.length : 0;
        const leftHz = mean(this.outputs.filter((index) => this.graph.neurons[index].side === "L"));
        const rightHz = mean(this.outputs.filter((index) => this.graph.neurons[index].side === "R"));
        let left = 0;
        let right = 0;
        let leftCount = 0;
        let rightCount = 0;
        let total = 0;
        const top: Array<{ id: string; type: string; hz: number }> = [];
        for (let i = 0; i < this.rates.length; i++) {
            const rate = this.rates[i];
            total += rate;
            if (this.sensory[i] === -1) {
                left += rate;
                leftCount++;
            } else if (this.sensory[i] === 1) {
                right += rate;
                rightCount++;
            }

            if (rate > 0.01 && (top.length < 8 || rate > top[top.length - 1].hz)) {
                top.push({ id: this.graph.neurons[i].id, type: this.graph.neurons[i].type, hz: rate });
                top.sort((a, b) => b.hz - a.hz);
                top.length = Math.min(8, top.length);
            }
        }

        return {
            leftHz,
            rightHz,
            sensoryLeftHz: left / Math.max(1, leftCount),
            sensoryRightHz: right / Math.max(1, rightCount),
            meanHz: total / this.rates.length,
            retreat: Math.min(1, (leftHz + rightHz) / 2 / this.graph.manifest.modelParameters.decoderHz),
            turn: Math.max(-1, Math.min(1, (leftHz - rightHz) / this.graph.manifest.modelParameters.turnHz)),
            spikes: this.recentSpikes,
            activity: Array.from(
                { length: Math.min(240, this.rates.length) },
                (_, i) => this.rates[Math.floor((i * this.rates.length) / Math.min(240, this.rates.length))]
            ),
            top,
        };
    }
}
