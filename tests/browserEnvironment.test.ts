// Permanent pure tests for the shared embedded-browser detector. Both the front-end
// bootstrap (never instantiate the game) and the socket layer (refuse the `/ws` upgrade)
// call this one module, so a false positive now blocks a usable browser and a false
// negative lets a WeChat/QQ webview through — both boundaries matter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInAppBrowser } from '../shared/inAppBrowser';

const WECHAT_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x1800312c) NetType/WIFI Language/zh_CN';
const WECHAT_ANDROID_KERNEL =
  'Mozilla/5.0 (Linux; Android 13; V2218A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36 XWEB/1170 MQQBrowser/6.2 TBS/046117 MicroMessenger/8.0.49.2600(0x28003135) WeChat/arm64 NetType/WIFI Language/zh_CN ABI/arm64';
const QQ_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; PGEM10 Build/UKQ1.230924.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36 MQQBrowser/6.2 TBS/046283 QQ/8.9.80.12155 V1_AND_SQ_8.9.80_4108_YYB_D Pixel/1080 NetType/WIFI';
const QQ_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/8.9.80.610 V1_IPH_SQ_8.9.80_1_APP_A NetType/WIFI';
const QQHD_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQHD/8.9.80.610 V1_IPH_SQ_8.9.80_1_APP_A NetType/WIFI';

test('微信内置浏览器（含 MQQBrowser/TBS 内核的安卓形态）被识别', () => {
  assert.equal(detectInAppBrowser(WECHAT_IOS), 'wechat');
  assert.equal(detectInAppBrowser(WECHAT_ANDROID_KERNEL), 'wechat');
});

test('QQ 聊天的 QQ/ 数字版本与 QQHD 形态被识别', () => {
  assert.equal(detectInAppBrowser(QQ_ANDROID), 'qq');
  assert.equal(detectInAppBrowser(QQ_IOS), 'qq');
  assert.equal(detectInAppBrowser(QQHD_IPAD), 'qq');
});

test('QQ 浏览器与裸内核不是 QQ 内嵌宿主', () => {
  assert.equal(
    detectInAppBrowser(
      'Mozilla/5.0 (Linux; Android 13; V2218A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 MQQBrowser/14.6 Mobile Safari/537.36',
    ),
    null,
  );
  assert.equal(
    detectInAppBrowser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 QQBrowser/10.5.3.4001',
    ),
    null,
  );
  assert.equal(
    detectInAppBrowser(
      'Mozilla/5.0 (Linux; U; Android 9; zh-cn; MI 8 Build/PKQ1.180729.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.126 TBS/044607 Mobile Safari/537.36',
    ),
    null,
  );
});

test('普通浏览器与空 UA 放行', () => {
  assert.equal(
    detectInAppBrowser(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ),
    null,
  );
  assert.equal(
    detectInAppBrowser(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ),
    null,
  );
  assert.equal(detectInAppBrowser(''), null);
  assert.equal(detectInAppBrowser('   '), null);
});

test('同时出现两种宿主标记时以微信为准', () => {
  assert.equal(
    detectInAppBrowser('Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 MQQBrowser/6.2 QQ/8.9.80 MicroMessenger/8.0.49(0x1800312c)'),
    'wechat',
  );
});

test('宿主标记必须成词且带数字版本', () => {
  // Bounded: a longer word around the marker is not the host.
  assert.equal(detectInAppBrowser('NotMicroMessengerX/1.0'), null);
  assert.equal(detectInAppBrowser('MicroMessengerX/8.0.49'), null);
  assert.equal(detectInAppBrowser('MQQ/8.9.80.610'), null);
  // QQ needs `/` plus a digit: a browser name or a bare version is not a host.
  assert.equal(detectInAppBrowser('QQBrowser/8.9.80'), null);
  assert.equal(detectInAppBrowser('QQ8.9.80.610'), null);
  assert.equal(detectInAppBrowser('QQ/'), null);
  assert.equal(detectInAppBrowser('QQ/beta'), null);
  // Markers are case-insensitive, like the apps themselves.
  assert.equal(detectInAppBrowser('micromessenger/8.0.42'), 'wechat');
  assert.equal(detectInAppBrowser('qq/8.9.33.10165'), 'qq');
});
