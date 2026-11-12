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

Both live under the music tool's data folder, outside the repository. Rendering never downloads an asset. The
installer makes a network request only when explicitly invoked. show and measure only read.

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

A score has key, title, bpm, seconds, end and parts. Each part has a GM program number from 0 to 127, percussion,
volume, pan, and notes. Each note has at and duration in seconds, a MIDI pitch and velocity. end is the written
ending that the mix aligns, and must fit inside seconds. Notes cannot extend past the score. Program numbers are
zero-based. Each part has an independent MIDI channel for volume and pan. The first percussion part uses channel 10;
additional drum parts use XG bank selection on separate channels. FluidSynth 2.3.5 or newer is required.

An explicit --soundfont file may select another sample bank. Its hash is printed, and its license remains the
caller's responsibility. The default cached asset always receives the pinned file and license checks.

## Mix under a video

~~~sh
tools music mix demo.mp4 --music out/pulse-light.m4a --end 91.5 --out demo-music.mp4
~~~

All built-in scores have a written end of 91.5 s and a file duration of 95 s. A shorter movie trims the track's
opening; a longer movie delays the track with silence. The written ending lands at the movie ending. --end takes
the score's end, not its file duration.

The mix copies the video stream, keeps the original sound, applies music gain 0.6, fades in over 1.5 s and out over
3 s, ducks under the video's actual sound with a sidechain compressor, and limits the final sum. Gain 0.6 moves a
-20 LUFS track to about -24.4 LUFS before fades/ducking. The complete movie's loudness also includes its original
sound; use measure on the resulting movie. A silent source video gets a finite silent effects channel.

All mix choices are options: --volume, --fade-in, --fade-out, --no-duck, --threshold, --ratio, --attack-ms and
--release-ms. Setting both fades to zero is supported. Only the first source audio stream is mixed. The output is
MP4 with AAC audio. Recorder editor music, transcript ducking and voiceover ducking remain available independently.

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
