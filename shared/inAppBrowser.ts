/**
 * Canonical, pure detection of the two embedded app webviews this game hard-blocks:
 * WeChat (`MicroMessenger`) and the QQ chat host (`QQ`/`QQHD`).
 *
 * One implementation, shared by the front-end bootstrap (never instantiate the game
 * there) and by the socket layer (refuse the `/ws` upgrade) so the two can never drift.
 *
 * UA-token based on purpose: the matcher only fires on host markers an app injects
 * itself and never on browser or kernel names — a standalone QQ Browser, or a page
 * rendered by the Chromium `TBS`/`MQQBrowser` kernel, is still a usable browser and
 * must stay allowed. This is a heuristic, not authentication.
 */

export type InAppBrowser = 'wechat' | 'qq' | null;

/** Product tokens of the QQ family: the chat hosts, not the browser of the same brand. */
const QQ_HOST_TOKENS = ['QQ', 'QQHD'] as const;

/**
 * Case-insensitive, word-bounded token probe: the token must not be part of a
 * longer word, so `QQ` never matches `MQQBrowser` and `MicroMessenger` never
 * matches a longer accidental word.
 */
function hasToken(userAgent: string, token: string): boolean {
  const haystack = userAgent.toLowerCase();
  const needle = token.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + needle.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

/**
 * Bounded `TOKEN/<digit...>` probe, the form every real QQ host marker takes
 * (`QQ/8.9.80.12155`, `QQHD/8.9.80.610`). The digit requirement keeps sibling
 * product names such as `QQBrowser/9.9` out.
 */
function hasVersionedToken(userAgent: string, token: string): boolean {
  const haystack = userAgent.toLowerCase();
  const needle = `${token.toLowerCase()}/`;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const digit = haystack[at + needle.length] ?? '';
    if (!/[a-z0-9]/.test(before) && digit >= '0' && digit <= '9') return true;
    from = at + 1;
  }
}

/**
 * `null` for every ordinary browser (and for anything unrecognised). WeChat wins
 * when both markers appear, because its Android webview also carries the
 * `MQQBrowser`/`TBS` kernel tokens of a QQ build.
 */
export function detectInAppBrowser(userAgent: string): InAppBrowser {
  if (userAgent.trim().length === 0) return null;
  if (hasToken(userAgent, 'MicroMessenger')) return 'wechat';
  for (const token of QQ_HOST_TOKENS) {
    if (hasVersionedToken(userAgent, token)) return 'qq';
  }
  return null;
}
