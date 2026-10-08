export type AppEnvLoad = 'loading' | 'ready' | 'failed';

export interface AppEnvState {
  stored: Record<string, string>;
  load: AppEnvLoad;
  setStored: (env: Record<string, string>) => void;
}

/** Saved app-wide map via settings:get, re-read on settings:changed { key: 'app_env' }; a load failure toasts ENV_COPY.loadFailed. */
export function useAppEnv(): AppEnvState {
  throw new Error('useAppEnv not implemented');
}

/** Validated save via settings:set-app-env; resolves the stored map, rejects with main's key-only message. */
export function saveAppEnv(env: Record<string, string>): Promise<Record<string, string>> {
  void env;
  throw new Error('saveAppEnv not implemented');
}
