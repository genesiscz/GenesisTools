/**
 * CI Mode Detection Hook
 *
 * Wraps CI detection utils and respects --ci / --json flags.
 */

import { useMemo } from 'react';
import { isCI, getCIName } from '#api/database/seeds/cli/utils/ci-detect.js';

export interface CIModeState {
  isCI: boolean;
  ciName: string | null;
  shouldAnimate: boolean;
  shouldUseColor: boolean;
}

export function useCIMode(flags?: { ci?: boolean; json?: boolean }): CIModeState {
  return useMemo(() => {
    const ci = flags?.ci || isCI();
    const json = flags?.json || false;
    const ciName = getCIName();

    return {
      isCI: ci,
      ciName,
      shouldAnimate: !ci && !json,
      shouldUseColor: !json && process.env.NO_COLOR === undefined,
    };
  }, [flags?.ci, flags?.json]);
}
