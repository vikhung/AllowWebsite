// 執行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDomain,
  isHostAllowed,
  isProtectionActive,
  buildNotifyRequest,
  normalizeConfig,
  fitsSyncItem,
} from '../extension/lib/store.js';

const vars = {
  url: 'https://bad.example.com/a?b="c"&d=1',
  host: 'bad.example.com',
  email: 'kid.one@gmail.com',
  time: '2026-11-17T09:00:00.000Z',
  localTime: '2026/11/17 17:00:00',
  timestamp: 1,
};

test('buildNotifyRequest：POST JSON，變數做 JSON 跳脫', () => {
  const r = buildNotifyRequest(
    { method: 'POST', url: 'https://hook.example.com/x', payload: '{"msg":"{{url}}","h":"{{host}}","who":"{{ email }}","t":{{timestamp}}}' },
    vars
  );
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(r.init.body), { msg: vars.url, h: vars.host, who: vars.email, t: 1 });
});

test('buildNotifyRequest：GET 不送 body，URL 變數做編碼', () => {
  const r = buildNotifyRequest(
    { method: 'GET', url: 'https://api.telegram.org/botX/sendMessage?chat_id=1&text={{email}}%20{{host}}%20{{url}}', payload: '{"a":1}' },
    vars
  );
  assert.equal(r.init.body, undefined);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('text'), `${vars.email} ${vars.host} ${vars.url}`);
});

test('buildNotifyRequest：非 JSON payload 以純文字送出；無效 URL 回傳 null', () => {
  const r = buildNotifyRequest({ method: 'PUT', url: 'http://h.local/x', payload: '被擋：{{host}}' }, vars);
  assert.match(r.init.headers['Content-Type'], /^text\/plain/);
  assert.equal(r.init.body, '被擋：bad.example.com');
  assert.equal(buildNotifyRequest({ method: 'POST', url: 'javascript:alert(1)' }, vars), null);
  assert.equal(buildNotifyRequest({ method: 'POST', url: 'not a url' }, vars), null);
  assert.equal(buildNotifyRequest({ method: 'POST', url: '' }, vars), null);
});

test('normalizeDomain 處理各種輸入', () => {
  assert.equal(normalizeDomain('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(normalizeDomain('pbskids.org'), 'pbskids.org');
  assert.equal(normalizeDomain('*.example.com'), 'example.com');
  assert.equal(normalizeDomain('http://user@site.tw:8080/a'), 'site.tw');
  assert.equal(normalizeDomain('kids.gov.tw/'), 'kids.gov.tw');
  assert.equal(normalizeDomain('中文.tw'), 'xn--fiq228c.tw');
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain('nodot'), null);
  assert.equal(normalizeDomain('bad domain.com'), null);
  assert.equal(normalizeDomain('a..b.com'), null);
});

test('isHostAllowed 包含子網域，但不誤判相似網域', () => {
  const wl = ['youtube.com'];
  assert.ok(isHostAllowed('youtube.com', wl));
  assert.ok(isHostAllowed('m.youtube.com', wl));
  assert.ok(!isHostAllowed('notyoutube.com', wl));
  assert.ok(!isHostAllowed('youtube.com.evil.net', wl));
  assert.ok(isHostAllowed('accounts.google.com', wl)); // 系統預設允許
});

test('isProtectionActive 考慮暫停時間', () => {
  const now = 1000;
  const c = (enabled, pauseUntil) => ({ blocking: { enabled, pauseUntil } });
  assert.ok(isProtectionActive(c(true, 0), now));
  assert.ok(!isProtectionActive(c(true, 2000), now));
  assert.ok(isProtectionActive(c(true, 500), now));
  assert.ok(!isProtectionActive(c(false, 0), now));
});

test('normalizeConfig：預設值兩個管理功能都關閉、各自有預設 Payload', () => {
  const c = normalizeConfig({});
  assert.equal(c.blocking.enabled, false);
  assert.equal(c.monitor.enabled, false);
  assert.match(c.blocking.notify.payload, /未允許/);
  assert.match(c.monitor.notify.payload, /\{\{title\}\}/);
  assert.notEqual(c.blocking.notify.payload, c.monitor.notify.payload);
});

test('normalizeConfig：舊格式（1.x）自動轉換', () => {
  const c = normalizeConfig({
    passwordHash: 'h',
    salt: 's',
    enabled: true,
    pauseUntil: 0,
    notify: { enabled: true, onVisit: true, method: 'PUT', url: 'https://x.test/h', payload: '{}' },
  });
  assert.equal(c.passwordHash, 'h');
  assert.equal(c.blocking.enabled, true);
  assert.equal(c.blocking.notify.enabled, true);
  assert.equal(c.blocking.notify.url, 'https://x.test/h');
  assert.equal(c.blocking.notify.method, 'PUT');
  assert.equal(c.blocking.notify.payload, '{}'); // 自訂的 Payload 保留給封鎖通知
  assert.equal(c.monitor.enabled, true);
  assert.equal(c.monitor.notify.url, 'https://x.test/h');
  assert.match(c.monitor.notify.payload, /\{\{title\}\}/); // 瀏覽通知用新的預設範本
  // 舊版 Payload 為空字串時，封鎖通知使用預設範本
  const c2 = normalizeConfig({ enabled: false, notify: { payload: '' } });
  assert.match(c2.blocking.notify.payload, /未允許/);
  assert.ok(!('enabled' in c) && !('notify' in c));
});

test('fitsSyncItem：以 UTF-8 位元組計算（中文 3 bytes）', () => {
  assert.ok(fitsSyncItem('monitor', { payload: '中'.repeat(2000) }));
  assert.ok(!fitsSyncItem('monitor', { payload: '中'.repeat(2700) }));
});
