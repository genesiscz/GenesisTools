"""Generate one six-second frames recording. Usage: python3 make-editor-pictures.py NEW_FOLDER [--mute-system]."""

import argparse
import json
from pathlib import Path
import subprocess


def ffmpeg(folder, *args):
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-n", *args], cwd=folder, check=True, timeout=15)


def write_json(folder, filename, value):
    (folder / filename).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def make_recording(folder, muted):
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "frames").mkdir()
    (folder / "audio").mkdir()
    # Kept screen frames, a separate moving camera, and two sounds with visibly different envelopes.
    ffmpeg(folder, "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=1:duration=6",
           "-start_number", "0", "frames/frame-%02d.png")
    ffmpeg(folder, "-f", "lavfi", "-i", "smptebars=size=320x240:rate=24:duration=6",
           "-vf", "hue=h=30*t", "-c:v", "libx264", "-pix_fmt", "yuv420p", "camera.mov")
    ffmpeg(folder, "-f", "lavfi", "-i", "color=c=0x00788C:s=240x96",
           "-vf", "drawbox=x=18:y=18:w=60:h=60:color=white:t=6", "-frames:v", "1", "slate.png")
    lanes = []
    tracks = []
    for source, tone, period in [("mic", 220, 1.4), ("system", 660, 0.65)]:
        filename = f"audio/{source}.m4a"
        ffmpeg(folder, "-f", "lavfi", "-i", f"sine=frequency={tone}:duration=6",
               "-af", f"volume='if(lt(mod(t,{period}),0.4),0.7,0.05)':eval=frame", "-c:a", "aac", filename)
        lanes.append({"id": source, "source": source, "file": filename, "offsetMs": 0,
                      "volume": 1, "muted": muted and source == "system"})
        tracks.append({"source": source, "path": filename, "durationMs": 6000, "startOffsetMs": 0})
    ffmpeg(folder, "-framerate", "1", "-start_number", "0", "-i", "frames/frame-%02d.png",
           "-i", lanes[0]["file"], "-i", lanes[1]["file"], "-filter_complex", "[1:a][2:a]amix=inputs=2[mix]",
           "-map", "0:v", "-map", "[mix]", "-r", "24", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-movflags", "+faststart", "proxy.mp4")
    start = "2026-01-01T12:00:00.000Z"
    write_json(folder, "recording.json", {
        "version": 1, "id": folder.name, "title": "Storyboard", "startedAt": start,
        "endedAt": "2026-01-01T12:00:06.000Z", "displays": [{"id": 7, "name": "Studio Display"}],
        "settings": {"kind": "frames", "tracks": tracks}, "warnings": [],
        "frames": [{"file": f"frames/frame-{i:02}.png", "atMs": i * 1000, "displayId": 7,
                    "changePercent": 12 if i else 100, "reason": "change" if i else "first"} for i in range(6)],
    })
    write_json(folder, "camera.json", {"file": "camera.mov", "startedAt": start, "screenStartedAt": start})
    write_json(folder, "edit.json", {
        "version": 1, "revision": 0, "zooms": [],
        "source": {"video": str(folder / "proxy.mp4"), "recording": folder.name,
                   "durationUs": 6000000, "width": 960, "height": 540},
        "clips": [{"id": "c00000000", "fromUs": 0, "toUs": 6000000, "speed": 1}],
        "audio": {"include": True, "volume": 1, "mutedTracks": [], "lanes": lanes},
        "export": {"codec": "h264", "maxHeight": 0, "output": ""},
        "camera": {"file": "camera.mov", "shape": "circle", "corner": "custom", "x": 0.76, "y": 0.74, "size": 0.32},
        "layers": {"order": ["camera", "slate"], "media": [
            {"id": "slate", "name": "Title slate", "file": "slate.png", "kind": "image",
             "startUs": 500000, "endUs": 5500000, "x": 0.68, "y": 0.7, "width": 0.20}
        ]},
    })
    print(folder / "edit.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--mute-system", action="store_true")
    args = parser.parse_args()
    make_recording(args.folder.resolve(), args.mute_system)
