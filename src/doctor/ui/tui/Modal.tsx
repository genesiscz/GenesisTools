/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { THEME } from "./theme";

interface ModalProps {
    title: string;
    children: JSX.Element;
}

export function Modal(props: ModalProps) {
    return (
        <box
            position="absolute"
            top="10%"
            left="15%"
            width="70%"
            height="80%"
            border
            borderStyle="rounded"
            borderColor={THEME.accent}
            backgroundColor={THEME.bgAlt}
            padding={2}
            zIndex={100}
            flexDirection="column"
        >
            <text fg={THEME.accent}>
                <strong>{props.title}</strong>
            </text>
            <box flexGrow={1} marginTop={1} flexDirection="column">
                {props.children}
            </box>
        </box>
    );
}
