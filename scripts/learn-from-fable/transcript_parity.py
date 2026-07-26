#!/usr/bin/env python3
"""Python side of the transcript parity harness (see transcript-parity.ts)."""
import json, os, sys

# SkillOpt is the Python reference implementation this harness compares against.
# Point SKILLOPT_PATH at your checkout; nothing here assumes one machine's layout.
skillopt = os.environ.get("SKILLOPT_PATH")
if not skillopt:
    sys.exit("SKILLOPT_PATH is not set — point it at your SkillOpt checkout to run the parity harness.")

sys.path.insert(0, skillopt)
from skillopt.envs.fable_clone.transcript import load_turns, condense_for_extraction

out = {}
for f in sys.argv[1:]:
    turns = load_turns(f)
    out[f.rsplit("/", 1)[-1]] = {
        "turns": len(turns),
        "assistant": sum(t["role"] == "assistant" for t in turns),
        "user": sum(t["role"] == "user" for t in turns),
        "toolResult": sum(t["role"] == "tool_result" for t in turns),
        "fable": sum(t["role"] == "assistant" and t["is_fable"] for t in turns),
        "sidechain": sum(bool(t.get("is_sidechain")) for t in turns),
        "thinkingChars": sum(len(t["thinking"]) for t in turns),
        "toolCalls": sum(len(t["tools"]) for t in turns),
        "windows": len(condense_for_extraction(turns)),
    }
print(json.dumps(out, indent=2))
