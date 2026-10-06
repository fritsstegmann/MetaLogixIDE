import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { readAppVersion } from '@renderer/components/settings/version-label';

/** App version via `app:get-version`, fetched once on mount; null until known, and null for good if the IPC fails. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readAppVersion(() => api.invoke('app:get-version', undefined as never)).then((v) => {
      if (live) setVersion(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return version;
}
