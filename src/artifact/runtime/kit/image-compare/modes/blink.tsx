import { useEffect, useSyncExternalStore } from "react";
import { Button } from "../../forms";
import {
    boolSetting,
    type CompareMode,
    ComparePane,
    type CompareStageProps,
    choiceSetting,
    StageImage,
    ToggleControl,
    ViewLayer,
} from "../stage";

const SHOWING = "blink.showing";
const AUTO = "blink.auto";
const SIDES = ["a", "b"] as const;
/** The auto flip interval: long enough to read a label, short enough to see a change pop. */
const BLINK_MS = 700;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeMotion(listener: () => void): () => void {
    if (typeof window.matchMedia !== "function") {
        return () => undefined;
    }

    const query = window.matchMedia(REDUCED_MOTION);
    query.addEventListener("change", listener);

    return () => query.removeEventListener("change", listener);
}

function prefersReducedMotion(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => false);
}

function flip(props: CompareStageProps): void {
    props.setSetting(SHOWING, choiceSetting(props.settings, SHOWING, SIDES, "a") === "a" ? "b" : "a");
}

/** One image at a time in the same place; a click or Space shows the other. */
function BlinkStage(props: CompareStageProps) {
    const reduced = useReducedMotion();
    const showing = choiceSetting(props.settings, SHOWING, SIDES, "a");
    const auto = boolSetting(props.settings, AUTO, false) && !reduced;
    const shown = showing === "a" ? props.a : props.b;
    const { setSetting } = props;

    useEffect(() => {
        if (!auto) {
            return;
        }

        const timer = window.setTimeout(() => setSetting(SHOWING, showing === "a" ? "b" : "a"), BLINK_MS);

        return () => window.clearTimeout(timer);
    }, [auto, showing, setSetting]);

    return (
        <ComparePane
            stage={props}
            label={`Blink comparison showing ${shown.label}; press Space to show the other image`}
            caption={<span aria-live={auto ? "off" : "polite"}>{`${showing.toUpperCase()}: ${shown.label}`}</span>}
            onTap={() => flip(props)}
            onKeyDown={(event) => {
                if (event.key === " ") {
                    event.preventDefault();
                    flip(props);
                }
            }}
        >
            <ViewLayer style={{ visibility: showing === "a" ? "visible" : "hidden" }}>
                <StageImage image={props.a} />
            </ViewLayer>
            <ViewLayer style={{ visibility: showing === "b" ? "visible" : "hidden" }}>
                <StageImage image={props.b} />
            </ViewLayer>
        </ComparePane>
    );
}

function BlinkControls(props: CompareStageProps) {
    const reduced = useReducedMotion();

    return (
        <>
            <Button size="sm" onClick={() => flip(props)}>
                Flip
            </Button>
            <ToggleControl
                label="Auto"
                checked={boolSetting(props.settings, AUTO, false) && !reduced}
                disabled={reduced}
                hint={reduced ? "off while the system asks for reduced motion" : `every ${BLINK_MS} ms`}
                onChange={(checked) => props.setSetting(AUTO, checked)}
            />
        </>
    );
}

export const blinkMode: CompareMode = { id: "blink", label: "Blink", Stage: BlinkStage, Controls: BlinkControls };
