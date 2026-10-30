import { createCanvas, loadImage } from "@napi-rs/canvas";

/** The widest sheet a grid makes. A reader shrinks a wider image anyway, and a 4096 px sheet keeps a two-column
 * tile at half of a 4K display, which is the logical resolution of a Retina capture. */
export const MAX_SHEET_WIDTH = 4096;

export interface ImageGridResult {
    columns: number;
    rows: number;
    /** The drawn size of the first frame's tile, in sheet pixels. */
    tileWidth: number;
    tileHeight: number;
    /** How many times the source is scaled down in a tile: 1 is the source itself, 2 the logical size of a Retina
     * capture, above about 3 no text of a screen recording survives. */
    scale: number;
}

export async function composeImageGrid({
    images,
    output,
    columns: requestedColumns,
    maxWidth = MAX_SHEET_WIDTH,
    signal,
}: {
    images: { path: string; label: string }[];
    output: string;
    columns?: number;
    /** The sheet's widest allowed width in pixels; a tile is never scaled up past its source. */
    maxWidth?: number;
    signal?: AbortSignal;
}): Promise<ImageGridResult> {
    if (images.length < 1 || images.length > 32) {
        throw new Error("An image grid needs 1–32 frames");
    }

    const columns = requestedColumns ?? Math.ceil(Math.sqrt(images.length));
    if (!Number.isInteger(columns) || columns < 1 || columns > images.length) {
        throw new Error("Invalid image-grid column count");
    }
    if (!Number.isInteger(maxWidth) || maxWidth < columns * 64) {
        throw new Error("Invalid image-grid width");
    }

    // The tile follows the source, never a fixed size: a 4112 px display in two columns gets a 2048 px tile (scale
    // 2), where the old fixed 640 px cell shrank it 6.4 times and no text of a screen recording survived. The first
    // frame sets the cell; a later frame of another shape is fitted inside it.
    const rows = Math.ceil(images.length / columns);
    const first = await loadImage(images[0].path);
    const inset = 8;
    const cellWidth = Math.min(first.width + inset, Math.floor(maxWidth / columns));
    const cellHeight = Math.max(inset + 1, Math.round(((cellWidth - inset) * first.height) / first.width) + inset);
    const fontSize = Math.min(36, Math.max(15, Math.round(cellWidth / 40)));
    const labelHeight = fontSize + 13;
    const canvas = createCanvas(columns * cellWidth, rows * (cellHeight + labelHeight));
    const context = canvas.getContext("2d");
    context.fillStyle = "#151515";
    context.fillRect(0, 0, canvas.width, canvas.height);
    let tileWidth = 0;
    let tileHeight = 0;
    for (const [index, item] of images.entries()) {
        signal?.throwIfAborted();
        const source = index === 0 ? first : await loadImage(item.path);
        const x = (index % columns) * cellWidth;
        const y = Math.floor(index / columns) * (cellHeight + labelHeight);
        const ratio = Math.min(1, (cellWidth - inset) / source.width, (cellHeight - inset) / source.height);
        const width = source.width * ratio;
        const height = source.height * ratio;
        if (index === 0) {
            tileWidth = Math.round(width);
            tileHeight = Math.round(height);
        }
        context.drawImage(
            source,
            x + (cellWidth - width) / 2,
            y + labelHeight + (cellHeight - height) / 2,
            width,
            height
        );
        context.fillStyle = "#ffc95e";
        context.font = `${fontSize}px monospace`;
        context.fillText(item.label.slice(0, 80), x + inset, y + fontSize + 4, cellWidth - 2 * inset);
    }

    signal?.throwIfAborted();
    await Bun.write(output, canvas.toBuffer("image/png"));
    return { columns, rows, tileWidth, tileHeight, scale: Math.round((first.width / tileWidth) * 100) / 100 };
}
