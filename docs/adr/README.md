# Architecture decisions

These records describe decisions from 2026-11-18. Accepted records document the agreed design. Proposed records
retain the outstanding choice or evidence condition. A superseded record links to its replacement.

## Meetings architecture

Plan `.claude/plans/2026-11-18-MeetingsArchitecture.md`.

| Number | Decision | Status | Date | Source |
| --- | --- | --- | --- | --- |
| 0001 | [Give term proposals their own module](0001-term-proposals.md) | Accepted | 2026-11-18 | P1A |
| 0002 | [Share the type of a proposed item](0002-new-item-type.md) | Accepted | 2026-11-18 | P1A |
| 0003 | [Move channel evidence rules behind one interface](0003-speaker-evidence.md) | Accepted | 2026-11-18 | P2A |
| 0004 | [Expose the speaker finding for each line](0004-per-line-speaker-evidence.md) | Accepted | 2026-11-18 | P3A |
| 0005 | [Evaluate voice seeds before departures and suggestions after them](0005-evidence-before-and-after-departure.md) | Accepted | 2026-11-18 | P3A |
| 0006 | [Separate question construction from answering](0006-question-answers.md) | Accepted | 2026-11-18 | P4A |
| 0007 | [Keep suggestion order visible in the pipeline](0007-suggestion-order.md) | Accepted | 2026-11-18 | Planner decisions |
| 0008 | [Stage module moves with temporary re-exports](0008-temporary-reexports.md) | Accepted | 2026-11-18 | P1A–P5A |
| 0009 | [Retire eligibility helpers after checking their callers](0009-retire-eligibility-helpers.md) | Accepted | 2026-11-18 | P5A |
| 0010 | [Choose when R3 takes ownership of speaker evidence](0010-when-to-move-evidence.md) | Accepted | 2026-11-18 | D1 / M28 |
| 0011 | [Choose whether to split the Meetings service contract](0011-service-contract-families.md) | Accepted | 2026-11-18 | D2 / M29 |
| 0012 | [Choose when to plan proof grades for speaker rules](0012-proof-grades.md) | Accepted | 2026-11-18 | D3 / M30 |

## Room and call presence

Plan `.claude/plans/2026-11-18-MeetingsRoomAndCallPresence.md`.

| Number | Decision | Status | Date | Source |
| --- | --- | --- | --- | --- |
| 0013 | [Track physical seats independently of call membership](0013-seat-timeline.md) | Accepted | 2026-11-18 | J1 / R1 |
| 0014 | [Ask one module who could have spoken a line](0014-speaker-eligibility.md) | Accepted | 2026-11-18 | J2 / R2–R3 |
| 0015 | [Use explicit mute counts as a seat editor hint](0015-mute-seat-hint.md) | Accepted | 2026-11-18 | J3 / R2 |
| 0016 | [Promote echo pairing on the evidence of one recording](0016-echo-pairing-promotion.md) | Superseded | 2026-11-18 | J4 / original t2 · `h_hxt7a56g:t2` |
| 0017 | [Require evidence across reference meetings before pairing echoes](0017-echo-pairing-evidence.md) | Proposed | 2026-11-18 | J4 / current t2 · `h_hxt7a56g:t2` |
| 0018 | [Infer a seat only from independent positive voice matches](0018-voice-seat-hints.md) | Accepted | 2026-11-18 | J5 / R4 |
| 0019 | [Rank shared-microphone speakers by positive evidence](0019-shared-mic-questions.md) | Accepted | 2026-11-18 | J6 / R3–R4 |
| 0020 | [Ask the owner to identify shared room devices](0020-shared-device-accounts.md) | Proposed | 2026-11-18 | J7 / current t3 · `h_hxt7a56g:t3` |
| 0021 | [Keep elimination review-only at every apply threshold](0021-elimination-review.md) | Accepted | 2026-11-18 | J8 / R3 |
| 0022 | [Plan all suggestion changes and apply them once](0022-suggestion-change-set.md) | Accepted | 2026-11-18 | J9 / R3 |
| 0023 | [Count speaker outcomes once per held-out line](0023-held-out-speaker-measure.md) | Accepted | 2026-11-18 | J10 / R5 |

## Voice library

Plan `.claude/plans/2026-11-18-MeetingsVoiceLibrary.md`.

| Number | Decision | Status | Date | Source |
| --- | --- | --- | --- | --- |
| 0024 | [Give the global voice library its own directory](0024-global-voice-store.md) | Accepted | 2026-11-18 | L1 / P1 |
| 0025 | [Publish a voice-library migration only at a write boundary](0025-voice-migration.md) | Accepted | 2026-11-18 | L1 / P1 |
| 0026 | [Keep original voice ownership through directory merges](0026-voice-owner-provenance.md) | Accepted | 2026-11-18 | L2 / P1 |
| 0027 | [Give samples immutable IDs and refusals a source-line key](0027-sample-and-source-identity.md) | Accepted | 2026-11-18 | L3 / P1–P3 |
| 0028 | [Route every permanent voice attachment through one locked insert](0028-checked-sample-insertion.md) | Accepted | 2026-11-18 | L4 / P2 |
| 0029 | [Use global prediction and explicit scope for voice corrections](0029-voice-prediction-scope.md) | Accepted | 2026-11-18 | L5 / owner D1 |
| 0030 | [Score voice outliers against independent compatible samples](0030-voice-quality.md) | Accepted | 2026-11-18 | L6 / P2 |
| 0031 | [Recover voice-learning jobs from active journal tokens](0031-journal-derived-learning-jobs.md) | Accepted | 2026-11-18 | L7 / P6 |
| 0032 | [Assign each shared file to one writer per joint wave](0032-joint-wave-ownership.md) | Accepted | 2026-11-18 | L8 / joint order |
| 0033 | [Follow the same sample from listing through correction and Undo](0033-voice-library-acceptance.md) | Accepted | 2026-11-18 | L9 / P3–P6 |
| 0034 | [Run voice naming again after a print is published](0034-repropose-after-publication.md) | Accepted | 2026-11-18 | P6 / owner amendment |

## Recorder control bar

Plan `.claude/plans/2026-11-18-RecorderControlBar.md` (handoff `h_d7yjj9aq`).

| Number | Decision | Status | Date | Source |
| --- | --- | --- | --- | --- |
| 0035 | [Use one control bar for the widget and full recorder](0035-one-recording-bar.md) | Accepted | 2026-11-18 | P1, P5–P7 |
| 0036 | [Separate choosing a recording target from starting a take](0036-choose-before-record.md) | Accepted | 2026-11-18 | P3, P6–P7 |
| 0037 | [Distinguish picking a target from recording it](0037-picker-accent-pulse.md) | Accepted | 2026-11-18 | P2 |
| 0038 | [Advertise camera changes only when the engine can apply them](0038-live-camera-capability.md) | Accepted | 2026-11-18 | P6 |
| 0039 | [Put area and click-to-pick selection in GenesisKit](0039-shared-target-picker.md) | Accepted | 2026-11-18 | P3, P5 |
| 0040 | [Exclude recorder controls and markers before capture starts](0040-exclude-recorder-panels.md) | Accepted | 2026-11-18 | P1, P2, P4 |

## Recording editor

Plan `.claude/plans/2026-11-18-RecordingEditorLayers.md` (handoff `h_5yvt1etb`).

| Number | Decision | Status | Date | Source |
| --- | --- | --- | --- | --- |
| 0041 | [Extend edit projects with optional fields at version 1](0041-compatible-edit-project.md) | Accepted | 2026-11-18 | P1, P3 |
| 0042 | [Refer to the camera by ID in the layer stack](0042-camera-layer-id.md) | Accepted | 2026-11-18 | P1, P3 |
| 0043 | [Play each recorded sound source once](0043-sound-lane-sources.md) | Accepted | 2026-11-18 | P1, P2, P4 |
| 0044 | [Apply sound-lane gain and mute to the whole edit](0044-whole-edit-sound-lanes.md) | Accepted | 2026-11-18 | P1, P4 |
| 0045 | [Draw the layer stack at the camera's existing position](0045-layer-render-order.md) | Accepted | 2026-11-18 | P1, P4 |
| 0046 | [Keep imported layer media with the recording](0046-recording-local-media.md) | Accepted | 2026-11-18 | P5 |
| 0047 | [Make the sound of an added video opt-in](0047-video-layer-sound.md) | Accepted | 2026-11-18 | P1, P4 |

## Node REPL parity

Rule `.claude/rules/node-repl-parity.md`.

| Number | Decision | Status | Date | Source |
| --- | --- | --- | --- | --- |
| 0048 | [Ship the node REPL door with its command, method or op](0048-same-change-repl-door.md) | Accepted | 2026-11-18 | REPL parity rule |
