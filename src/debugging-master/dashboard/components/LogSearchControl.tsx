import type { ReactElement } from "react";
import { LogSearchPopover, type LogSearchState } from "./LogSearchPopover";

interface Props {
    logSearch: LogSearchState;
    onLogSearchChange: (next: LogSearchState) => void;
    matchCount: number;
    lineCount: number;
}

export function LogSearchControl({ logSearch, onLogSearchChange, matchCount, lineCount }: Props): ReactElement {
    return (
        <LogSearchPopover
            value={logSearch}
            onChange={onLogSearchChange}
            matchCount={matchCount}
            lineCount={lineCount}
        />
    );
}
