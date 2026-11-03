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

## Shrink: let the tool pick the settings

```sh
tools video shrink ./talk.mp4 --to 400MB              # measure, show, ask, encode, check
tools video shrink ./talk.mp4 --to 400MB --compare    # also write and open a 2x2 comparison video
tools video shrink ./talk.mp4 --to 400MB --yes        # take the recommendation without asking
tools video shrink ./talk.mp4 --preview-only --json   # only the measurements
```

`tools video shrink <file>` does what otherwise takes an evening of ffmpeg runs:

1. **Plan.** It reads the file, works out the video bitrate a `--to` size leaves, and picks the picture height
   (`--height auto`): the tallest standard height that still gets 0.015 bits per pixel, and then measures that height
   against one step taller with x264 on two windows and keeps the better one. A 108 min 1080p talk at 400 MB
   gets 0.007 at 1080p and 0.017 at 720p, so it goes to 720p, which also scored higher at the same size. With
   `--audio auto`, audio that would take more than 15% of the target is re-encoded to AAC 96 kbit/s, which gives the
   video about 30 kbit/s more.
2. **Sample.** From the source's own packet sizes it finds the hardest, a median and the easiest 10 s (`--window`),
   away from the first and last 5%, and cuts each as a lossless reference.
3. **Preview.** Each preset (`fast`, `compatible`, `small`) encodes each window at the share of the target a two-pass
   encode would give it (the average rate times the window's source rate over the file's, to the power 0.6, so the
   hardest stretch of a talk gets about 1.8 times the average), and each result
   is scored against its reference with VMAF and SSIM (the encode scaled back with bicubic, the same for every
   preset). The table shows the mean and the worst window, the predicted size and the predicted encode time.
4. **Recommend.** The best score wins, but a faster preset within 1 VMAF point takes its place, and `small` (AV1)
   must lead by 1.5 points, since AV1 plays in fewer places. Without libvmaf it ranks by SSIM in decibels.
5. **Compare** (`--compare`). The hardest window as a 2x2 video, `<name>.compare.mp4` beside the input: the source,
   then each preset, left to right and top to bottom. It opens in the default player.
6. **Encode.** A picker in a terminal (the recommendation first), `--yes`, or `--preset`. The encode is
   `tools video encode` with the size correction, progress and decode check.
7. **Check.** The result is scored on the same windows, next to the sample scores, so you see that the full encode
   kept what the preview promised.

`--preset <name>` previews and encodes only that preset; `--no-preview` skips the samples. `--replace` puts the
result at the original path. `--format json` prints one report, `jsonl` streams the plan, every window score and the
result as lines.

## Re-encode

```sh
tools video encode ./clips --dry-run
tools video encode ./a.mp4 ./b.mov --replace --json
tools video encode ./talk.mp4 --preset compatible --height 720 --target-size 400MB --progress
```

`tools video encode <paths...>` shrinks videos. By default it uses the hardware encoder (HEVC through VideoToolbox,
macOS only), which keeps the CPU free: three jobs use about 28% of one core in total, against about 550% for libx265.
Folders are walked for `.mp4`, `.m4v`, `.mov` and `.mkv`. The output keeps the input's container.

Presets, measured on a 10 s clip of a 720p talk recording at 420 kbit/s (2026-11-02, SSIM against the source):

- `fast`: `hevc`, the GPU, with a 20 s GOP, two B-frames and no frame coarser than QP 36. SSIM 0.982. Fastest and
  almost no CPU, but visibly softer at low bitrates.
- `compatible`: `x264` slow, two passes for a size target. SSIM 0.993. Plays everywhere; on that clip it took about a
  third of the time x265 took. (`--codec x265` uses preset medium: slow cost 2.4 to 2.6 times the time for no gain.)
- `small`: `av1`, SVT-AV1 preset 5. SSIM 0.995, the best per byte; older devices may not decode AV1.

Flags and defaults:

- `--preset [name]`: `fast`, `compatible` or `small`. It picks the encoder, so it cannot be combined with `--codec`.
- `--codec [name]`: `hevc` (default), `x264`, `x265` or `av1`. A bare `--codec` lists the values (a picker in a
  terminal). Encoders are a table in `src/utils/video/reencode.ts`, each with its own rate, scale and two-pass flags.
- `--quality <n>`: in the encoder's own scale. `hevc`: 0 to 100, higher is better, default 58 (SSIM against libx265
  crf 26 was equal or better on three clips; 50 is visibly lower). `x264`/`x265`: CRF, lower is better, default 23/26.
  `av1`: CRF 1 to 63, default 35.
- `--jobs <n>`: 2. The hardware encoder has few sessions.
- `--min-saving <percent>`: 25. A smaller saving discards the output.
- `--target-size <size>`: aim each output at this size (`400MB`, `1.5GB`, a bare number is MB) instead of `--quality`.
  The video gets the target minus the audio and a 1% container share. VideoToolbox misses an
  average bitrate, so a result outside 90% to 103% of the target is encoded again with a corrected rate, at most twice.
  x264 and x265 run two passes instead, which land within a few percent. An input already in the target codec is a
  candidate too. A bitrate cap (`-maxrate`) is not used: on VideoToolbox it starved the picture (SSIM 0.859).
- `--height <px>`: scale a taller video down to this height, with Lanczos on the CPU for every encoder. `hevc` still
  decodes and encodes on the GPU. The GPU scaler (`scale_vt`) was dropped: at the same bitrate it scored VMAF 76.7
  against 90.1 for Lanczos, for 0.6 s less CPU per 10 s of 1080p.
- `--audio <mode>`: `auto` (default; copy, but AAC 96 kbit/s when copied audio would take over 15% of
  `--target-size`), `copy`, or an AAC bitrate in kbit/s (`96`, `128k`).
- `--progress`: report each encode while it runs, from ffmpeg's `-progress` output. In a terminal it is a clack bar;
  without one, a line per 10%. With `--format json` the progress events are JSON lines on stderr and stdout stays one
  document; with `--format jsonl` stdout carries `{"type":"progress",...}` lines and a `{"type":"row",...}` line for
  each file as soon as it is finished.
- `--format text|json|jsonl`: text (the table, the default), json (all rows at the end; `--json` is the same), or jsonl.
- `--dry-run`: lists each file with its size and skip reason, writes nothing.
- `--replace`: the result takes the original path; the original goes to the GenesisTools trash and the batch id is
  printed. An agent may not replace a file that the `tools rm` rules mark "ask": the verified result stays beside it
  as `<name>.hevc.<ext>` (status `kept-beside`) and the summary prints the `tools rm <originals>` command a person runs
  to finish. A person at a terminal replaces as asked, and a "deny" verdict stops everyone. See "Undo a replace". Without it the result is `<name>.hevc.<ext>` beside the input.
  When the trash move or the install fails after the original moved, the original is put back and the row is
  `failed`; if that also fails, the row keeps its `trashBatch` and the summary prints the `tools rm restore <batch>`
  command.
- `--json`: one row per file (input, output, sizes, saving, kept, status, reason, trashBatch).

Skipped with a reason: files already HEVC, files with a track the encode does not carry over (a data track like an
iPhone `.MOV`'s `mebx` metadata, a subtitle, a second video, a cover picture, an attachment), files ffprobe reads and
rejects as not a video, containers that cannot hold HEVC, and earlier `.hevc` outputs. The encode keeps the first
playable video and every audio track.

A result is kept only when it is at least `--min-saving` smaller, its duration is within 0.5 s of the input, its video
is HEVC, it has every audio track the input had, and a full hardware decode (`ffmpeg -v error -xerror`) of the video and
every audio track prints nothing. Otherwise the output is discarded and the input stays. The original's device, inode,
size and modification time are read before the probe; a result is installed only while the original still matches them,
so an edit during the encode, or another run's replace, discards the result and the original is never trashed for a
stale encode. Each ffmpeg (the encoder check, the encode and the decode check) runs under `nice -n 10`; background QoS
(`taskpolicy -b`) starved the jobs on a loaded Mac, so it is not used.

Each encode is written into a new hidden folder beside its input (`.<name>.<ext>.hevc-XXXXXX`), which only that run
uses and removes when it finishes. The folder walk skips hidden folders, ffmpeg runs with `-n` so it never writes over
a file, and the result takes its final name only when nothing is there yet. Two runs on the same folder therefore never
touch each other's files. The encode maps the first playable video stream (`0:V:0`), never a cover picture.

The command exits 1 when any file failed (ffmpeg, the replace, a probe that could not run: no ffprobe, a timeout,
a file this process cannot read, or a file that was gone when its turn came); skipped and discarded files exit 0. A
failed file never stops the others: every file gets its row.

### Undo a replace

`tools rm restore <batch>` alone refuses, because the new file sits at the original path. The summary prints one line
that undoes it after every replace:

```sh
mv -n ./a.mp4 ./a.hevc.mp4 && test ! -e ./a.mp4 && tools rm restore <batch>
```

`mv -n` never writes over an `a.hevc.mp4` that is already there, and since it exits 0 when it skips, the `test`
lets the restore run only when the original path is free.

## Download an HLS stream

```sh
tools video stream download ./page.har --list
tools video stream download ./page.har --stream 1 --out talk.mp4
tools video stream download https://cdn.example.com/live/abc/master.m3u8 --header "Referer: https://example.com/"
tools video stream download --out talk.mp4 --stitch-only
```

`tools video stream download [source]` takes a HAR file (DevTools, Network, "Save all as HAR") or a playlist URL. It
finds the HLS playlists in the HAR, replays their `Referer`, `Origin`, `User-Agent`, `Cookie` and `Authorization`
headers, and downloads every segment until the stream ends. Then it stitches them into `--out`.

- **From the start.** A live playlist lists only the last few segments, but a CDN often keeps older ones. When the
  segment names carry their sequence number, the tool finds the oldest one the CDN still serves (a binary search) and
  downloads from there. `--no-backfill` starts at the live window.
- **Until the end.** It re-reads the playlist every target duration. It stops at `#EXT-X-ENDLIST`, after three 404 or
  410 answers for the playlist, or after `--idle-timeout` seconds (120) without a new segment.
- **Resume.** Segments go to `<out>.parts/` (written to `.part`, then renamed, so a killed run leaves no half segment).
  Run the same command again: it skips what is on disk, downloads the rest, and stitches again. Without a source it
  resumes from `<out>.parts/state.json`. `--stitch-only` stitches what is there. Ctrl-C stops and keeps the parts.
- **Stitch.** A `.ts` output is the segments concatenated. Any other container goes through `ffmpeg -c copy`. Segments
  the CDN had already deleted are reported as gaps.
- `--quality best|worst|<height>` picks the variant of a master playlist. `--jobs` (6) sets the parallel downloads.

`state.json` holds the replayed headers, cookies included, so it is written with mode 600. Remove the parts folder when
the output is good. Not supported: encrypted segments, byte-range playlists, and audio in a separate playlist.

### Pick the source: the platform's recording, the page's replay, or the live stream

```sh
tools video stream download ./page.har --list                # every source, each checked now, with its --stream id
tools video stream download ./page.har                       # a terminal asks which one; the best is first
tools video stream download ./page.har --stream 71cfefd1     # a source by its id (or its number in --list)
tools video stream download ./page.har --wait-recording      # wait (up to 240 min) for the platform's recording
tools video stream download --chrome-cdp https://example.com/event/3 --list
```

A broadcast can be downloaded from up to three places, and they differ:

- **The platform's original recording.** Some players ask their platform's API about the broadcast, and that answer is
  in the HAR (StreamYard webinars today). The tool asks the same API again with the player's own headers. Once the
  broadcast has ended, the answer carries the platform's own file: one MP4 in the original quality (a 1 h 47 min talk
  was 3.75 GB at 1080p, 4.6 Mbit/s). It downloads into `<out>.part` first, and a rerun resumes it with `Range`.
- **The page's replay.** Many pages swap the live player for a replay once the broadcast ends (a Bunny Stream player,
  for example). It is a finished HLS stream: the same length, often re-encoded smaller (the same talk was 1.7 GB at
  2.1 Mbit/s). A HAR or a capture made after the swap has it.
- **The live stream.** A CDN keeps only the latest part of a live stream, so it misses the start of a long broadcast,
  and it is gone soon after the end.

`--list` shows each source with its length and height. Without `--stream`, a terminal asks which one, with the best
first: a recording, then finished streams (longest first), then live ones, then a recording still to wait for. Without
a terminal the best one is taken, except a recording that is not made yet: then it exits 1 and prints the commands.
`--from-stream` offers only the HLS streams. The printed resume command keeps `--stream` and `--quality`.

The player's session in a HAR lasts about a month. After that the API answers 401, and a fresh HAR is needed.

`--chrome-cdp <page url>` records the HAR in your own browser instead of DevTools. It reloads the tab that has the page
open, or opens a tab and closes it afterwards, and records the page and its embedded players (they run in their own
process, so each one is attached separately). It stops when playlists and player answers stop coming, or after
`--chrome-cdp-wait` seconds (30). The HAR is saved in `~/.genesis-tools/video/captures/` (mode 600), and the messages
print the command that reruns from it. A capture also offers the platform recordings of earlier captures of the same
page, since the page no longer loads that player once it shows the replay. The browser needs a debug port:
`--chrome-cdp-port`, else the browser that has the page open, else 9222 (`tools chrome-devtools restart --browser brave
--port 9222` turns it on).

A new platform is one file in `stream/providers/` that implements `StreamProvider` (find its answers in a HAR, ask the
API now) and one entry in `STREAM_PROVIDERS`.

Credentials stay with their origin: the cookies and the Authorization header of a HAR go only to the origin of the
playlist they were captured for, never to another host a playlist points at. A segment that still fails after the
retries (not a 404) stops the stitch: the tool exits 1 with the command that retries it.
