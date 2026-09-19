import { routeUtterance } from "../../route/router";
import type { FixtureScript } from "../fixture-evaluator";
import { fixtureCatalogue } from "../fixtures";
import { type Chapter, createEventLog, mismatch } from "./context";

const UTTERANCE = "show the unresolved review threads on 409";
const EXPECTED_COMMAND = "github review";
const EXPECTED_ARG = "409";

/**
 * `command` picks the catalogue row whose id or summary mentions review; `pos_*` says the
 * positional is present and `slot_*` binds it to the literal `409` span. Nothing is invented:
 * the value question only offers spans of the utterance itself.
 */
export const ROUTE_SCRIPT: FixtureScript = {
    choice: [
        [/^family$/, /github/],
        [/^command$/, /review/],
        [/^(slot|value)_/, /^409$/],
    ],
    boolean: [
        [/^pos_/, 0.95],
        [/^destructive$/, 0.02],
        [/^confirm$/, 0.05],
    ],
};

/** Utterance → argv, through the real router, catalogue and flag binder. Never runs the command. */
export const routeChapter: Chapter = async (context) => {
    const log = createEventLog(context.now);
    log.add("catalogue", "2 fixture tools, 3 commands");
    const decision = await routeUtterance({
        utterance: UTTERANCE,
        catalogue: fixtureCatalogue(),
        evaluate: context.evaluator(ROUTE_SCRIPT),
        signal: context.signal,
    });
    log.add(
        `route:${decision.status}`,
        `${decision.printed} (p=${decision.p.toFixed(2)}, ${decision.requests} requests)`
    );
    const readback =
        decision.status === "admitted" &&
        decision.command === EXPECTED_COMMAND &&
        decision.argv.includes(EXPECTED_ARG) &&
        decision.destructive === false;
    const actual = `${decision.status}:${decision.command ?? "none"}:${decision.argv.join(" ")}`;
    log.add("readback", `argv ${decision.argv.join(" ")}`);
    return {
        readback,
        reason: readback
            ? "argv_matched_the_catalogue_row"
            : mismatch(`admitted:${EXPECTED_COMMAND} with ${EXPECTED_ARG}`, actual),
        events: log.events(),
        result: { utterance: UTTERANCE, decision },
    };
};
