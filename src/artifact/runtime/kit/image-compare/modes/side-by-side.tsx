import { type CompareMode, ComparePane, type CompareStageProps, StageImage, ViewLayer } from "../stage";

/** A left, B right, each with its label above; both panes share one zoom and pan. */
function SideBySideStage(props: CompareStageProps) {
    return (
        <div className="grid grid-cols-2 gap-2">
            {[props.a, props.b].map((image, index) => (
                <div key={index === 0 ? "a" : "b"} className="min-w-0">
                    <div className="mb-1 truncate text-xs font-medium text-dim">{image.label}</div>
                    <ComparePane stage={props} label={image.label}>
                        <ViewLayer>
                            <StageImage image={image} />
                        </ViewLayer>
                    </ComparePane>
                </div>
            ))}
        </div>
    );
}

export const sideBySideMode: CompareMode = { id: "side-by-side", label: "Side by side", Stage: SideBySideStage };
