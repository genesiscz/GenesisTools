/** The widest sheet a grid makes. A reader shrinks a wider image anyway, and a 4096 px sheet keeps a two-column
 * tile at half of a 4K display, which is the logical resolution of a Retina capture. It lives apart from grid.ts so
 * a module that only reads it (utils/video/defaults.ts) loads no drawing code. */
export const MAX_SHEET_WIDTH = 4096;
