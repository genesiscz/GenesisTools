import { Youtube } from "@app/youtube/lib/youtube";

let cached: Youtube | undefined;

export async function getYoutube(): Promise<Youtube> {
    cached ??= new Youtube();

    return cached;
}

export async function withPipeline<T>(fn: (yt: Youtube) => Promise<T>): Promise<T> {
    const yt = await getYoutube();
    await yt.pipeline.start();

    return fn(yt);
}

process.once("beforeExit", async () => {
    await cached?.dispose();
});
