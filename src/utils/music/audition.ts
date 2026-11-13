import { resolve } from "node:path";
import { publishAudio, runAudio } from "./process";
import { audioCodec } from "./render";

export async function auditionMusic(options: {
    files: string[];
    output: string;
    seconds?: number;
    start?: number;
    overwrite?: boolean;
}): Promise<{ output: string; order: string[] }> {
    const seconds = options.seconds ?? 24;
    const start = options.start ?? 12;

    if (
        options.files.length < 2 ||
        options.files.length > 10 ||
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > 120 ||
        !Number.isFinite(start) ||
        start < 0
    ) {
        throw new Error("Audition needs 2 to 10 files, 0 to 120 seconds each, and a nonnegative start");
    }

    const files = options.files.map((file) => resolve(file));

    if (files.includes(resolve(options.output))) {
        throw new Error("Audition output must differ from the source files");
    }

    const chains = files.map(
        (_, index) =>
            "[" +
            index +
            ":a:0]atrim=start=" +
            start +
            ":duration=" +
            seconds +
            ",asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo," +
            "apad,atrim=duration=" +
            seconds +
            "[a" +
            index +
            "]"
    );
    chains.push(`${files.map((_, index) => `[a${index}]`).join("")}concat=n=${files.length}:v=0:a=1[out]`);
    await publishAudio({
        output: options.output,
        overwrite: options.overwrite,
        prepare: async (temporary) => {
            await runAudio([
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-v",
                "error",
                "-y",
                ...files.flatMap((file) => ["-i", file]),
                "-filter_complex",
                chains.join(";"),
                "-map",
                "[out]",
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                "-flags:a",
                "+bitexact",
                "-threads",
                "1",
                ...audioCodec(options.output),
                temporary,
            ]);
        },
    });
    return { output: resolve(options.output), order: files };
}
