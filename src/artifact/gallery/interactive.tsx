import { ParametricSimulator, SegmentedControl, type SimParams, type SimStep, Simulator } from "@artifact/kit";
import { useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Interactive",
    title: "Simulators and segmented control",
    summary: "A step player for a state machine, a simulator driven by sliders and presets, and a pick-one control.",
    components: ["Simulator", "ParametricSimulator", "SegmentedControl"],
};

const DEPLOY_STEPS: SimStep[] = [
    { label: "Build image", patch: { stage: "build" }, logs: ["image built in 72 s"] },
    { label: "Push", patch: { stage: "push" }, logs: ["pushed to the registry"] },
    { label: "Roll out", patch: { stage: "rollout", healthy: 3 }, logs: ["3 of 6 nodes updated"], tone: "warn" },
    { label: "Finish", patch: { stage: "done", healthy: 6 }, logs: ["all nodes healthy"], tone: "ok" },
];

/** Pure: a queue drains `rate` jobs per tick from `backlog`, with or without retries adding work back. */
function drain(params: SimParams): { initial: Record<string, number | string>; steps: SimStep[] } {
    const rate = Number(params.rate);
    const retries = params.retries === true;
    let backlog = Number(params.backlog);
    const steps: SimStep[] = [];

    for (let tick = 1; tick <= 8 && backlog > 0; tick++) {
        const extra = retries ? Math.round(rate * 0.25) : 0;
        backlog = Math.max(0, backlog - rate + extra);
        steps.push({
            label: `Tick ${tick}`,
            patch: { backlog, tick },
            logs: [`processed ${rate} ${params.mode === "lifo" ? "newest" : "oldest"} first, ${extra} came back`],
            tone: backlog === 0 ? "ok" : undefined,
        });
    }

    return { initial: { backlog: Number(params.backlog), tick: 0, mode: String(params.mode) }, steps };
}

export default function InteractivePage() {
    const [range, setRange] = useState("week");

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Simulator controls are buttons: Tab reaches play, step back, step forward and each step chip; Enter or Space presses them. ParametricSimulator's sliders move with the arrow keys. SegmentedControl is a radio group: Tab focuses it, Left and Right change the choice."
        >
            <Demo title="SegmentedControl" note="controlled, with a label">
                <SegmentedControl
                    label="Range"
                    value={range}
                    onChange={setRange}
                    options={[
                        { value: "day", label: "Day" },
                        { value: "week", label: "Week" },
                        { value: "month", label: "Month" },
                    ]}
                />
                <p className="mt-2 text-sm text-dim">Showing the last {range}.</p>
            </Demo>
            <Demo title="Simulator" note="steps patch the state and append log lines">
                <Simulator
                    title="Deploy"
                    initial={{ stage: "idle", healthy: 0 }}
                    steps={DEPLOY_STEPS}
                    interval={1200}
                />
            </Demo>
            <Demo title="ParametricSimulator" note="one pure generate(params), presets on top">
                <ParametricSimulator
                    title="Queue drain"
                    initialParams={{ backlog: 400, rate: 60, retries: false, mode: "fifo" }}
                    controls={[
                        { kind: "range", key: "backlog", label: "Backlog", min: 50, max: 1000, step: 50, unit: "jobs" },
                        { kind: "range", key: "rate", label: "Rate", min: 10, max: 200, step: 10, unit: "/tick" },
                        { kind: "toggle", key: "retries", label: "Failed jobs retry" },
                        {
                            kind: "segmented",
                            key: "mode",
                            label: "Order",
                            options: [
                                { value: "fifo", label: "Oldest first" },
                                { value: "lifo", label: "Newest first" },
                            ],
                        },
                    ]}
                    presets={[
                        { label: "Quiet night", params: { backlog: 100, rate: 60, retries: false, mode: "fifo" } },
                        {
                            label: "Retry storm",
                            params: { backlog: 900, rate: 80, retries: true, mode: "fifo" },
                            note: "Retries keep the backlog high.",
                        },
                    ]}
                    generate={drain}
                />
            </Demo>
            <Demo title="Edge case: a single step" note="play stops at once">
                <Simulator initial={{ value: 1 }} steps={[{ label: "Only step", patch: { value: 2 } }]} />
            </Demo>
        </GalleryPage>
    );
}
