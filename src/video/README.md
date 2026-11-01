# Video evidence

Probe a local video or prepare PNG contact sheets with full-resolution source frames:

```sh
tools video probe ./demo.mp4 --json
tools video frames ./demo.mp4 --fps 2 --frames-per-image 16 --difference 0 --out ./evidence --json
tools video frames ./demo.mp4 --start 2.1 --end 5.4 --fps 4 --frames-per-image 8 --json
```

Requires ffmpeg and ffprobe. Silent videos work. FPS choices are 1–4; frames per image are 1, 4, 8, 16 or 32.
Each run publishes a new immutable generation directory with a manifest, sampled PNGs and sheets.

Optional `--start` and `--end` select an interval in original-video seconds. Start is inclusive; end is exclusive.
Sampling begins at the selected start, and timestamps on frames/sheets still refer to the original video.
The frame displayed at the start can have a slightly earlier source timestamp, especially with variable frame rates.
The original remains unchanged and available outside the selected interval. Omitting either boundary uses the start or end of the full source.
In the Widget video inspector, Start/End controls update the estimated frame count and prepare a new generation; Whole video restores the full interval.

The difference setting is an overall changed-pixel percentage, separate from Pixelmatch's color sensitivity.
Zero keeps every sample. The first sample is always kept; later candidates compare with the last kept frame.
Equality with the threshold keeps a frame.

The manifest records requested sampling times and actual decoded source timestamps. For variable-rate video,
each sample uses the frame displayed at the requested instant. Source rotation is applied by ffmpeg and
checked against decoded dimensions. Contact sheets use smaller labeled previews; individual PNGs retain
full resolution. A partial final sheet contains only its actual frames.

Limits are 10 minutes, 1 GiB of input, 48 million pixels per frame and 1 GiB of decoded selected-frame data.
The tool reports a budget error rather than silently changing the chosen FPS. HDR sources require an
explicit SDR conversion before splitting; this avoids silently producing incorrectly colored evidence.

Cancellation terminates the owned process group and removes only that generation's unfinished directory.
Completed generations are retained. The original input is not modified. The widget imports originals to
durable storage before starting preparation.

## Hardware re-encode

```sh
tools video encode ./clips --dry-run
tools video encode ./a.mp4 ./b.mov --replace --json
```

`tools video encode <paths...>` shrinks videos with the hardware encoder (HEVC through VideoToolbox, macOS only),
which keeps the CPU free: three jobs use about 28% of one core in total, against about 550% for libx265.
Folders are walked for `.mp4`, `.m4v`, `.mov` and `.mkv`. The output keeps the input's container.

Flags and defaults:

- `--quality <n>`: 58. SSIM against libx265 crf 26 was equal or better on three clips; 50 is visibly lower.
- `--codec [name]`: `hevc`, the only value. A bare `--codec` lists the values (a picker in a terminal). Encoders are a
  table in `src/utils/video/reencode.ts`.
- `--jobs <n>`: 2. The hardware encoder has few sessions.
- `--min-saving <percent>`: 25. A smaller saving discards the output.
- `--dry-run`: lists each file with its size and skip reason, writes nothing.
- `--replace`: the result takes the original path; the original goes to the GenesisTools trash and the batch id is
  printed. An agent may not replace a file that the `tools rm` rules mark "ask": the verified result stays beside it
  as `<name>.hevc.<ext>` (status `kept-beside`) and the summary prints the `tools rm <originals>` command a person runs
  to finish. A person at a terminal replaces as asked, and a "deny" verdict stops everyone. See "Undo a replace". Without it the result is `<name>.hevc.<ext>` beside the input.
  When the result cannot take the original path after the move, the original is put back and the row is `failed`; if
  that also fails, the row keeps its `trashBatch` and the summary prints the `tools rm restore <batch>` command.
- `--json`: one row per file (input, output, sizes, saving, kept, status, reason, trashBatch).

Skipped with a reason: files already HEVC, files with a data track (an iPhone `.MOV` with `mebx` metadata),
non-video files, containers that cannot hold HEVC, and earlier `.hevc` outputs.

A result is kept only when it is at least `--min-saving` smaller, its duration is within 0.5 s of the input, its video
is HEVC, audio is present when the input had audio, and a full hardware decode (`ffmpeg -v error -xerror`) prints
nothing. Otherwise the output is discarded and the input stays. Each ffmpeg (the encoder check, the encode and the
decode check) runs under `nice -n 10`; background QoS (`taskpolicy -b`) starved the jobs on a loaded Mac, so it is not
used.

Each encode is written into a new hidden folder beside its input (`.<name>.<ext>.hevc-XXXXXX`), which only that run
uses and removes when it finishes. The folder walk skips hidden folders, ffmpeg runs with `-n` so it never writes over
a file, and the result takes its final name only when nothing is there yet. Two runs on the same folder therefore never
touch each other's files. The encode maps the first playable video stream (`0:V:0`), never a cover picture.

The command exits 1 when any file failed (ffmpeg, a probe or the replace); skipped and discarded files exit 0.

### Undo a replace

`tools rm restore <batch>` alone refuses, because the new file sits at the original path. Two commands undo it; the
summary prints both after every replace:

```sh
mv ./a.mp4 ./a.hevc.mp4
tools rm restore <batch>
```
