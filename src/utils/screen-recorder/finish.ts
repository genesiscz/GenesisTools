import type { JobRegistry, JobStep } from "@genesiscz/utils/jobs";
import type { StopAnswer } from "./control";

/**
 * The finish of a recording session, shared by the meetings recorder and the library recording: the client's steps
 * run in order as one job of the recording's registry (so `jobs.list` and the progress events show them), a step that
 * throws ends the finish there, the stop answer is settled, and only then the recording's socket closes. What the
 * steps do (a summary, frames, a manifest, a collect) and what a failure answers are the client's.
 */

export interface RecordingFinishOptions<S> {
    jobs: JobRegistry;
    kind: string;
    id?: string;
    initial: S;
    /** In order; each one starts when the one before has ended. */
    steps: JobStep<S>[];
    /** The stop answer when every step ran. */
    answer: (state: S, job: string) => StopAnswer;
    /** The stop answer when a step threw; without it a waiting stop fails with the step's error. */
    failed?: (error: unknown, job: string) => StopAnswer;
    /** Closes the recording's socket; it runs after the answer is settled, whatever the steps did. */
    close: () => void;
    /** The time between the answer and the close, so a stop waiting over the socket is answered before it closes. */
    closeAfterMs?: number;
}

export interface RecordingFinish {
    /** The job id, known at once (a stop that does not wait answers it). */
    job: string;
    /** The stop answer; it settles before the socket closes. */
    answer: Promise<StopAnswer>;
    /** The socket closed; it resolves on a failed finish too. */
    closed: Promise<void>;
}

export function runRecordingFinish<S>(options: RecordingFinishOptions<S>): RecordingFinish {
    const job = options.jobs.run<S>({
        kind: options.kind,
        ...(options.id ? { id: options.id } : {}),
        initial: options.initial,
        steps: options.steps,
    });
    const answer = job.done.then(
        ({ state }) => options.answer(state, job.id),
        (error: unknown) => {
            if (!options.failed) {
                throw error;
            }

            return options.failed(error, job.id);
        }
    );
    const closed = answer
        .then(
            () => undefined,
            () => undefined
        )
        .then(async () => {
            if (options.closeAfterMs) {
                await new Promise((resolve) => setTimeout(resolve, options.closeAfterMs));
            }

            options.close();
        });

    return { job: job.id, answer, closed };
}
