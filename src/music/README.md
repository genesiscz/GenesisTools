# Music from code

Make reproducible background music offline with FluidSynth, a pinned SoundFont and ffmpeg. Scores are ordinary
validated data. Rendering masters by integrated LUFS; fades, end alignment and effects ducking belong to the movie mix.

## Setup

Install FluidSynth and ffmpeg, then explicitly download the pinned sample asset:

~~~sh
brew install fluid-synth ffmpeg
tools music soundfont install
tools music soundfont show
~~~

The pinned asset is S. Christian Collins's GeneralUser GS 2.0.3 at source commit
684543d5e5efaef08d02be50dcda8d552478fa60. The installer verifies both files against these SHA-256 values:

- SF2: 9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe
- Full license: 7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be

Both live outside the repository at `~/.genesis-tools/music/soundfonts/GeneralUser-GS-2.0.3/`, named
`GeneralUser-GS.sf2` and `LICENSE.txt`. `GENESIS_TOOLS_HOME` replaces the home directory, so that override stores
them under `<GENESIS_TOOLS_HOME>/.genesis-tools/music/soundfonts/GeneralUser-GS-2.0.3/`. `soundfont show` prints the
resolved paths. `render --soundfont <file>` selects an explicit sample bank instead of the cache.
Rendering never downloads an asset. The installer makes a network request only when explicitly invoked.
Reinstallation stages both verified files and replaces each by rename, so readers never see a partial SoundFont.
show and measure only read.

The [author's license](https://github.com/mrbumpy409/GeneralUser-GS/blob/684543d5e5efaef08d02be50dcda8d552478fa60/documentation/LICENSE.txt)
permits private and commercial music creation and software use. It also records incomplete historical provenance
for some contained samples. The full license remains beside the cached asset. The SoundFont is not bundled in git.
FluidSynth itself is LGPL-2.1; the SoundFont has its own GeneralUser GS License v2.0.

The locally verified toolchain is FluidSynth 2.6.2 and ffmpeg 9.0.2. Every render prints the actual versions and input
hashes. Keep that toolchain and asset unchanged when comparing output hashes. Equal bytes across other versions,
architectures or builds are not promised. No audio device, GUI, provider key or paid model is used for rendering.

## Render and measure

~~~sh
tools music list
tools music render PulseLight --out out/pulse-light.m4a
tools music render Pulse --out out/pulse.m4a
tools music render Piano --out out/piano.wav
tools music measure out/pulse-light.m4a
~~~

PulseLight has no drums; Pulse adds the soft kit. Calm and Piano preserve the two shelved Kalendora compositions
as source. The MIDI adapter preserves notes and timing while using sampled GM instruments. The original noise
riser becomes a sampled reverse-cymbal swell. These are new instrument voicings, not a claim to reproduce the old
additive synth's timbre.

Defaults are -20 LUFS and a -3 dBTP ceiling, configurable with --lufs and --peak. The gain is derived from measured
integrated loudness, never peak normalization. A score whose crest factor cannot meet both limits is refused with
an instruction to lower its loudest instrument. The encoded output is measured again before publication.

The result is JSON with integrated LUFS, true peak, SHA-256 and low/mid/high band RMS in dBFS. Band boundaries are
110 Hz and 2 kHz, with ffmpeg's default low/high-pass slopes. They are broad energy proxies, not brick-wall spectral
bins or listening judgments. A null RMS means the band is silent. Pure silence or a file too short for EBU R128
measurement is refused rather than reported as a valid loudness target.

Every render also prints the score hash, SoundFont hash and renderer/encoder versions. Save that JSON alongside a
build when you need its provenance. Music contains its composed duration and ending, but no movie-dependent fades.

## Edit a score as data

~~~sh
tools music score PulseLight > score.json
tools music render --score score.json --out out/custom.m4a
~~~

A score has key, title, bpm, seconds, end and parts. Each part has a source, volume, pan and notes. A SoundFont
source has a GM program number from 0 to 127 and a percussion flag. A score file written before 2026-11-15 holds
program and percussion flat on the part; it still loads, and is read as a SoundFont source. Each note has at and duration in seconds, a MIDI pitch and velocity. end is the written
ending that the mix aligns, and must fit inside seconds. Notes cannot extend past the score. Program numbers are
zero-based. Each part has an independent MIDI channel for volume and pan. The first percussion part uses channel 10;
additional drum parts use XG bank selection on separate channels. FluidSynth 2.3.5 or newer is required.

An explicit --soundfont file may select another sample bank. Its hash is printed, and its license remains the
caller's responsibility. The default cached asset always receives the pinned file and license checks.

## Synth parts, effects and a loud master

~~~sh
tools music presets                 # kick, snare, hat, sub, reese, stab, pad, voice, pluck, sweep, impact ...
tools music presets reese           # one preset as an editable patch
tools music render Orbit --out out/orbit.m4a
tools music score Orbit > orbit.json
~~~

A part source is one of three kinds. `{ "kind": "soundfont", "program": 0, "percussion": false }` plays the sample
bank. `{ "kind": "synth", "patch": "reese" }` plays the built-in synthesizer, with a preset name or a whole patch:
oscillators (sine, triangle, saw, square, noise) with unison, detune, a pitch drop and phase modulation, an
envelope, a filter (low, high, band, notch or vowel) with its own envelope, LFOs, mono glide and drive.

`{ "kind": "sample", "file": "break.wav", "mode": "slices", "slices": 16, "speed": 1.24 }` plays an audio file
you own. Mode `hit` plays the whole file for each note. Mode `pitched` moves its speed with the note around `root`.
Mode `slices` cuts it in equal parts, and note 36 plays the first part, 37 the second. `speed` fits a loop to the
score tempo (score bpm divided by loop bpm). `file` is a path to your own audio, or the name of an installed sample.

~~~sh
tools music samples install         # 320 CC0 drum files, 47 MB, each checked against its SHA-256
tools music samples list            # the sets and how many files are on disk
tools music samples list sonic-pi   # the names a score can use, such as sonic-pi/bd_tek.flac
~~~

The two sets are the Sonic Pi samples (commit aa0c8e9, 204 FLAC files) and a TR-808 set (tidalcycles
sounds-tr808-fischer, commit 85fbecf, 116 WAV files). Both repositories state CC0 1.0 for their samples; the
license links are in the `list` output. The two Amen break cuts of the Sonic Pi set are left out, because no source
shows that the original recording was cleared. The files live under `~/.genesis-tools/music/samples/`, never in
git. Rendering never downloads; a score that names a missing sample fails with the install command.

Each part may carry `effects`, applied in this order: highpass, lowpass, eq, drive, crush, compressor, delay,
width and monoBelow, duck, gain. `duck` pulls the part down at every note start of the parts it names, which is
the sidechain pump of dance music. `reverb` is the send level into the one shared `room` of the score. `lanes`
move a parameter over score time: cutoff, pitch, vowel, fm and lfoRate on a synth part, and level, lowpass and
highpass on any part.

A score that only names SoundFont programs renders in one FluidSynth pass, byte for byte as before. Any synth
part, effect, lane or room switches the render to stems: one FluidSynth pass per SoundFont part, the synth parts
in Bun, then one mix. A stem score may hold 32 parts. A synth render repeats sample for sample.

`master` sets the loudness of a score: `{ "lufs": -9, "peak": -1, "limiter": true, "clip": 3 }`. With the
limiter, a soft clipper and a look-ahead limiter bring the mix to the target, so a loud track is not refused for
its crest factor. `--lufs` and `--peak` win over the score, and the range now ends at -6 LUFS. AAC lifts the
peaks of limited audio. When an .m4a goes over the cap, the cap wins and the file ships a little under the
target; the printed measurement is the truth. A .wav has no such lift.

Orbit is an original drum and bass score at 174 BPM that uses all of this. Its basses, pads and leads are synthesized.
Its drums layer recorded hits from the Sonic Pi set over synthesized ones, so it needs `tools music samples install`.
The piano and the cymbals come from the sample bank.

## Mix under a video

~~~sh
tools music mix demo.mp4 --music out/pulse-light.m4a --end 91.5 --out demo-music.mp4
~~~

The four sampled built-in scores have a written end of 91.5 s and a file duration of 95 s. Orbit ends at 87.5 s
in a 89.5 s file. A shorter movie trims the track's
opening; a longer movie delays the track with silence. The written ending lands at the movie ending. --end takes
the score's end, not its file duration.

The mix copies the video stream, keeps the original sound, applies music gain 0.6, fades in over 1.5 s and out over
3 s, ducks under the video's actual sound with a sidechain compressor, and limits the final sum. Gain 0.6 moves a
-20 LUFS track to about -24.4 LUFS before fades/ducking. The complete movie's loudness also includes its original
sound; use measure on the resulting movie. A silent source video gets a finite silent effects channel.

All mix choices are options: --volume, --fade-in, --fade-out, --no-duck, --threshold, --ratio, --attack-ms and
--release-ms. Setting both fades to zero is supported. Only the first source audio stream is mixed. The output is
MP4 with AAC audio. Recorder editor music, transcript ducking and voiceover ducking remain available independently.
The selected video stream must report a positive duration. A container duration alone may include a longer audio
tail, so inputs without a measured picture duration are refused before mixing. Remux such inputs first.

Outputs refuse replacement by default. --overwrite publishes only a fully rendered and checked replacement. Input
videos/music cannot be the mix output. Failed rendering leaves any previous output intact.

## Listen to variants and synthesize taps

~~~sh
tools music audition out/pulse-light.m4a out/pulse.m4a out/piano.wav --out out/compare.m4a
open -a VLC out/compare.m4a
tools music tap --out out/tap.wav
tools music tap --all --out out/ten-taps.wav
~~~

audition takes a 24-second excerpt from 12 s inside each track, in argument order. --seconds and --start change
those choices. It does not normalize the variants against one another, so render them to the same LUFS target.

tap preserves all ten seeded Kalendora definitions and defaults to 09-down-up, the chosen press/release sound.
--all plays each three times in one reel. These short effects use their original peak scale; the long-form music
LUFS target is not applied to a 300 ms tap.

## Shared API and provenance

The library is @genesiscz/utils/music. Its main calls are builtinScore, encodeMidi, renderScore, measureAudio,
placeMusic, musicFilterGraph, mixMusic, auditionMusic, tapAudio and installSoundfont. Consumers call the library
directly when they need its logic; the CLI is a thin adapter.

The four compositions and ten tap definitions originate from
[Kalendora's pushed music branch](https://github.com/arwen96/Kalendora/tree/481f90467dafdc609cfc834993855299b7410f94/video/scripts).
Copied source carries the exact source path, timestamp and commit header. Runtime rendering, MIDI encoding and the
shared mastering/mix implementation are owned here. Generated audio remains a build product outside git.

Ctrl-C or SIGTERM cancels owned child process groups and removes temporary audio before returning. A completed
replacement is published only while the operation remains active. Library callers can use
`withMusicSignal({ signal, run: () => renderScore(options) })` to apply the same cancellation scope.
