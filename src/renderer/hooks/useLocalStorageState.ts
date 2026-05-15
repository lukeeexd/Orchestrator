import { useCallback, useState } from 'react';

export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    if (raw == null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
    [key],
  );

  return [value, set];
}
