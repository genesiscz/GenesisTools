import { useState, useEffect, useRef } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };

export function useTerminalSize({ clearOnResize = false } = {}): TerminalSize {
  const { stdout } = useStdout();
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? DEFAULT_SIZE.columns,
    rows: stdout?.rows ?? DEFAULT_SIZE.rows,
  }));

  useEffect(() => {
    if (!stdout) {
      return;
    }

    const onResize = () => {
      setSize({
        columns: stdout.columns ?? DEFAULT_SIZE.columns,
        rows: stdout.rows ?? DEFAULT_SIZE.rows,
      });

      if (clearOnResize) {
        if (clearTimerRef.current) {
          clearTimeout(clearTimerRef.current);
        }

        clearTimerRef.current = setTimeout(() => {
          stdout.write("\x1b[2J\x1b[H");
        }, 500);
      }
    };

    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);

      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
      }
    };
  }, [stdout, clearOnResize]);

  return size;
}
