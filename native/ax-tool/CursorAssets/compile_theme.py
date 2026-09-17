#!/usr/bin/env python3
"""Compile the pinned MIT Cua theme into bounded Core Animation tracks.

Input is the adjacent original dotLottie archive. No network or third-party runtime.
"""
import json
import math
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parent

def cubic(t, a, b):
    return 3 * (1-t)**2 * t * a + 3 * (1-t) * t*t * b + t*t*t

def sample(prop, frame):
    if not prop.get("a"):
        return prop["k"]
    keys = prop["k"]
    if frame < keys[0]["t"]:
        return keys[0]["s"]
    for i, key in enumerate(keys[:-1]):
        end = keys[i+1]
        if frame >= end["t"]:
            continue
        start_value = key["s"]
        end_value = key.get("e", end["s"])
        if key.get("h"):
            return start_value
        progress = (frame-key["t"]) / (end["t"]-key["t"])
        out = key.get("o", {"x":[0], "y":[0]})
        incoming = key.get("i", {"x":[1], "y":[1]})
        lo, hi = 0., 1.
        for _ in range(24):
            mid = (lo+hi)/2
            if cubic(mid, out["x"][0], incoming["x"][0]) < progress:
                lo = mid
            else:
                hi = mid
        weight = cubic((lo+hi)/2, out["y"][0], incoming["y"][0])
        return [a+(b-a)*weight for a,b in zip(start_value,end_value)]
    return keys[-1]["s"]

def vector(value):
    return value if isinstance(value, list) else [value]

def track(prop, count):
    values = [[round(float(x), 5) for x in vector(sample(prop, frame))] for frame in range(count)]
    if all(row == values[0] for row in values):
        return [values[0]]
    return values

with ZipFile(root / "cua.default.lottie") as archive:
    manifest = json.loads(archive.read("cua/theme.json"))
    result = {"fps": 30, "hotspot": [55,30], "animations": {}}
    for action, metadata in manifest["actions"].items():
        source = json.loads(archive.read("a/"+metadata["animation"]+".json"))
        count = int(source["op"])
        assert source["w"] == source["h"] == 128 and source["fr"] == 30 and 0 < count <= 120
        layers = []
        for layer in reversed(source["layers"]):
            assert layer["ty"] == 4
            shapes, fill, stroke = [], None, None
            for shape in layer["shapes"]:
                kind = shape["ty"]
                if kind == "sh":
                    path = shape["ks"]["k"]
                    assert not shape["ks"]["a"]
                    shapes.append({"kind":"path", "vertices":path["v"], "incoming":path["i"], "outgoing":path["o"], "closed":path["c"]})
                elif kind in ("el", "rc"):
                    assert not shape["p"]["a"] and not shape["s"]["a"]
                    shapes.append({"kind":kind, "position":shape["p"]["k"], "size":shape["s"]["k"], "radius":shape.get("r",{}).get("k",0)})
                elif kind in ("fl", "st"):
                    paint = {"color":track(shape["c"],count), "opacity":track(shape["o"],count)}
                    if kind == "st":
                        paint["width"] = track(shape["w"],count)
                        stroke = paint
                    else:
                        fill = paint
                else:
                    assert kind == "tr", kind
            transforms = {name:track(layer["ks"][name],count) for name in ["a","p","s","r","o"]}
            layers.append({"shapes":shapes, "fill":fill, "stroke":stroke, "tracks":transforms})
        result["animations"][action] = {"frames":count, "still":metadata["still_frame"], "layers":layers}
    output = root.parent / "SnapshotSupport/Resources/CuaCursor.json"
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,separators=(",",":"))+"\n")
    print(str(output)+": "+str(output.stat().st_size)+" bytes")
