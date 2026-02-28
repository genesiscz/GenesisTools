/**
 * Async Operation Hook
 *
 * Runs an async function with status tracking, abort signal, and optional timeout.
 */

import { useState, useCallback, useRef } from 'react';

export type OperationStatus = 'idle' | 'running' | 'success' | 'error';

export interface OperationState<T> {
  status: OperationStatus;
  value: T | null;
  error: Error | null;
  duration: number | null;
  execute: (fn: (signal: AbortSignal) => Promise<T>) => Promise<T | null>;
}

export interface UseOperationOptions {
  /** Timeout in milliseconds. 0 = no timeout. */
  timeout?: number;
}

export function useOperation<T = void>(options: UseOperationOptions = {}): OperationState<T> {
  const [status, setStatus] = useState<OperationStatus>('idle');
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const execute = useCallback(async (fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    // Cancel any previous operation
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('running');
    setError(null);
    setValue(null);
    setDuration(null);

    const startTime = Date.now();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const resultPromise = fn(controller.signal);

      const promises: Promise<T>[] = [resultPromise];
      if (options.timeout && options.timeout > 0) {
        promises.push(
          new Promise<T>((_, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(new Error(`Operation timed out after ${options.timeout}ms`));
            }, options.timeout);
          }),
        );
      }

      const result = await Promise.race(promises);

      if (!controller.signal.aborted) {
        const elapsed = Date.now() - startTime;
        setValue(result);
        setDuration(elapsed);
        setStatus('success');
        return result;
      }
      return null;
    } catch (err) {
      if (!controller.signal.aborted) {
        const elapsed = Date.now() - startTime;
        setError(err as Error);
        setDuration(elapsed);
        setStatus('error');
      }
      return null;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }, [options.timeout]);

  return { status, value, error, duration, execute };
}
