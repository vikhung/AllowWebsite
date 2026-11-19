# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

「孩童安心上網管理平台」— 家長管理孩子上網的 Chrome 擴充功能（Manifest V3，純 JavaScript ES modules，無建置步驟、無相依套件）。所有設定存放在 `chrome.storage.sync`，透過孩子 Google 帳號的 Chrome 同步套用到每台電腦。UI、註解、文件皆為繁體中文。

## 常用指令

- 單元測試（Node.js 18+，內建 `node:test`）：`npm test`
- 執行單一測試：`node --test --test-name-pattern="normalizeDomain" tests/`
- 打包上架 zip：`powershell -File scripts/package.ps1` → `dist/kids-safe-browsing-<manifest 版本>.zip`（刻意用 `tar.exe`，因 PowerShell 5.1 的 `Compress-Archive` 會寫入反斜線路徑，商店不接受）
- 重新產生圖示：`python scripts/make_icons.py`（需要 Pillow）
- 本機測試：`chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選 `extension/`。更新後按「重新載入」，**不要移除再安裝**（會清掉所有設定）。

## 架構

三個獨立的「管理功能」，各有啟用開關與各自的 API 通知設定，預設皆關閉：

1. **白名單管理**（`blocking`）：用 `declarativeNetRequest` 動態規則實作 — 規則 1（priority 1）把所有 http/https `main_frame` 導向 `pages/blocked.html#<原網址>`；規則 2（priority 2）以 `requestDomains` 放行白名單 + `SYSTEM_ALLOW`。啟用時也會對已開啟的分頁補做封鎖（`enforceOpenTabs`）。支援暫停（`pauseUntil` + `chrome.alarms` 自動恢復）。封鎖頁回報後觸發封鎖通知。
2. **網站瀏覽通知**（`monitor`）：監聽分頁載入完成送出通知，不封鎖；被功能 1 封鎖的網站不算瀏覽。
3. **上網摘要報告**（`report`）：background 依分頁切換 / 視窗焦點 / `chrome.idle` 狀態計時（目前計時對象存 `storage.session` 的 `usageCur`），停留時間累加到 `storage.local` 的 `usage:YYYY-MM-DD`（**每台電腦各自一份，不同步**）。`usage-tick` alarm 每分鐘結算一次（單次上限 90 秒，避免睡眠時間被算入）並檢查每日 / 每週報告是否到期；寄送狀態存 `storage.local` 的 `reportState`，用 `latestDue` 判斷，關機錯過時下次補送最近一份，剛啟用時從現在起算不補送。報告一律涵蓋完整的日子（`reportDays`：每日 = 寄送日前一天，每週 = 前 7 天）；預設每天 08:00、每週六 09:00。報告內容由 `lib/report.js` 的 `buildReport` 依家長在設定頁組合的範本（`report.template`：`text` / `ranking` / `days` 區塊，由 `normalizeTemplate` 驗證）產生 Markdown，以 `{{report}}` 變數套進家長的 Payload（預設為 Webex `{"markdown":...}` 格式）。設定頁的即時預覽用同一個 `buildReport` + `renderMarkdown`，測試報告（`testReport` 訊息）也帶著畫面上尚未儲存的範本，確保所見即所得。

關鍵檔案與跨檔案的設計：

- `extension/lib/report.js`：功能 3 的純函式（日期 / 排程計算、報告產生），不碰 `chrome.*`，測試在 `tests/report.test.mjs`。
- `extension/lib/store.js` 是唯一的設定層，被 background 與所有頁面共用。純函式（`normalizeDomain`、`isHostAllowed`、`buildNotifyRequest`、`normalizeConfig`、`fitsSyncItem` 等）不碰 `chrome.*`，因此可在 Node 中測試 — 新增邏輯盡量放成這類純函式並在 `tests/store.test.mjs` 測試。
- **sync 儲存配置**（受 `chrome.storage.sync` 單一 key 8KB 上限限制）：`config`（密碼雜湊/salt/updatedAt）、`blocking`、`monitor`、`report` 分成四個 key；白名單分段存在 `wlCount` + `wl_0..wl_N`。修改設定一律透過 `saveConfig(patch | (c) => {...})` 與 `saveWhitelist`，不要直接寫 storage。
- `normalizeConfig` 負責與預設值合併，並把 1.3 以前的扁平舊格式轉成 `blocking`/`monitor` 新格式 — 變更設定結構時要維持向後相容。
- `background.js`：`applyRules()` 以 promise 串行化避免並行更新互相覆蓋；監聽 `storage.onChanged`，因此其他電腦同步過來的變更（以及頁面寫入的設定）會自動重新套用規則。
- 訊息協定（`chrome.runtime.onMessage`）：`blocked`（只接受來自頂層 `blocked.html` 的回報，防止網頁嵌入 iframe 濫發通知）、`testNotify` / `testReport`（只接受 `options.html`）、`apply`。`doApply` 結尾會呼叫 `syncReportScheduler`，所以任何 sync 設定變更也會建立 / 清除報告計時器。
- 通知工具（`lib/tools.js`）：每個 notify 設定為 `{ tool, url, token, chatId, method, payload }`，tool = webex / slack / telegram / line / discord / custom。訊息內部一律先組成簡易 Markdown（封鎖 / 瀏覽通知用 `MESSAGES` 定型化範本 + `escapeMd` 跳脫變數；報告用 `buildReport` 的輸出），再由 `formatFor` 轉成各工具格式（Slack mrkdwn、Telegram HTML、LINE 純文字），`buildToolRequest` 組出請求並依 `TOOLS[tool].limit` 截斷。background 只透過 `sendRequest(notify, md, vars)` 送出。舊設定沒有 `tool` 時，已填 URL 視為 `custom`（`store.js` 的 `normalizeNotify`）。設定頁的三個通知表單由 `options.js` 的 `createApiForm` 動態產生，「如何申請？」內容在 `pages/tool-help.js`。
- 自訂 API：`buildNotifyRequest` 以 `{{var}}` 範本替換 — URL 中的變數做網址編碼、Payload 中做 JSON 跳脫；Payload 是合法 JSON 時以 `application/json` 送出，否則純文字；GET 不送 body；非 http(s) URL 回傳 `null`。background 依網域節流（封鎖 60 秒、瀏覽 5 分鐘）。`{{email}}` 來自 `chrome.identity`。
- 家長密碼以 PBKDF2（WebCrypto）雜湊存放，`setPassword`/`verifyPassword`。
- 頁面：`pages/options.*`（家長設定）、`pages/blocked.*`（封鎖頁，可輸入密碼直接放行）、`pages/popup.*`（狀態），共用 `style.css`。

## 其他

- `policies/*.reg`：Windows 原則，強制安裝擴充功能並停用開發人員工具/無痕/訪客模式（擴充功能 ID 需換成上架後的 ID）；`windows-unlock.reg` 還原。
- 上架流程與商店文案在 `docs/PUBLISHING.md`；`PRIVACY.md` 為隱私權政策。修改權限或資料行為時要同步更新這兩份文件與 README。
- 版本號在 `extension/manifest.json`，打包檔名取自此。
