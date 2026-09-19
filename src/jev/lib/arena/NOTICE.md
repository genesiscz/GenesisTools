# MaleCNS circuit data

The arena downloads adapted subsets of MaleCNS v1.0 only when a MaleCNS controller starts.
No connectome JSON or raw Feather files are bundled in GenesisTools.

Dataset creators: FlyEM / HHMI Janelia Research Campus, University of Cambridge,
MRC Laboratory of Molecular Biology, and Google Research; Berg et al., Cell (2026).

- Official source: https://male-cns.janelia.org/download/
- License: CC BY 4.0, https://creativecommons.org/licenses/by/4.0/
- Circuit extraction: https://github.com/hrook1/Swat
- Pinned upstream revision: `5423f89274742055e1084f09a38ce10f8d07a7cc`
- Upstream attribution: https://github.com/hrook1/Swat/blob/5423f89274742055e1084f09a38ce10f8d07a7cc/public/data/ATTRIBUTION.md

The extracted graphs preserve neuron IDs and original synaptic contact counts among
retained cells. Their manifests include selection rules, raw-source SHA-256 hashes,
input/output IDs, transmitter assumptions, and boundary omissions. GenesisTools verifies
each downloaded or cached graph against its pinned Git blob hash and expected byte/count
metadata. It does not independently re-download the raw source tables during normal use.

Adaptations in this arena: a new TypeScript point-neuron simulator and game, simplified
visual looming input to LC16, an MDN-rate escape readout, optional seeded target permutation
or disconnected-edge controls, an engineered food-seeking controller, and optional Jev
action selection. The simulation uses fixed 1 ms neural ticks within 20 ms game steps;
time constants, transmitter signs, gains, sensory mapping, and flying movement are model
assumptions, not measurements of an individual fly. There is no plasticity or training.

The source is a selected retreat circuit, not a complete CNS or whole-animal emulation.
The data creators and circuit-extraction authors have not endorsed this arena.
