import { type BodyContent, type Tone } from "./primitives";
export type SimValue = string | number | boolean;
export interface SimStep {
    label: string;
    description?: BodyContent;
    /** State keys this step changes (merged over the previous state). */
    patch?: Record<string, SimValue>;
    /** Log lines this step appends. */
    logs?: string[];
    tone?: Tone;
}
export interface SimulatorProps {
    title?: string;
    initial: Record<string, SimValue>;
    steps: SimStep[];
    /** Autoplay interval in ms (default 1400). */
    interval?: number;
}
/**
 * Generic step-through state-machine player: an ordered list of steps, each
 * patching a visible state and appending log lines. Play, step, or jump.
 */
export declare function Simulator({
    title,
    initial,
    steps,
    interval,
}: SimulatorProps): import("react/jsx-runtime").JSX.Element;
