# tools video

Work with local videos and web broadcasts from the terminal. It inspects a video, turns it into timestamped PNG
contact sheets for review, makes a video smaller with measured settings instead of guessed ffmpeg flags, and
downloads a broadcast (live or finished) from a saved HAR file, a playlist URL or a page open in your browser.

## Quick start

```sh
tools video probe ./demo.mp4                                 # size, length, codec and rotation as JSON
tools video frames ./demo.mp4 --fps 2 --frames-per-image 16  # contact sheets plus every sampled frame
tools video shrink ./talk.mp4 --to 400MB                     # try every preset, recommend one, encode, check
tools video encode ./clips --dry-run                         # what a batch re-encode would do; writes nothing
tools video stream download ./page.har --list                # every source a saved HAR leads to
tools video stream download ./page.har --out talk.mp4        # download one; run it again to resume
```

`probe`, `frames`, `shrink` and `encode` need `ffmpeg` and `ffprobe` on the PATH (`brew install ffmpeg` installs both).
`stream download` needs `ffmpeg` only for an `--out` that does not end in `.ts`; a platform recording download and
`--list` need neither. Silent videos (no audio track) work: `probe` reads the first video stream only.

## Commands

| Command                    | What it does                                          |
|----------------------------|-------------------------------------------------------|
| `probe <input>`            | Print a video's facts as JSON                         |
| `frames <input>`           | Sample frames into PNGs and labeled contact sheets    |
| `shrink <file>`            | Measure the presets, recommend one, encode, check     |
| `encode <paths...>`        | Re-encode files or folders, keep only verified output |
| `stream download [source]` | Save a broadcast from a HAR, a URL or a browser page  |

`-v, --verbose` turns on debug logging, `--readme` prints this page, and `tools video help <command>` (or
`<command> --help`) prints a command's flags.

### probe

```sh
tools video probe ./demo.mp4
```

Prints one JSON object: `path`, `durationUs`, `width`, `height`, `displayWidth`, `displayHeight` (after rotation),
`rotation`, `bytes`, `codec`, and `colorSpace` and `colorTransfer` when the file names them. `--json` is accepted;
the output is JSON with or without it. `probe` refuses the same inputs as `frames` (see "Limits" below).

### frames: contact sheets for review

```sh
tools video frames ./demo.mp4 --fps 2 --frames-per-image 16 --difference 0 --out ./evidence
tools video frames ./demo.mp4 --start 2.1 --end 5.4 --fps 4 --frames-per-image 8
```

- `--fps <1|2|3|4>`: samples per second. Default 2.
- `--frames-per-image <1|4|8|16|32>`: frames on each contact sheet. Default 16.
- `--difference <percent>`: skip a sample that changed fewer pixels than this, 0 to 100. Default 0 (keep all).
- `--start <seconds>`, `--end <seconds>`: sample only this interval of the original video. Start is inclusive and
  end is exclusive. Either one left out means the start or the end of the whole video.
- `--out <directory>`: the output root. Default `~/.genesis-tools/video/evidence/`.
- `--json`: accepted; the manifest is printed as JSON either way.

Each run publishes a new, immutable generation folder `<out>/<id>/` with `manifest.json`, the sampled PNGs and the
sheets. A bad `--fps` or `--frames-per-image` prints the allowed values.

How sampling works:

- Sampling begins at the selected start, and every timestamp on a frame or a sheet refers to the original video.
  The frame displayed at the start can have a slightly earlier source timestamp, above all in variable frame rate
  video. The original stays unchanged and complete outside the interval.
- For variable-rate video, each sample is the frame displayed at the requested instant. The manifest records both the
  requested time and the actual decoded source timestamp of each frame.
- `--difference` is an overall changed-pixel percentage, separate from Pixelmatch's color sensitivity. Zero keeps
  every sample. The first sample is always kept; each later candidate is compared with the last kept frame. A
  difference equal to the threshold keeps the frame.
- ffmpeg applies the source rotation, and the result is checked against the decoded dimensions. Only 0, 90, 180 and
  270 degrees are accepted.
- Contact sheets hold smaller labeled previews; the individual PNGs keep the full resolution. A partial last sheet
  holds only its real frames. Each sheet records its tile size and its `scale` (how many times the source is shrunk
  in a tile; manifests from 2026-10-30 on). Above a scale of about 3, read the full-resolution frame for text.
- The source is fingerprinted (SHA-256) before and after. A file that changed during the run is refused ("Source video
  changed during preparation"), and nothing is published.
- Cancellation (Ctrl-C) stops the process group the tool started and removes only that generation's unfinished
  `.preparing-<id>` folder. Completed generations stay. The input is never modified.

In the GenesisTools widget's video inspector, the Start and End controls update the estimated frame count and
prepare a new generation; "Whole video" restores the full interval. The widget imports the original to durable
storage before it starts.

#### Limits (probe and frames)

- 10 minutes of video, 1 GiB of input, 48 million pixels per frame, and 1 GiB of decoded selected-frame data.
  `--start` and `--end` do not lift the length limit, because the whole file is probed first.
- A run over the frame budget fails with a budget error ("select a lower FPS"); the tool never silently changes the
  FPS you chose.
- HDR sources (PQ or HLG transfer) are refused until you convert them to SDR, so the evidence is never silently
  wrong in color.
- An empty file and a movie with no index ("moov atom not found", a recording that did not finish) are refused by
  name.

`encode`, `shrink` and `stream` have none of these limits: a 108 min talk is a normal input.

### shrink: let the tool pick the settings

```sh
tools video shrink ./talk.mp4 --to 400MB              # measure, show, ask, encode, check
tools video shrink ./talk.mp4 --to 400MB --compare    # also write and open a 2x2 comparison video
tools video shrink ./talk.mp4 --to 400MB --yes        # take the recommendation without asking
tools video shrink ./talk.mp4 --preview-only --json   # only the measurements
```

`tools video shrink <file>` does what otherwise takes an evening of ffmpeg runs:

1. **Plan.** It reads the file, works out the video bitrate a `--to` size leaves, and picks the picture height
   (`--height auto`): the tallest standard height (2160, 1440, 1080, 720, 540, 480, 360) that still gets 0.015 bits
   per pixel. Then it measures that height against one step taller with x264 on the hardest and the median window,
   and keeps the better one. A 108 min 1080p talk at 400 MB gets 0.007 at 1080p and 0.017 at 720p, so it goes to
   720p, which also scored higher at the same size. With `--audio auto`, audio is re-encoded to AAC 96 kbit/s when
   every track runs above 96 kbit/s (a track with no
   recorded rate counts as 128) and the copied audio would take more than 15% of the target. This gives the video
   about 30 kbit/s more. A target that leaves the
   video under 80 kbit/s is refused: pick a larger `--to`.
2. **Sample.** From the source's own packet sizes it finds the hardest, a median and the easiest 10 s (`--window`).
   It keeps away from the first and last 5% when the video is longer than four windows, and cuts each window as a
   lossless reference.
3. **Preview.** Each preset (`fast`, `compatible`, `small`) encodes each window at the share of the target a
   two-pass encode would give it: the average rate times the window's source rate over the file's, to the power
   0.6, kept between a quarter and four times the average. So the hardest stretch of a talk gets about 1.8 times
   the average. A window that lands outside 75% to 110% of its planned size is encoded again at a corrected rate,
   at most twice. Each result is scored against its reference with VMAF and SSIM (the encode scaled back with
   bicubic, the same for every preset). The table shows the mean and the worst window, the predicted size (marked
   "over" when it misses the target) and the predicted encode time. VMAF 95 and above is hard to tell from the
   source, 90 is good, and under 80 shows artifacts.
4. **Recommend.** The best score wins, but a faster preset within 1 VMAF point takes its place, and `small` (AV1)
   must lead by 1.5 points, since AV1 plays in fewer places. Without libvmaf it ranks by SSIM in decibels. A preset
   marked over (predicted above about 110% of `--to`) is not recommended while another preset fits, and the reason
   names it ("cannot reach the size").
5. **Compare** (`--compare`). The hardest window as a 2x2 video beside the input: the source, then each preset, left
   to right and top to bottom, each cell at most 720 px tall. It is `<name>.compare.mp4`, or `<name>.compare-2.mp4`
   and so on when that name is taken (it never writes over a file). On macOS in a terminal it opens in the default
   player.
6. **Encode.** A picker in a terminal (the recommendation first, and "None, stop here"), `--yes`, or `--preset`. The
   encode is `tools video encode` with the size correction, progress and decode check described below, except that
   any saving is kept (there is no `--min-saving`).
7. **Check.** The result is scored on the same windows, next to the sample scores, so you see that the full encode
   kept what the preview promised. This check is advisory: a scoring failure does not undo the written result.

A preset is left out with a warning when this ffmpeg lacks its encoder, or when the input's container cannot hold
its codec (AV1 goes only into `.mp4` and `.mkv`).

- `--to <size>`: fit the whole file into this size (`400MB`, `1.5GB`; a bare number is MB). Without it, each preset
  uses its default quality, and `--height auto` keeps the source height.
- `--height <px|auto|source>`: `auto` (default) as above, `source` keeps the height, or an even number of pixels,
  144 or more (`720` and `720p` both work).
- `--audio <mode>`: `auto` (default), `copy`, or an AAC bitrate in kbit/s.
- `--preset [name]`: preview and encode only this preset. A bare `--preset` offers the names.
- `--window <seconds>`: length of each sample window, 2 to 120. Default 10.
- `--yes`: encode the recommended preset without asking.
- `--preview-only`: show the comparison and stop.
- `--no-preview`: skip the sample encodes. It needs `--preset` or `--yes`, and `--yes` then takes `compatible`.
- `--compare`: write the 2x2 comparison video.
- `--replace`: put the result at the original path; the original goes to the GenesisTools trash, with the same rules
  as `encode --replace`.
- `--progress`: text output always shows the final encode's progress (a bar in a terminal, a plain line per 10%
  otherwise). With `--format json`, `--progress` adds JSON progress lines on stderr; with `jsonl` it adds progress
  events on stdout. (The `--help` line says "JSON lines otherwise"; that is only true for json and jsonl.)
- `--format text|json|jsonl`, `--json`: `json` prints one report at the end; `jsonl` streams the plan, every window
  score and the result as lines.

Without a terminal and without `--yes` or `--preset`, `shrink` measures, encodes nothing, and prints the `--yes`
command. The samples live in a temporary folder (`genesis-shrink-*` in the system temp folder) that is removed when
the run ends; after a failure it stays, and the error names it.

### encode: re-encode in bulk

```sh
tools video encode ./clips --dry-run
tools video encode ./a.mp4 ./b.mov --replace --json
tools video encode ./talk.mp4 --preset compatible --height 720 --target-size 400MB --progress
```

`tools video encode <paths...>` shrinks videos. By default it uses the hardware encoder (HEVC through VideoToolbox,
macOS only), which keeps the CPU free: three jobs use about 28% of one core in total, against about 550% for libx265.
Folders are walked for the containers the encoder can write: `.mp4`, `.m4v`, `.mov` and `.mkv`, but only `.mp4` and
`.mkv` for av1. A `.mov` or `.m4v` inside a folder is then not listed; a file named directly gets the skip reason. The
output keeps the input's container. Before it starts,
the command checks that this ffmpeg has the chosen encoder (`ffmpeg -encoders`) and stops with the reason if not.

Presets, measured on a 10 s clip of a 720p talk recording at 420 kbit/s (2026-11-02, SSIM against the source):

- `fast`: `hevc`, the GPU, with a 20 s GOP and two B-frames. Under a size target, no frame is coarser than QP 36 (loosened on each size
  correction). SSIM 0.982. Fastest and
  almost no CPU, but visibly softer at low bitrates. Plays on Apple devices and most TVs.
- `compatible`: `x264` slow, two passes for a size target. SSIM 0.993. Plays everywhere, Drive preview included; on
  that clip it took about a third of the time x265 took. (`--codec x265` uses preset medium: slow cost 2.4 to 2.6
  times the time for no gain.)
- `small`: `av1`, SVT-AV1 preset 5. SSIM 0.995, the best per byte; older devices may not decode AV1.

Flags and defaults:

- `--preset [name]`: `fast`, `compatible` or `small`. It picks the encoder, so it cannot be combined with `--codec`.
- `--codec [name]`: `hevc` (default), `x264`, `x265` or `av1`. A bare `--codec` (or a bare `--preset`) lists the
  values, as a picker in a terminal. Encoders are a table in `src/utils/video/reencode.ts`, each with its own rate,
  scale and two-pass flags.
- `--quality <n>`: in the encoder's own scale, ignored with `--target-size`. `hevc`: 0 to 100, higher is better,
  default 58 (SSIM against libx265 crf 26 was equal or better on three clips; 50 is visibly lower). `x264`/`x265`:
  CRF 0 to 51, lower is better, default 23/26. `av1`: CRF 1 to 63, default 35.
- `--jobs <n>`: files encoded at once. Default 2: the hardware encoder has few sessions.
- `--min-saving <percent>`: default 25. A smaller saving discards the output.
- `--target-size <size>`: aim each output at this size (`400MB`, `1.5GB`, a bare number is MB) instead of
  `--quality`. The video gets the target minus the audio and a 1% container share; a target that leaves under
  80 kbit/s skips the file. With any encoder, a result outside 90% to 103% of the target is encoded again at a corrected rate, at
  most twice. VideoToolbox misses an average bitrate and needs this most. Each correction also loosens the GPU encoder's QP cap (36,
  then 42, then none), because the cap is a size floor too: on the hardest minute of a talk, `-b:v 300k` gave
  1234 kbit/s at QP 36, 783 at 42 and 498 with no cap. x264 and x265 use two passes, which land within a
  few percent, so they rarely need it. An input already in the target codec is a candidate too. A bitrate cap (`-maxrate`) is not used: on
  VideoToolbox it starved the picture (SSIM 0.859).
- `--height <px>`: scale a taller video down to this height (even, 144 or more), with Lanczos on the CPU for every
  encoder. `hevc` still decodes and encodes on the GPU. The GPU scaler (`scale_vt`) was dropped: at the same bitrate
  it scored VMAF 76.7 against 90.1 for Lanczos, for 0.6 s less CPU per 10 s of 1080p.
- `--audio <mode>`: `auto` (default; copy, but AAC 96 kbit/s when every track is above 96 kbit/s and copied audio
  would take over 15% of `--target-size`), `copy`, or an AAC bitrate from 16 to 512 kbit/s (`96`, `128k`).
- `--progress`: report each encode while it runs, from ffmpeg's `-progress` output. In a terminal it is a clack bar;
  without one, a line per 10%. With `--format json` the progress events are JSON lines on stderr and stdout stays one
  document; with `--format jsonl` stdout carries `{"type":"progress",...}` lines and a `{"type":"row",...}` line for
  each file as soon as it is finished.
- `--format text|json|jsonl`: text (the table, the default), json (all rows at the end; `--json` is the same), or
  jsonl.
- `--dry-run`: lists each file with its size and skip reason (status `planned` for a file it would encode), writes
  nothing.
- `--replace`: the result takes the original path; the original goes to the GenesisTools trash and the batch id is
  printed. See "Replace and undo" below. Without it the result is `<name>.<codec>.<ext>` beside the input
  (`talk.hevc.mp4`, `talk.x264.mp4`).
- `--json`: one row per file (`input`, `output`, `inputBytes`, `outputBytes`, `saving`, `kept`, `status`, `reason`,
  `trashBatch`, `seconds`).

Skipped with a reason: files already in the target codec (unless a size target, a smaller height or an audio change
asks for work), files with a track the encode does not carry over (a data track like an iPhone `.MOV`'s `mebx`
metadata, a subtitle, a second video, a cover picture, an attachment), files ffprobe reads and rejects as not a
video, containers that cannot hold the codec (AV1 takes only `.mp4` and `.mkv`), earlier `.<codec>` outputs, and a
file whose output name is already taken. The encode keeps the first playable video (`0:V:0`, never a cover picture)
and every audio track.

A result is kept only when it is at least `--min-saving` smaller, its duration is within 0.5 s of the input, its video
is in the target codec, it has every audio track the input had, and a full decode (`ffmpeg -v error -xerror`, on the
GPU for `hevc`) of the video and every audio track prints nothing. Otherwise the output is discarded and the input
stays. The original's device, inode, size and modification time are read before the probe; a result is installed
only while the original still matches them, so an edit during the encode, or another run's replace, discards the
result and the original is never trashed for a stale encode. Each ffmpeg (the encoder check, the encode and the
decode check) runs under `nice -n 10`; background QoS (`taskpolicy -b`) starved the jobs on a loaded Mac, so it is
not used.

Each encode is written into a new hidden folder beside its input (`.<name>.<ext>.<codec>-XXXXXX`), which only that
run uses and removes when it finishes. The folder walk skips hidden folders, ffmpeg runs with `-n` so it never writes
over a file, and the result takes its final name only when nothing is there yet. Two runs on the same folder therefore
never touch each other's files.

The command exits 1 when any file failed (ffmpeg, the replace, a probe that could not run: no ffprobe, a timeout,
a file this process cannot read, or a file that was gone when its turn came); skipped and discarded files exit 0. A
failed file never stops the others: every file gets its row.

#### Replace and undo

- A person at a terminal replaces as asked.
- An agent may not replace a file that the `tools rm` rules mark "ask": the verified result stays beside it as
  `<name>.<codec>.<ext>` (status `kept-beside`), and the summary prints the `tools rm <originals>` command a person
  runs to finish.
- A "deny" verdict stops everyone.
- When the trash move or the install fails after the original moved, the original is put back and the row is
  `failed`. If that also fails, the row keeps its `trashBatch` and the summary prints the `tools rm restore <batch>`
  command.

`tools rm restore <batch>` alone refuses after a replace, because the new file sits at the original path. The summary
prints one line that undoes it after every replace (the sibling name follows the codec):

```sh
mv -n ./a.mp4 ./a.hevc.mp4 && test ! -e ./a.mp4 && tools rm restore <batch>
```

`mv -n` never writes over an `a.hevc.mp4` that is already there, and since it exits 0 when it skips, the `test`
lets the restore run only when the original path is free.

### stream download: save a broadcast

```sh
tools video stream download ./page.har --list
tools video stream download ./page.har --stream 1 --out talk.mp4
tools video stream download https://cdn.example.com/live/abc123/master.m3u8 --header "Referer: https://example.com/"
tools video stream download --out talk.mp4 --stitch-only
```

`tools video stream download [source]` takes a HAR file (DevTools, Network, "Save all as HAR"), a playlist URL, or
`--chrome-cdp <page url>`. It finds the HLS playlists in the HAR, replays their `Referer`, `Origin`, `User-Agent`,
`Accept-Language`, `Cookie` and `Authorization` headers (a fallback browser `User-Agent` is added when none was
captured), and downloads every segment until the stream ends. Then it stitches them into
`--out`.

Flags and defaults:

- `--out <file>`: the output file. A `.ts` output is the segments concatenated; any other container goes through
  `ffmpeg -c copy`. Default: a name from the page and the playlist's folder, so `https://example.com/watch/2` with
  `/live/abc123/master.m3u8` becomes `example-com-watch-2-abc123.mp4`. A platform recording defaults to
  `<page>-<title>-<event id>.mp4`.
- `--quality <value>`: `best` (default), `worst`, or a height such as `720`, for the variant of a master playlist.
  A resume without it keeps the quality the parts were downloaded at.
- `--stream <n|id>`: which source: its number or its `[--stream id]` in `--list`, or a part of a playlist URL.
- `--header <line>`: an extra request header `"Name: value"`; repeat it for more.
- `--jobs <n>`: segments downloaded at once. Default 6.
- `--idle-timeout <seconds>`: treat a live stream as ended after this long with no new segment. Default 120.
- `--no-backfill`: start at the live window instead of the oldest segment the CDN keeps.
- `--stitch-only`: download nothing; stitch the segments already in `<out>.parts`.
- `--list`: list the sources the HAR leads to, each checked now, and exit. It needs a HAR or `--chrome-cdp`.
- `--chrome-cdp <page url>`, `--chrome-cdp-port <n>`, `--chrome-cdp-wait <seconds>` (default 30): record the page in
  your own browser instead of reading a HAR. See below.
- `--wait-recording [minutes]`: wait for the platform's recording while the broadcast is live or the recording is
  not made yet, asking every minute. Default 240 minutes. Picking a recording that is not made yet (in the picker,
  or with `--stream recording-<id>`) waits for it the same way. It is ignored with `--stream` or `--from-stream`.
- `--from-stream`: never take the platform's recording; offer only the HLS streams.
- `--keep-parts`: keep `<out>.parts` after a complete download.
- `--json`: print the result as JSON.

How the download works:

- **From the start.** A live playlist lists only the last few segments, but a CDN often keeps older ones. When the
  segment names carry their sequence number, the tool finds the oldest one the CDN still serves (a binary search) and
  downloads from there. `--no-backfill` starts at the live window.
- **Until the end.** It re-reads the playlist every target duration. It stops at `#EXT-X-ENDLIST`, after three 404 or
  410 answers in a row for the playlist, or after `--idle-timeout` seconds without a new segment.
- **Retries.** Each segment gets four attempts with a 120 s timeout each. A segment that still fails (not a 404 or
  410: a network error, a 403, a 5xx) stops the stitch: the tool exits 1 and prints the command that retries it, and
  the command that stitches without it. Segments that failed all four attempts get one more try at the end of the run.
- **Resume.** Segments go to `<out>.parts/` (written to `.part`, then renamed, so a killed run leaves no half
  segment). Run the same command again: it skips what is on disk, downloads the rest, and stitches again. Segments
  the CDN answered 404 or 410 for are asked for once more. Without a source it resumes from `<out>.parts/state.json`.
  A parts folder that holds another stream is refused: pass another `--out` or the same `--quality` as before.
  When the playlist itself is gone (404 or 410), a resume fills the gaps between the first and last segments on disk from the saved
  segment-name template, then stitches. `--stitch-only` stitches what is there. Ctrl-C stops, keeps the parts, prints
  the resume command, and exits 130.
- **Stitch.** Segments the CDN had already deleted are reported as gaps. A stream that may still be live is reported
  with the command that downloads the rest.
- **Cleanup.** Once the stream has ended and every segment is in the output, the parts folder goes to the `tools rm`
  trash, and the run prints the `tools rm restore <batch>` command. The trash keeps it for the `tools rm` setting
  `grace-other` (60 minutes by default) before it is deleted. A stopped, live or incomplete download keeps the folder
  for a resume, and `--keep-parts` always keeps it. (The `--keep-parts` help line says 10 minutes; the code uses the
  `grace-other` setting.)
- **Not supported:** encrypted segments, byte-range playlists, and audio in a separate playlist (for that one the
  error suggests yt-dlp on the master playlist URL).

`state.json` holds the replayed headers, cookies included, so it is written with mode 600.

#### Pick the source: the platform's recording, the page's replay, or the live stream

```sh
tools video stream download ./page.har --list               # every source, each checked now, with its --stream id
tools video stream download ./page.har                      # a terminal asks which one; the best is first
tools video stream download ./page.har --stream abc123      # a source by its id (or its number in --list)
tools video stream download ./page.har --wait-recording     # wait (up to 240 min) for the platform's recording
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

`--list` shows each source with its length and height. A stream's id is its playlist's folder name; a recording's id
is `recording-<event id>`. Without `--stream`, a terminal asks which one, with the best first: a recording, then
finished streams (longest first), then live ones, then a recording still to wait for. Without a terminal the best one
is taken (`--json` also skips the picker), except a recording that is not made yet: then it exits 1 and prints the
commands that wait for it or take
a stream now. `--from-stream` offers only the HLS streams. The printed resume command keeps `--stream` and
`--quality`. When `--wait-recording` runs out of time, or the platform says there will be no recording, it exits 1;
a timeout also prints the command that waits longer, and both print the `--list` command.

The player's session in a HAR lasts about a month. After that the API answers 401, and a fresh HAR is needed.

`--chrome-cdp <page url>` records the HAR in your own browser instead of DevTools. It reloads the tab that has the page
open, or opens a tab and closes it afterwards, and records the page and its embedded players (they run in their own
process, so each one is attached separately). It stops when playlists and player answers stop coming, or after
`--chrome-cdp-wait` seconds (30). The HAR is saved as `~/.genesis-tools/video/captures/<time>-<page>.har` (mode 600),
and the messages print the path, so a later run can read it. A capture also offers the platform recordings of earlier
captures of the same page, since the page no longer loads that player once it shows the replay. The browser needs a
debug port: `--chrome-cdp-port`, else the browser that has the page open, else 9222 (`tools chrome-devtools restart
--browser brave --port 9222` turns it on).

Credentials stay with their origin: the cookies and the Authorization header of a HAR go only to the origin of the
playlist they were captured for, never to another host a playlist points at.

A new platform is one file in `stream/providers/` that implements `StreamProvider` (find its answers in a HAR, ask the
API now) and one entry in `STREAM_PROVIDERS`.

## How it works

Where data lives:

- `~/.genesis-tools/video/evidence/<id>/`: `frames` generations (the default `--out`), each with `manifest.json`.
- `~/.genesis-tools/video/captures/`: HAR files from `--chrome-cdp`, mode 600, since they hold the browser's cookies
  and tokens. Nothing removes old captures or old generations; delete them with `tools rm` when you are done.
- Beside a stream output: `<out>.parts/` (segments and `state.json`, mode 600) and `<out>.part` (a recording
  download in progress).
- Beside an encode input: the hidden `.<name>.<ext>.<codec>-XXXXXX/` work folder while it runs, then
  `<name>.<codec>.<ext>`, or the original path with `--replace`.
- Beside a shrink input: the result as `<name>.<codec>.<ext>` (or the original path with `--replace`), and
  `<name>.compare.mp4` with `--compare`. The samples are in the system temp folder.

What it calls:

- `ffprobe` and `ffmpeg` for everything. The encoders are `hevc_videotoolbox` (macOS only), `libx264`, `libx265` and
  `libsvtav1`; scores need the `libvmaf` filter (without it, SSIM only). Check what your ffmpeg has with
  `ffmpeg -encoders` and `ffmpeg -filters`.
- The `tools rm` trash for `--replace` originals and finished parts folders.
- Your Chromium browser over its DevTools debug port for `--chrome-cdp`.
- The CDN and, for StreamYard, the platform's public webinar API, with the headers from the HAR. Nothing else goes
  over the network, and nothing costs money.

## For agents

- `probe` and `frames` print one JSON document. The `frames` manifest has `version`, `createdAt`, `id`, `source` (the probe fields plus
  `sha256`), `settings`, `frames` (`id`, `requestedUs`, `actualUs`, `sourceIndex`, `path`, `kept`, `differencePct`, `comparedToId`),
  `sheets` (`path`, `frameIds`, `firstUs`, `lastUs`, `columns`, `rows`, `tileWidth`, `tileHeight`, `scale`), `counts` and `manifestPath`.
- `encode --format json|jsonl` and `shrink --format json|jsonl` are made for parsing; `stream download --json` prints
  the result, and `--list --json` lists the sources without their headers.
- Exit codes: `encode` exits 0 even when rows are skipped or discarded, and 1 when any row failed. `shrink` exits 1
  when its result was not written ("The encode did not finish: <reason>") or when "No preset can encode this file on
  this machine". Other failures and usage errors exit 1; Ctrl-C exits 130. A stream or recording stopped with Ctrl-C
  keeps what it downloaded.
- Without a terminal, `shrink` needs `--yes` or `--preset` to encode, and `stream download` takes the best source
  (or exits 1 while that is a recording not made yet).
- `--replace` from an agent leaves a file the rm rules mark "ask" in place and keeps the result beside it.
- The `macos-control` skill uses `probe` and `frames` to review screen recordings:
  [video-review.md](../../plugins/genesis-tools/skills/macos-control/references/video-review.md) and
  [capturing-animations.md](../../plugins/genesis-tools/skills/macos-control/references/capturing-animations.md).

## Troubleshooting

- **"Cannot encode: this ffmpeg has no ... encoder".** Your ffmpeg build lacks that encoder. Install an ffmpeg that
  has it, or pick another `--codec` or `--preset`. `hevc` runs only on macOS.
- **A shrink table without VMAF ("no libvmaf").** This ffmpeg has no `libvmaf` filter, so the ranking uses SSIM in
  decibels.
- **"the size target leaves N kbit/s for the video, below 80".** The target is too small for the length. Pick a
  larger `--to` or `--target-size`.
- **"Video exceeds the 10-minute or 48-megapixel limit", "HDR evidence needs an explicit SDR conversion".** These are
  the `frames` limits. Export a shorter or an SDR copy first.
- **"is not a movie ffprobe can read (moov atom not found)".** The recording did not finish, so it has no index.
- **The stream API answers 401.** The HAR's player session (about a month) expired. Save a fresh HAR or use
  `--chrome-cdp`.
- **"No source is ready to download".** The best source is a recording that is not made yet. Wait with
  `--wait-recording`, or take a stream now with `--stream <id>`.
- **`--chrome-cdp` cannot connect.** The browser has no debug port. Run `tools chrome-devtools restart --browser
  brave --port 9222` (or your browser), then try again.
- **Segments still fail after the retries.** Rerun the printed command to retry them, or stitch without them with
  `--stitch-only`.

## Related

- [tools recorder](../recorder/README.md): record the screen into a movie to review with `frames`.
- [tools chrome-devtools](../chrome-devtools/README.md): the browser debug port that `--chrome-cdp` needs.
- [tools har-analyzer](../har-analyzer/README.md): read a HAR file before you download from it.
- [tools rm](../rm/README.md): the trash behind `--replace` and the parts cleanup, and `tools rm restore`.
