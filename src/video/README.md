# Video evidence

Probe a local video or prepare PNG contact sheets with full-resolution source frames:

~~~sh
tools video probe ./demo.mp4 --json
tools video frames ./demo.mp4 --fps 2 --frames-per-image 16 --difference 0 --out ./evidence --json
~~~

Requires ffmpeg and ffprobe. Silent videos work. FPS choices are 1–4; frames per image are 1, 4, 8, 16 or 32.
Each run publishes a new immutable generation directory with a manifest, sampled PNGs and sheets.

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
