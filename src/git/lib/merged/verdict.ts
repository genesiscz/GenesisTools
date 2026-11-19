/**
 * The merged verdict, pure: every function here takes parsed git output and
 * returns a decision, so the ladder is pinned by fixtures without a repo.
 *
 *   EMPTY     tip == base tip                             a branch with nothing on it
 *   MERGED    ancestor   merge-base --is-ancestor         plain merge / fast-forward (ahead == 0)
 *   MERGED    cherry     git cherry has no "+"            rebased or cherry-picked (patch-ids match)
 *   MERGED    content    blob containment                 squashed, RECOMPOSED, or a snapshot
 *   STALE     superseded every unlanded file was rewritten on the base after the fork
 *   UNMERGED  none       files whose branch blob never existed on the base
 *
 * `how` is reported so the reader learns why git's own tests would have lied.
 * An ancestor of the base always has ahead == 0, so the ancestor tier IS the
 * ahead == 0 case; EMPTY is reserved for a branch sitting exactly on the base.
 */
export * from "@genesiscz/utils/git/merged/verdict";
