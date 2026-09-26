import { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import type { ReactNode } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";

interface TtydMosaicProps {
    layout: MosaicNode<string>;
    onChange: (next: MosaicNode<string> | null) => void;
    sessions: TtydSession[];
    renderToolbar: (session: TtydSession) => ReactNode;
    renderBody: (session: TtydSession) => ReactNode;
}

/**
 * The desktop tiling of the ttyd page, in its own chunk: react-mosaic and react-dnd are 134 KB
 * (39 KB gzip) that focused mode, which every phone uses, never renders.
 */
export function TtydMosaic({ layout, onChange, sessions, renderToolbar, renderBody }: TtydMosaicProps) {
    return (
        <Mosaic<string>
            value={layout}
            onChange={onChange}
            renderTile={(id, path) => {
                const session = sessions.find((candidate) => candidate.id === id);

                if (!session) {
                    return (
                        <div className="dd-panel flex h-full items-center justify-center p-2 text-[var(--dd-text-muted)]">
                            session gone
                        </div>
                    );
                }

                return (
                    <MosaicWindow<string>
                        path={path}
                        // Name wins in the topbar; Claude's live topic is separate meta.
                        title={ttydLabel(session)}
                        additionalControls={null}
                        toolbarControls={renderToolbar(session)}
                    >
                        {renderBody(session)}
                    </MosaicWindow>
                );
            }}
            className="dd-mosaic"
        />
    );
}
