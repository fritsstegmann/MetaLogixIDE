/**
 * Renderer side of the window material: writes the render values as the
 * `--material-alpha`, `--material-blur` and `--material-saturate` CSS
 * variables on the document root (from the new window's URL query before
 * first paint, then live on every `settings:changed` for a material key),
 * and provides the latest-wins sender and the load/save controller behind
 * the Settings sliders.
 */
import {
  DEFAULT_WINDOW_MATERIAL,
  parseMaterialQuery,
  WINDOW_MATERIAL_SETTING_KEYS,
  type WindowMaterial,
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

/** Settings group state before the first load settles. */
export const INITIAL_MATERIAL_STATE: WindowMaterialState = { material: DEFAULT_WINDOW_MATERIAL, loaded: false, error: null };

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

/** State of the Settings "Window material" group. */
export interface WindowMaterialState { material: WindowMaterial; loaded: boolean; error: string | null }

type MaterialField = keyof WindowMaterial;
type MaterialSettingKey = typeof WINDOW_MATERIAL_SETTING_KEYS[MaterialField];

/** Reads one stored setting value and saves a full material (returns it normalised). */
export interface WindowMaterialIo {
  read(key: MaterialSettingKey): Promise<unknown>;
  save(material: WindowMaterial): Promise<WindowMaterial>;
}

/** Display text for a caught value: its string form without an `Error: ` prefix. */
export function errorText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function readMaterial(io: WindowMaterialIo): Promise<WindowMaterial> {
  const read = (field: MaterialField) => io.read(WINDOW_MATERIAL_SETTING_KEYS[field]);
  const [opacity, blur, saturation] = await Promise.all([read('opacity'), read('blur'), read('saturation')]);
  return {
    opacity: numberOr(opacity, DEFAULT_WINDOW_MATERIAL.opacity),
    blur: numberOr(blur, DEFAULT_WINDOW_MATERIAL.blur),
    saturation: numberOr(saturation, DEFAULT_WINDOW_MATERIAL.saturation),
  };
}

/**
 * Logic behind the Settings sliders. `load()` reads the stored material (a
 * non-number field falls back to its default; a failure becomes `error` and
 * still unlocks the controls) and returns a cancel that discards its outcome.
 * `change(field, value)` and `reset()` update state optimistically and send
 * the full material through a latest-wins sender; the normalised response
 * replaces state and clears `error`, a failure sets `error`. Every new state
 * is passed to `onState`, starting from `INITIAL_MATERIAL_STATE`.
 */
export function createWindowMaterialController(io: WindowMaterialIo, onState: (state: WindowMaterialState) => void) {
  let state = INITIAL_MATERIAL_STATE;
  const update = (patch: Partial<WindowMaterialState>) => {
    state = { ...state, ...patch };
    onState(state);
  };
  const push = createLatestWinsSender(
    (material: WindowMaterial) => io.save(material),
    (saved) => update({ material: saved, error: null }),
    (e) => {
      console.error('window material save failed', e);
      update({ error: errorText(e) });
    },
  );

  function load(): () => void {
    let live = true;
    readMaterial(io).then(
      (material) => { if (live) update({ material, loaded: true }); },
      (e: unknown) => {
        console.error('window material load failed', e);
        if (live) update({ error: errorText(e), loaded: true });
      },
    );
    return () => { live = false; };
  }

  function write(material: WindowMaterial): void {
    update({ material });
    push(material);
  }

  return {
    load,
    change: (field: MaterialField, value: number) => write({ ...state.material, [field]: value }),
    reset: () => write(DEFAULT_WINDOW_MATERIAL),
  };
}
