import { createApp } from 'vue';
import { detectInAppBrowser } from '../shared/inAppBrowser';
import './style.css';
import './collection.css';
import './cardMotion.css';
import './homeLayout.css';
import './gameTools.css';
import './resultStyles.css';
import './junqi.css';

/**
 * Entry point. The embedded-browser check runs before anything else and, for a blocked
 * UA, mounts only the gate: `App.vue` (and therefore `useGame` and its `/ws` socket) is
 * never imported, so WeChat / QQ webviews cannot reach the game at all.
 *
 * The Vite dev-HMR socket is created by the dev server itself and is not game traffic.
 */
async function bootstrap(): Promise<void> {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (detectInAppBrowser(userAgent) !== null) {
    // A static `import App from './App.vue'` would evaluate the module graph, and Vite
    // emits it as a chunk that loads before this branch runs — the blocked webview would
    // already have built the game. The specifier is known, but loading must stay
    // runtime-conditional, so `import()` is the only form that keeps App out of the gate.
    const { default: InAppBrowserGate } = await import('./components/InAppBrowserGate.vue');
    createApp(InAppBrowserGate).mount('#app');
    return;
  }
  const { default: App } = await import('./App.vue');
  createApp(App).mount('#app');
}

void bootstrap();
