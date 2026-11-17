import { type PointerEvent, useRef } from "react";
import { clampPercent, percentAt, sliderKeyPercent } from "../core";
import {
    type CompareMode,
    ComparePane,
    type CompareStageProps,
    numberSetting,
    StageImage,
    StageLabel,
    ViewLayer,
} from "../stage";

const POSITION = "slider.position";

/** B underneath, A on top clipped at the handle, so A shows left of the handle and B right of it. */
function SliderStage(props: CompareStageProps) {
    const position = numberSetting(props.settings, POSITION, 50);
    const dragging = useRef<number | null>(null);
    const move = (value: number): void => props.setSetting(POSITION, clampPercent(value));
    const moveTo = (event: PointerEvent<HTMLDivElement>): void => {
        const pane = event.currentTarget.parentElement;

        if (pane) {
            // The clip is in the pane's inner box, inside its border.
            const left = pane.getBoundingClientRect().left + pane.clientLeft;
            move(percentAt({ clientX: event.clientX, left, width: pane.clientWidth }));
        }
    };

    return (
        <ComparePane stage={props} label={`${props.a.label} and ${props.b.label}, split by a slider`}>
            <ViewLayer>
                <StageImage image={props.b} />
            </ViewLayer>
            <ViewLayer clip={`inset(0 ${100 - position}% 0 0)`}>
                <StageImage image={props.a} />
            </ViewLayer>
            <StageLabel>{props.a.label}</StageLabel>
            <StageLabel corner="top-right">{props.b.label}</StageLabel>
            <div
                role="slider"
                tabIndex={0}
                aria-label={`Divider between ${props.a.label} and ${props.b.label}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(position)}
                aria-valuetext={`${Math.round(position)}% ${props.a.label}`}
                onPointerDown={(event) => {
                    if (event.button !== 0) {
                        return;
                    }

                    // The pane pans on a drag; the handle's drag is its own.
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    dragging.current = event.pointerId;
                    moveTo(event);
                }}
                onPointerMove={(event) => {
                    if (dragging.current === event.pointerId) {
                        moveTo(event);
                    }
                }}
                onPointerUp={() => {
                    dragging.current = null;
                }}
                onPointerCancel={() => {
                    dragging.current = null;
                }}
                onKeyDown={(event) => {
                    const next = sliderKeyPercent({ key: event.key, shift: event.shiftKey, value: position });

                    if (next !== undefined) {
                        event.preventDefault();
                        move(next);
                    }
                }}
                className="group/handle absolute inset-y-0 z-[3] w-7 -translate-x-1/2 cursor-ew-resize touch-none focus-visible:outline-none"
                style={{ left: `${position}%` }}
            >
                <div className="mx-auto h-full w-0.5 bg-accent shadow-[0_0_0_1px_var(--bg)]" />
                <div className="absolute left-1/2 top-1/2 flex h-8 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-0.5 rounded-full border-2 border-accent bg-canvas shadow-md group-focus-visible/handle:outline-2 group-focus-visible/handle:outline-offset-2 group-focus-visible/handle:outline-solid group-focus-visible/handle:outline-info">
                    <span className="h-3 w-px bg-accent" />
                    <span className="h-3 w-px bg-accent" />
                </div>
            </div>
        </ComparePane>
    );
}

export const sliderMode: CompareMode = { id: "slider", label: "Slider", Stage: SliderStage };
