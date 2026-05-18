// Single import surface for sink modules: importing a sink triggers
// registerSink (side-effect registration) without a two-module import or cycle.
export * from "./registry";
export * from "./types";
