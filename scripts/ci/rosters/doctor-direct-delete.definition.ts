import { callTo, defineRoster } from "./define";

/** C36: doctor actions deleted files with fs calls, so nothing could be restored. */
export default defineRoster({
    name: "roster-doctor-direct-delete",
    candidate: "C36",
    message:
        "A doctor action removes files through `tools rm` (removeByName / the rm library), which moves them to the " +
        "trash with a restore window. An fs delete here is permanent, the defect C36 removed.",
    matcher: callTo(["rmSync", "unlinkSync", "rmdirSync", "rm", "unlink", "rmdir"]),
    onlyIn: /^src\/doctor\//,
});
