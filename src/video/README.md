# Video evidence

Probe a local video or prepare PNG contact sheets with full-resolution source frames:

~~~sh
tools video probe ./demo.mp4 --json
tools video frames ./demo.mp4 --fps 2 --frames-per-image 16 --difference 0 --out ./evidence --json
tools video frames ./demo.mp4 --start 2.1 --end 5.4 --fps 4 --frames-per-image 8 --json
~~~

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
