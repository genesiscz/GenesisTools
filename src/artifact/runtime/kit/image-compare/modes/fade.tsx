import { clampPercent } from "../core";
import {
    type CompareMode,
    ComparePane,
    type CompareStageProps,
    numberSetting,
    RangeControl,
    StageImage,
    ViewLayer,
} from "../stage";

const OPACITY = "fade.opacity";

/** B over A at the opacity the range sets. */
function FadeStage(props: CompareStageProps) {
    const opacity = numberSetting(props.settings, OPACITY, 50);

    return (
        <ComparePane
            stage={props}
            label={`${props.b.label} over ${props.a.label} at ${Math.round(opacity)}%`}
            caption={`${props.a.label} under ${props.b.label} at ${Math.round(opacity)}%`}
        >
            <ViewLayer>
                <StageImage image={props.a} />
            </ViewLayer>
            <ViewLayer style={{ opacity: opacity / 100 }}>
                <StageImage image={props.b} />
            </ViewLayer>
        </ComparePane>
    );
}

function FadeControls(props: CompareStageProps) {
    return (
        <RangeControl
            label={`${props.b.label} opacity`}
            min={0}
            max={100}
            step={1}
            value={numberSetting(props.settings, OPACITY, 50)}
            onChange={(value) => props.setSetting(OPACITY, clampPercent(value))}
            format={(value) => `${Math.round(value)}%`}
        />
    );
}

export const fadeMode: CompareMode = { id: "fade", label: "Fade", Stage: FadeStage, Controls: FadeControls };
