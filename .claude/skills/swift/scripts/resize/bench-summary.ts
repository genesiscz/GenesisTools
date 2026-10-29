// One line per scenario of each `--bench` JSON: main-thread busy ms per step (p50 / p90 / max) and the late steps.
type Scenario = {
    name: string;
    steps?: number;
    busyMs: { p50: number; p90: number; max: number };
    framesOver16ms: number;
};
for (const file of process.argv.slice(2)) {
    const j = await Bun.file(file)
        .json()
        .catch(() => null);
    if (!j) {
        console.log(`${file}: unreadable`);
        continue;
    }
    const parts = (j.scenarios as Scenario[]).map((s) =>
        s.steps
            ? `${s.name} p50 ${s.busyMs.p50} p90 ${s.busyMs.p90} max ${s.busyMs.max} >16 ${s.framesOver16ms}/${s.steps}`
            : `${s.name} skipped`
    );
    console.log(`${file.replace(/^.*\//, "")}${j.partial ? " PARTIAL" : ""}: ${parts.join(" | ")}`);
}
