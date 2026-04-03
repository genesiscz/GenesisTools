import type { ComponentProps } from "react";
import { InfoBox } from "./InfoBox";

export function Callout(props: ComponentProps<typeof InfoBox>) {
    return <InfoBox {...props} />;
}
