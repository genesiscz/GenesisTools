import { type CompareMode, ComparePane, type CompareStageProps, StageImage, ViewLayer } from "../stage";

/** A left, B right, each with its label above; both panes share one zoom and pan. */
function SideBySideStage(props: CompareStageProps) {
    return (
        <div className="grid grid-cols-2 gap-2">
            {[props.a, props.b].map((image, index) => (
                <ComparePane key={index === 0 ? "a" : "b"} stage={props} label={image.label} caption={image.label}>
                    <ViewLayer>
                        <StageImage image={image} />
                    </ViewLayer>
                </ComparePane>
            ))}
        </div>
    );
}

export const sideBySideMode: CompareMode = { id: "side-by-side", label: "Side by side", Stage: SideBySideStage };
