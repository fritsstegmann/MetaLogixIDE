/**
 * Renderer side of the window material: writes the render values as the
 * `--material-alpha`, `--material-blur` and `--material-saturate` CSS
 * variables on the document root (from the new window's URL query before
 * first paint, then live on every `settings:changed` for a material key),
 * and provides the latest-wins sender the Settings sliders write through.
 */
import {
  parseMaterialQuery,
  WINDOW_MATERIAL_SETTING_KEYS,
  type WindowMaterialRender,
} from '@shared/window-material';

/** Minimal style target (document.documentElement in the app). */
export interface StyleTarget { style: { setProperty(name: string, value: string): void } }

/** The slice of `window.api` the live sync needs. */
export interface MaterialSyncApi {
  invoke(channel: 'app:get-window-render', req: undefined): Promise<WindowMaterialRender>;
  on(channel: 'settings:changed', cb: (payload: { key: string }) => void): () => void;
}

/** Runs a callback once, later (`requestAnimationFrame` in the app). */
export type FrameScheduler = (cb: () => void) => unknown;

const MATERIAL_KEYS: ReadonlySet<string> = new Set(Object.values(WINDOW_MATERIAL_SETTING_KEYS));

function setIfFinite(target: StyleTarget, name: string, value: number, unit: string): void {
  if (Number.isFinite(value)) target.style.setProperty(name, `${value}${unit}`);
}

/**
 * Set the three material CSS variables from numbers only; a non-finite field
 * is skipped so its current (or stylesheet default) value stays in force.
 */
export function applyRenderToRoot(target: StyleTarget, render: WindowMaterialRender): void {
  setIfFinite(target, '--material-alpha', render.surfaceAlpha, '');
  setIfFinite(target, '--material-blur', render.blurPx, 'px');
  setIfFinite(target, '--material-saturate', render.saturatePct, '%');
}

/**
 * Apply the `material` query values of `search` (a `location.search`) if they
 * are present and valid; otherwise set nothing so the CSS `:root` defaults apply.
 */
export function bootstrapFromQuery(target: StyleTarget, search: string): void {
  const render = parseMaterialQuery(search);
  if (render) applyRenderToRoot(target, render);
}

/**
 * Keep `target` in step with the stored material: every burst of
 * `settings:changed` events for material keys is coalesced through `schedule`
 * into one `app:get-window-render` call, and only the newest response is
 * applied. A failed fetch is logged and leaves the current values in place.
 * Returns an unsubscribe that detaches the listener and cancels pending work.
 */
export function installWindowMaterialSync(api: MaterialSyncApi, target: StyleTarget, schedule: FrameScheduler): () => void {
  let active = true;
  let scheduled = false;
  let latest = 0;

  async function refresh(): Promise<void> {
    scheduled = false;
    if (!active) return;
    const seq = ++latest;
    try {
      const render = await api.invoke('app:get-window-render', undefined);
      if (active && seq === latest) applyRenderToRoot(target, render);
    } catch (e) {
      console.error('window material refresh failed', e);
    }
  }

  const off = api.on('settings:changed', ({ key }) => {
    if (!MATERIAL_KEYS.has(key) || scheduled) return;
    scheduled = true;
    schedule(() => { void refresh(); });
  });

  return () => {
    active = false;
    off();
  };
}

/**
 * Wrap `send` so at most one call is in flight: values pushed meanwhile
 * replace each other and only the last is sent once the current call settles.
 * `onResult` / `onError` fire only for the outcome of the most recent value,
 * never for a superseded one. Returns the `push(value)` function.
 */
export function createLatestWinsSender<T, R>(
  send: (value: T) => Promise<R>,
  onResult: (result: R) => void,
  onError: (error: unknown) => void,
): (value: T) => void {
  let inFlight = false;
  let pending: { value: T } | null = null;

  function start(value: T): void {
    inFlight = true;
    send(value).then(
      (result) => settle(() => onResult(result)),
      (error: unknown) => settle(() => onError(error)),
    );
  }

  function settle(report: () => void): void {
    inFlight = false;
    const next = pending;
    pending = null;
    if (next) start(next.value);
    else report();
  }

  return (value: T) => {
    if (inFlight) pending = { value };
    else start(value);
  };
}
