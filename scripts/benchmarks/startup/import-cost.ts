/**
 * Cold import cost of one module, in its own process.
 *
 * The number a lazy-import comment cites comes from here:
 *   bun scripts/benchmarks/startup/import-cost.ts "@genesiscz/utils/ai/AIConfig.ts"
 *
 * It measures the WHOLE cold graph, so two modules that share dependencies each
 * report the shared part. Use it to rank candidates, and `cli-startup.ts` to
 * measure what moving one actually saved.
 */
const spec = process.argv[2];

if (!spec) {
    console.error("usage: bun scripts/benchmarks/startup/import-cost.ts <module-specifier>");
    process.exit(2);
}

const started = performance.now();
await import(spec);
console.log(`${spec}\t${(performance.now() - started).toFixed(1)} ms`);
