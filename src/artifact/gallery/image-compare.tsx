import { ImageCompare, ImageCompareModeSwitch, ImageCompareProvider, Note, StickyControls } from "@artifact/kit";
import { useEffect, useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Diff",
    title: "Image compare",
    summary:
        "ImageCompare: before and after images side by side, under a slider, blinking, faded, as a pixel diff with pink changed pixels, boxed and listed regions, or as a colour-distance heat map. A page moved by a few pixels is found and aligned first. One zoom and pan for every mode; a page switch sets every comparison at once.",
    components: ["ImageCompare", "ImageCompareProvider", "ImageCompareModeSwitch"],
};

interface Palette {
    page: string;
    panel: string;
    line: string;
    ink: string;
    dim: string;
    accent: string;
    accentAfter: string;
}

const LIGHT: Palette = {
    page: "#f4f5f7",
    panel: "#ffffff",
    line: "#d9dce3",
    ink: "#1d2330",
    dim: "#6b7385",
    accent: "#2f6fec",
    accentAfter: "#1f9d6b",
};

const DARK: Palette = {
    page: "#11141a",
    panel: "#1b2029",
    line: "#2c3442",
    ink: "#e6e9ef",
    dim: "#8b94a7",
    accent: "#5b8cff",
    accentAfter: "#3ccf91",
};

interface MockOptions {
    width: number;
    height: number;
    palette: Palette;
    after: boolean;
    /** Card rows of a long page; the first screen always has one. */
    rows?: number;
    /** A footer row only the after image has (the size demo). */
    footer?: boolean;
    /** Draws the whole page moved by this many pixels (the alignment demo). */
    shift?: { dx: number; dy: number };
}

/** A small dashboard drawn on a canvas, so the gallery needs no binary fixture. `after` changes a few things. */
function drawMock(
    context: CanvasRenderingContext2D,
    { width, height, palette, after, rows = 1, footer = false, shift }: MockOptions
): void {
    context.fillStyle = palette.page;
    context.fillRect(0, 0, width, height);
    context.translate(shift?.dx ?? 0, shift?.dy ?? 0);
    context.fillStyle = palette.panel;
    context.fillRect(0, 0, width, 52);
    context.fillStyle = palette.line;
    context.fillRect(0, 52, width, 1);
    context.font = "600 17px system-ui, sans-serif";
    context.fillStyle = palette.ink;
    context.fillText("Bookings", 20, 32);

    // The primary button moves 14 px and changes colour in the after image.
    context.fillStyle = after ? palette.accentAfter : palette.accent;
    context.fillRect(width - (after ? 150 : 164), 12, 128, 30);
    context.font = "600 13px system-ui, sans-serif";
    context.fillStyle = "#ffffff";
    context.fillText(after ? "New booking" : "Add booking", width - (after ? 132 : 146), 32);

    const cardWidth = (width - 20 * 4) / 3;
    const values = [
        ["Today", after ? "1,312" : "1,284"],
        ["This week", "8,940"],
        ["No-shows", after ? "2.1%" : "3.4%"],
    ];

    for (let row = 0; row < rows; row++) {
        const top = 72 + row * 300;

        for (let column = 0; column < 3; column++) {
            const left = 20 + column * (cardWidth + 20);
            context.fillStyle = palette.panel;
            context.fillRect(left, top, cardWidth, 96);
            context.strokeStyle = palette.line;
            context.strokeRect(left + 0.5, top + 0.5, cardWidth - 1, 95);
            context.font = "13px system-ui, sans-serif";
            context.fillStyle = palette.dim;
            context.fillText(values[column][0], left + 16, top + 30);
            context.font = "700 28px system-ui, sans-serif";
            context.fillStyle = palette.ink;
            context.fillText(row === 0 ? values[column][1] : values[(column + row) % 3][1], left + 16, top + 70);
        }

        const chartTop = top + 116;
        context.fillStyle = palette.panel;
        context.fillRect(20, chartTop, width - 40, 160);
        context.strokeStyle = palette.line;
        context.strokeRect(20.5, chartTop + 0.5, width - 41, 159);
        context.strokeStyle = palette.accent;
        context.lineWidth = 2;
        context.beginPath();

        for (let step = 0; step <= 12; step++) {
            const x = 40 + ((width - 80) * step) / 12;
            const bump = after && row === 0 && step === 8 ? 38 : 0;
            const y = chartTop + 120 - 50 * Math.abs(Math.sin((step + row) / 2.2)) - bump;

            if (step === 0) {
                context.moveTo(x, y);
            } else {
                context.lineTo(x, y);
            }
        }

        context.stroke();
        context.lineWidth = 1;
    }

    if (after && footer) {
        context.fillStyle = palette.panel;
        context.fillRect(20, height - 70, width - 40, 50);
        context.font = "13px system-ui, sans-serif";
        context.fillStyle = palette.dim;
        context.fillText("Last synced 2 minutes ago", 36, height - 40);
    }
}

function mockUrl(options: MockOptions): string {
    const canvas = document.createElement("canvas");
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext("2d");

    if (context) {
        drawMock(context, options);
    }

    return canvas.toDataURL("image/png");
}

interface Samples {
    shifted: { before: string; after: string };
    light: { before: string; after: string };
    dark: { before: string; after: string };
    taller: { before: string; after: string };
    large: { before: string; after: string };
}

/** Draws every sample pair once, after mount (a canvas needs the browser). */
function useSamples(): Samples | undefined {
    const [samples, setSamples] = useState<Samples>();

    useEffect(() => {
        const pair = (options: Omit<MockOptions, "after">, afterHeight = options.height) => ({
            before: mockUrl({ ...options, after: false }),
            after: mockUrl({ ...options, height: afterHeight, after: true, footer: afterHeight > options.height }),
        });

        setSamples({
            light: pair({ width: 720, height: 400, palette: LIGHT }),
            dark: pair({ width: 720, height: 400, palette: DARK }),
            taller: pair({ width: 720, height: 400, palette: LIGHT }, 480),
            large: pair({ width: 1280, height: 2000, palette: LIGHT, rows: 6 }),
            shifted: {
                before: mockUrl({ width: 720, height: 400, palette: LIGHT, after: false }),
                after: mockUrl({ width: 720, height: 400, palette: LIGHT, after: true, shift: { dx: 3, dy: 12 } }),
            },
        });
    }, []);

    return samples;
}

export default function ImageComparePage() {
    const samples = useSamples();

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Click an image (or Tab to a stage) to focus a comparison. Then 1 to 6 pick a mode, + and - zoom, 0 fits, and with three or more images [ and ] step image B. A key typed into a select or a text field stays there. The mode switch is a radio group: the arrows pick a mode. In Slider, Tab reaches the handle: Left and Right move it 2%, with Shift 10%, and Home and End jump to the edges. In Blink, Space on the stage shows the other image. Ctrl or Cmd with the wheel zooms at the pointer, and a drag pans once the image is larger than the stage. The Keys line under each comparison repeats this."
        >
            {samples ? (
                <>
                    <Demo
                        title="Equal sizes"
                        note="Every mode on one pair. In Diff, the threshold, the underlay and the region buttons sit under the switch."
                    >
                        <ImageCompare
                            before={{ src: samples.light.before }}
                            after={{ src: samples.light.after }}
                            caption="A changed value, a moved and recoloured button, and one chart point."
                        />
                    </Demo>
                    <Demo
                        title="Different sizes"
                        note="Both images sit top-left on the larger canvas. Pixels inside only one image count as changed."
                    >
                        <ImageCompare
                            before={{ src: samples.taller.before }}
                            after={{ src: samples.taller.after, label: "After, with a footer" }}
                            defaultMode="diff"
                        />
                    </Demo>
                    <Demo title="Light and dark screenshots" note="The diff pink reads on both underlays.">
                        <ImageCompare
                            images={[
                                { src: samples.dark.before, label: "Dark before" },
                                { src: samples.dark.after, label: "Dark after" },
                            ]}
                            modes={["slider", "blink", "diff"]}
                            defaultMode="slider"
                        />
                    </Demo>
                    <Demo
                        title="A shifted image"
                        note="After is the same page moved by 3 px right and 12 px down, with a few real changes. The diff finds the shift, says so and compares the aligned pair, so only the real changes are pink; turn Align off to see the smear a moved page makes. Heat shows how far each pixel's colour moved."
                    >
                        <ImageCompare
                            before={{ src: samples.shifted.before }}
                            after={{ src: samples.shifted.after, label: "After, moved" }}
                            defaultMode="diff"
                        />
                    </Demo>
                    <Demo
                        title="Three images"
                        note="With three or more images, two selects pick A and B; with the comparison focused, [ and ] step B."
                    >
                        <ImageCompare
                            images={[
                                { src: samples.light.before, label: "Build 1" },
                                { src: samples.light.after, label: "Build 2" },
                                { src: samples.taller.after, label: "Build 3, with a footer" },
                            ]}
                            defaultMode="slider"
                        />
                    </Demo>
                    <Demo
                        title="A large pair, 1280 x 2000"
                        note="Measured in Bun 1.4.2 on an Apple M4 Max: the diff of a 1280 x 2000 pair takes about 6 ms with one changed block, 24 ms when every text row moved by 3 px (387,250 changed pixels), and 19 ms against a 1280 x 2100 image. Decoding the images in the browser comes on top; the summary after the controls prints this browser's time."
                    >
                        <ImageCompare
                            before={{ src: samples.large.before }}
                            after={{ src: samples.large.after }}
                            defaultMode="diff"
                            maxHeight={520}
                        />
                    </Demo>
                    <Demo
                        title="A page switch over three comparisons"
                        note="The switch sets every comparison under the provider. Pick a mode on one comparison and it keeps its own until you press Follow page."
                    >
                        <ImageCompareProvider storageKey="artifact.gallery.image-compare">
                            <StickyControls label="Comparison controls" sticky={false}>
                                <ImageCompareModeSwitch />
                            </StickyControls>
                            <ImageCompare
                                before={{ src: samples.light.before }}
                                after={{ src: samples.light.after }}
                                maxHeight={320}
                            />
                            <ImageCompare
                                before={{ src: samples.taller.before }}
                                after={{ src: samples.taller.after }}
                                maxHeight={320}
                            />
                            <ImageCompare
                                before={{ src: samples.dark.before }}
                                after={{ src: samples.dark.after }}
                                maxHeight={320}
                            />
                        </ImageCompareProvider>
                    </Demo>
                </>
            ) : (
                <Note>Drawing the sample images...</Note>
            )}
        </GalleryPage>
    );
}
