# Voice

A reusable transcription session over the toolkit's existing signed microphone capture and live STT providers.
It has no Eve or computer-control dependency.

~~~sh
tools voice listen --input mic --provider xai --language cs,en --json
tools voice listen --input recording.s16le --provider deepgram --json
tools voice listen --input none --provider fixture --events-file events.json --json
~~~

Input files are signed 16-bit little-endian mono PCM at 16 kHz. Use tools transcribe for encoded audio files.
Provider/account/model options use the existing AI account configuration. The grok-live alias means xAI
speech transcription, not a duplex assistant.

JSONL emits state, level, partial/final transcript, error and complete events. Stop keeps finalized text.
A session has a maximum duration and a bounded finalization period. For a native owner, --stop-on-stdin
ends recording when that owner closes its input pipe. --capsule adds the existing visual sink optionally.
