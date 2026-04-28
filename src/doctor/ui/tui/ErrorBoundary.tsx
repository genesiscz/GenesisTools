/** @jsxImportSource @opentui/solid */
import logger from "@app/logger";
import type { JSX } from "@opentui/solid";
import { ErrorBoundary as SolidErrorBoundary } from "solid-js";
import { THEME } from "./theme";

interface ErrorBoundaryProps {
    children: JSX.Element;
}

export function ErrorBoundary(props: ErrorBoundaryProps) {
    return <SolidErrorBoundary fallback={(err: Error) => renderError(err)}>{props.children}</SolidErrorBoundary>;
}

function renderError(err: Error) {
    logger.error({ err }, "doctor TUI render failed");

    return (
        <box padding={2} backgroundColor={THEME.bg} border borderColor={THEME.danger} flexDirection="column">
            <text fg={THEME.danger}>
                <strong>TUI error</strong>
            </text>
            <text fg={THEME.fg}>{err.message}</text>
            <text fg={THEME.fgDim}>Retry with `tools doctor --plain` for the linear renderer.</text>
        </box>
    );
}
