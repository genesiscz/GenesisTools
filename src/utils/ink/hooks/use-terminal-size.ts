/**
 * Terminal Size Hook
 *
 * Tracks terminal width/height using Ink's useStdout().
 */

import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? DEFAULT_SIZE.columns,
    rows: stdout?.rows ?? DEFAULT_SIZE.rows,
  }));

  useEffect(() => {
    if (!stdout) return;

    const onResize = () => {
      setSize({
        columns: stdout.columns ?? DEFAULT_SIZE.columns,
        rows: stdout.rows ?? DEFAULT_SIZE.rows,
      });
    };

    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  return size;
}
