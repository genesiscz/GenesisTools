import { createCanvas, loadImage } from "@napi-rs/canvas";

export async function composeImageGrid({
    images,
    output,
    columns: requestedColumns,
    signal,
}: {
    images: { path: string; label: string }[];
    output: string;
    columns?: number;
    signal?: AbortSignal;
}): Promise<{ columns: number; rows: number }> {
    if (images.length < 1 || images.length > 32) {
        throw new Error("An image grid needs 1–32 frames");
    }

    const columns = requestedColumns ?? Math.ceil(Math.sqrt(images.length));
    if (!Number.isInteger(columns) || columns < 1 || columns > images.length) {
        throw new Error("Invalid image-grid column count");
    }

    const rows = Math.ceil(images.length / columns);
    const cellWidth = Math.min(640, Math.floor(2560 / columns));
    const cellHeight = Math.floor(cellWidth * 0.625);
    const labelHeight = 28;
    const canvas = createCanvas(columns * cellWidth, rows * (cellHeight + labelHeight));
    const context = canvas.getContext("2d");
    context.fillStyle = "#151515";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const [index, item] of images.entries()) {
        signal?.throwIfAborted();
        const source = await loadImage(item.path);
        const x = (index % columns) * cellWidth;
        const y = Math.floor(index / columns) * (cellHeight + labelHeight);
        const ratio = Math.min((cellWidth - 8) / source.width, (cellHeight - 8) / source.height);
        const width = source.width * ratio;
        const height = source.height * ratio;
        context.drawImage(
            source,
            x + (cellWidth - width) / 2,
            y + labelHeight + (cellHeight - height) / 2,
            width,
            height
        );
        context.fillStyle = "#ffc95e";
        context.font = "15px monospace";
        context.fillText(item.label.slice(0, 80), x + 8, y + 19, cellWidth - 16);
    }

    signal?.throwIfAborted();
    await Bun.write(output, canvas.toBuffer("image/png"));
    return { columns, rows };
}
