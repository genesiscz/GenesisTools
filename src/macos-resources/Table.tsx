/**
 * The box-drawing table behind the process and open-files views.
 *
 * It renders exactly what the previous class component rendered. What changed is
 * the cost of a render: column widths are computed once per data change instead
 * of once per render, and a row's React key is its position instead of a sha1 of
 * its contents. The hash was the expensive half — `object-hash` ran a crypto
 * digest per row per render, on a component that repaints several times a
 * second — and the harmful half, because a key that changes with the content
 * forces React to unmount and remount every row whose CPU number moved.
 */

import { Box, Text } from "ink";
import React, { useMemo } from "react";

type Scalar = string | number | boolean | null | undefined;

type ScalarDict = {
    [key: string]: Scalar;
};

export type CellProps = React.PropsWithChildren<{ column: number }>;

export type TableProps<T extends ScalarDict> = {
    /** List of values (rows). */
    data: T[];
    /** Columns that we should display in the table. */
    columns: readonly (keyof T)[];
    /** Cell padding. */
    padding: number;
    /** Header component. */
    header: (props: React.PropsWithChildren) => React.ReactElement;
    /** Component used to render a cell in the table. */
    cell: (props: CellProps) => React.ReactElement;
    /** Component used to render the skeleton of the table. */
    skeleton: (props: React.PropsWithChildren) => React.ReactElement;
};

type Column<T> = {
    key: string;
    column: keyof T;
    width: number;
};

type SkeletonChars = {
    component: (props: React.PropsWithChildren) => React.ReactElement;
    /**
     * Characters used in skeleton.
     *    |             |
     * (left)-(line)-(cross)-(line)-(right)
     *    |             |
     */
    left: string;
    right: string;
    cross: string;
    line: string;
};

type RowConfig = {
    /** Component used to render cells. */
    cell: (props: CellProps) => React.ReactElement;
    /** Tells the padding of each cell. */
    padding: number;
    /** Component used to render skeleton in the row. */
    skeleton: SkeletonChars;
};

type RowProps<T extends ScalarDict> = {
    keyPrefix: string;
    data: Partial<T>;
    columns: Column<T>[];
};

/** Columns that must not shrink below these widths, whatever the data holds. */
const MIN_WIDTHS: Record<string, number> = {
    pid: 8,
    process: 20,
    cpu: 8,
    memory: 10,
    files: 8,
    command: 60,
};

/** Renders the header of a table. */
export function Header(props: React.PropsWithChildren) {
    return (
        <Text bold color="blue">
            {props.children}
        </Text>
    );
}

/** Renders a cell in the table. */
export function Cell(props: CellProps) {
    return <Text>{props.children}</Text>;
}

/** Renders the scaffold of the table. */
export function Skeleton(props: React.PropsWithChildren) {
    return <Text bold>{props.children}</Text>;
}

/** Intersperses a list of elements with another element. */
function intersperse<T, I>(intersperser: (index: number) => I, elements: T[]): (T | I)[] {
    const interspersed: (T | I)[] = [];

    for (let i = 0; i < elements.length; i++) {
        if (i > 0) {
            interspersed.push(intersperser(i));
        }

        interspersed.push(elements[i]);
    }

    return interspersed;
}

function dataKeys<T extends ScalarDict>(data: T[]): (keyof T)[] {
    const keys = new Set<keyof T>();

    for (const row of data) {
        for (const key in row) {
            keys.add(key);
        }
    }

    return Array.from(keys);
}

/**
 * The width of each column: the longest value in it, floored by {@link MIN_WIDTHS}.
 * O(rows × columns), which is why the caller memoises it.
 */
function computeColumns<T extends ScalarDict>(data: T[], columns: readonly (keyof T)[], padding: number): Column<T>[] {
    return columns.map((key) => {
        const header = String(key).length;
        let longest = header;

        for (const row of data) {
            const value = row[key];

            if (value === undefined || value === null) {
                continue;
            }

            longest = Math.max(longest, String(value).length);
        }

        const calculatedWidth = longest + padding * 2;

        return {
            column: key,
            width: Math.max(calculatedWidth, MIN_WIDTHS[String(key)] ?? calculatedWidth),
            key: String(key),
        };
    });
}

function renderRow<T extends ScalarDict>(config: RowConfig, props: RowProps<T>): React.ReactElement {
    const skeleton = config.skeleton;

    return (
        <Box flexDirection="row" width="100%">
            <skeleton.component>{skeleton.left}</skeleton.component>
            {...intersperse(
                (i) => (
                    <skeleton.component key={`${props.keyPrefix}-hseparator-${i}`}>{skeleton.cross}</skeleton.component>
                ),
                props.columns.map((column, colI) => {
                    const value = props.data[column.column];

                    if (value === undefined || value === null) {
                        return (
                            <config.cell key={`${props.keyPrefix}-empty-${column.key}`} column={colI}>
                                {skeleton.line.repeat(column.width)}
                            </config.cell>
                        );
                    }

                    const ml = config.padding;
                    const mr = column.width - String(value).length - config.padding;

                    return (
                        /* prettier-ignore */
                        <config.cell key={`${props.keyPrefix}-cell-${column.key}`} column={colI}>
                            {`${skeleton.line.repeat(ml)}${String(value)}${skeleton.line.repeat(Math.max(0, mr))}`}
                        </config.cell>
                    );
                })
            )}
            <skeleton.component>{skeleton.right}</skeleton.component>
        </Box>
    );
}

function Table<T extends ScalarDict>(props: Pick<TableProps<T>, "data"> & Partial<TableProps<T>>) {
    const { data } = props;
    const padding = props.padding ?? 1;
    const headerComponent = props.header ?? Header;
    const cellComponent = props.cell ?? Cell;
    const skeletonComponent = props.skeleton ?? Skeleton;
    const explicitColumns = props.columns;

    const columns = useMemo(
        () => computeColumns(data, explicitColumns ?? dataKeys(data), padding),
        [data, explicitColumns, padding]
    );

    const headings = useMemo(() => {
        const result: Partial<T> = {};

        for (const column of columns) {
            (result as Record<string, unknown>)[column.key] = column.key;
        }

        return result;
    }, [columns]);

    const configs = useMemo(() => {
        const line = (cell: RowConfig["cell"], chars: Omit<SkeletonChars, "component">): RowConfig => ({
            cell,
            padding,
            skeleton: { component: skeletonComponent, ...chars },
        });

        return {
            top: line(skeletonComponent, { line: "─", left: "┌", right: "┐", cross: "┬" }),
            heading: line(headerComponent, { line: " ", left: "│", right: "│", cross: "│" }),
            separator: line(skeletonComponent, { line: "─", left: "├", right: "┤", cross: "┼" }),
            body: line(cellComponent, { line: " ", left: "│", right: "│", cross: "│" }),
            bottom: line(skeletonComponent, { line: "─", left: "└", right: "┘", cross: "┴" }),
        };
    }, [padding, skeletonComponent, headerComponent, cellComponent]);

    return (
        <Box flexDirection="column" width="100%">
            {renderRow(configs.top, { keyPrefix: "header", columns, data: {} })}
            {renderRow(configs.heading, { keyPrefix: "heading", columns, data: headings })}
            {data.map((row, index) => (
                // Position, not content. A content-derived key remounts every row
                // whose numbers moved, which is every row on every refresh.
                <Box flexDirection="column" key={`row-${index}`}>
                    {renderRow(configs.separator, { keyPrefix: `separator-${index}`, columns, data: {} })}
                    {renderRow(configs.body, { keyPrefix: `data-${index}`, columns, data: row })}
                </Box>
            ))}
            {renderRow(configs.bottom, { keyPrefix: "footer", columns, data: {} })}
        </Box>
    );
}

export default React.memo(Table) as typeof Table;
