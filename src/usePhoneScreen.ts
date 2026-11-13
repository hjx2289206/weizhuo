import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue';

/**
 * Native fullscreen + orientation plumbing for the phone seat.
 *
 * The web facts this has to live with: fullscreen and (on most engines)
 * orientation lock can only be requested from inside a real user gesture, remote
 * socket events carry none, and Safari on iOS exposes no element fullscreen at
 * all. So this module never pretends: it asks for what exists, records what the
 * browser actually answered, and reports the truth for the gate to explain.
 */

interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface LockableOrientation {
  lock?: (orientation: 'landscape' | 'portrait' | 'any') => Promise<void>;
  unlock?: () => void;
}

export type OrientationLockState = 'idle' | 'locked' | 'rejected' | 'unsupported';

export function fullscreenElement(): Element | null {
  const doc = document as PrefixedDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export function fullscreenSupported(): boolean {
  const root = document.documentElement as PrefixedElement;
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
}

/** Fullscreen on the document root, so every dialog stays visible inside it. */
export function requestDocumentFullscreen(): Promise<void> | void {
  const root = document.documentElement as PrefixedElement;
  if (typeof root.requestFullscreen === 'function') return root.requestFullscreen();
  if (typeof root.webkitRequestFullscreen === 'function') return root.webkitRequestFullscreen();
  throw new Error('当前浏览器不支持全屏显示');
}

export function releaseDocumentFullscreen(): Promise<void> | void {
  const doc = document as PrefixedDocument;
  if (typeof document.exitFullscreen === 'function') return document.exitFullscreen();
  if (typeof doc.webkitExitFullscreen === 'function') return doc.webkitExitFullscreen();
  throw new Error('当前浏览器不支持退出全屏');
}

function orientationApi(): LockableOrientation | null {
  const orientation = (screen as Screen & { orientation?: LockableOrientation }).orientation;
  return orientation ?? null;
}

function viewportIsLandscape(): boolean {
  if (typeof window.matchMedia === 'function') return window.matchMedia('(orientation: landscape)').matches;
  return window.innerWidth >= window.innerHeight;
}

export interface PhoneScreenApi {
  /** The browser exposes an element fullscreen request. */
  supported: Ref<boolean>;
  /** Native fullscreen is active right now. */
  active: Ref<boolean>;
  /** The real viewport is landscape right now (never a CSS pretence). */
  landscape: Ref<boolean>;
  lockState: Ref<OrientationLockState>;
  /** A fullscreen request is in flight; further taps are ignored. */
  busy: Ref<boolean>;
  /** The browser refused the request at least once. */
  denied: Ref<boolean>;
  /**
   * The player explicitly chose to keep playing in the browser viewport. Only ever
   * true while the viewport matches the preferred orientation; refresh revokes it otherwise.
   */
  dismissed: Ref<boolean>;
  /** No API can improve this screen any further. */
  limited: ComputedRef<boolean>;
  /** Truthful Chinese status for the gate. */
  note: ComputedRef<string>;
  /** MUST be called synchronously from a user gesture: fullscreen is gesture-gated. */
  enter(): void;
  /** Re-reads the live fullscreen / viewport state (phase changes, resume). */
  refresh(): void;
  dismiss(): void;
}

export function usePhoneScreen(preferred: Readonly<Ref<'landscape' | 'portrait'>> = ref('landscape')): PhoneScreenApi {
  const supported = ref(fullscreenSupported());
  const active = ref(fullscreenElement() !== null);
  const landscape = ref(viewportIsLandscape());
  const lockState = ref<OrientationLockState>('idle');
  const busy = ref(false);
  const denied = ref(false);
  const dismissed = ref(false);
  let orientationEpoch = 0;
  let disposed = false;

  function refresh(): void {
    if (disposed) return;
    supported.value = fullscreenSupported();
    active.value = fullscreenElement() !== null;
    landscape.value = viewportIsLandscape();
    // The browser fallback is granted for this orientation stay; rotating away must gate again.
    if (landscape.value !== (preferred.value === 'landscape')) dismissed.value = false;
  }

  /** Orientation lock only works inside native fullscreen, so it runs after that resolves. */
  function lockPreferredOrientation(): void {
    if (disposed) return;
    const epoch = ++orientationEpoch;
    const orientation = orientationApi();
    if (!orientation || typeof orientation.lock !== 'function') {
      lockState.value = 'unsupported';
      return;
    }
    let attempt: Promise<void>;
    try {
      attempt = orientation.lock(preferred.value);
    } catch {
      lockState.value = 'rejected';
      return;
    }
    Promise.resolve(attempt)
      .then(() => {
        if (epoch === orientationEpoch) lockState.value = 'locked';
      })
      .catch(() => {
        if (epoch === orientationEpoch) lockState.value = 'rejected';
      })
      .finally(refresh);
  }

  function enter(): void {
    if (busy.value) return;
    if (fullscreenElement() !== null) {
      denied.value = false;
      lockPreferredOrientation();
      refresh();
      return;
    }
    if (!fullscreenSupported()) {
      supported.value = false;
      denied.value = true;
      refresh();
      return;
    }
    busy.value = true;
    let request: Promise<void> | void;
    try {
      request = requestDocumentFullscreen();
    } catch {
      denied.value = true;
      busy.value = false;
      refresh();
      return;
    }
    Promise.resolve(request)
      .then(() => {
        denied.value = false;
        lockPreferredOrientation();
      })
      .catch(() => {
        denied.value = true;
      })
      .finally(() => {
        busy.value = false;
        refresh();
      });
  }

  // Changing games releases the previous orientation, including during a pending fullscreen
  // request. Its completion uses the current preference rather than a captured landscape value.
  const stopPreference = watch(preferred, () => {
    orientationEpoch += 1;
    try { orientationApi()?.unlock?.(); } catch { /* orientation control unavailable */ }
    lockState.value = 'idle';
    if (fullscreenElement() !== null) lockPreferredOrientation();
    refresh();
  }, { flush: 'sync' });

  /**
   * Honest fallback for a browser that will not hand over the screen: keep playing
   * in the browser viewport. Only granted while the live viewport matches this game’s preferred orientation.
   * Re-read the viewport here so a stale ref cannot bypass the gate.
   */
  function dismiss(): void {
    landscape.value = viewportIsLandscape();
    if (landscape.value !== (preferred.value === 'landscape')) {
      dismissed.value = false;
      return;
    }
    dismissed.value = true;
  }

  const limited = computed(
    () => !supported.value || denied.value || lockState.value === 'rejected' || lockState.value === 'unsupported',
  );

  const note = computed(() => {
    if (preferred.value === 'portrait') {
      if (!supported.value) return '当前浏览器不支持网页全屏，可以直接竖屏下棋。';
      if (denied.value || lockState.value === 'rejected' || lockState.value === 'unsupported') return '请保持手机竖屏，直接在浏览器中下棋。';
      return '棋盘使用竖屏布局，可进入竖屏全屏。';
    }
    if (!supported.value) return '当前浏览器不支持网页全屏。请把手机横过来，直接在浏览器里出牌。';
    if (denied.value) return '浏览器没有授权全屏。可再次点击按钮重试，或直接在浏览器里横屏出牌。';
    if (!landscape.value) {
      if (lockState.value === 'rejected') return '系统拒绝了屏幕方向锁定，请手动把手机横过来。';
      if (lockState.value === 'unsupported') return '当前浏览器无法锁定屏幕方向，请手动把手机横过来。';
      return '横屏才能看清手牌，请把手机横过来。';
    }
    return '点击按钮进入全屏横屏牌局。';
  });

  const onChange = (): void => {
    refresh();
  };
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: landscape)') : null;
  const legacyMedia = media as
    | (MediaQueryList & { addListener?: (handler: () => void) => void; removeListener?: (handler: () => void) => void })
    | null;

  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  document.addEventListener('visibilitychange', onChange);
  if (media && typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
  else legacyMedia?.addListener?.(onChange);

  function teardown(): void {
    disposed = true;
    orientationEpoch += 1;
    stopPreference();
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
    document.removeEventListener('fullscreenchange', onChange);
    document.removeEventListener('webkitfullscreenchange', onChange);
    document.removeEventListener('visibilitychange', onChange);
    if (media && typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange);
    else legacyMedia?.removeListener?.(onChange);
  }
  if (getCurrentScope()) onScopeDispose(teardown);

  return {
    supported,
    active,
    landscape,
    lockState,
    busy,
    denied,
    dismissed,
    limited,
    note,
    enter,
    refresh,
    dismiss,
  };
}
