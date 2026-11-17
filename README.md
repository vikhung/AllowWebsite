# 孩童安心上網管理平台（Chrome 擴充功能）

家長用來管理孩子上網的 Chrome 擴充功能。所有設定存放在 `chrome.storage.sync`，只要孩子的 Google 帳號在 Chrome 中開啟同步，**在 A 電腦做的設定會自動套用到孩子登入的 B 電腦**。

## 管理功能

設定頁分成兩個獨立的管理功能，各自有一個啟用開關、各自的 API 通知設定。兩者**預設都關閉**，可單獨或同時啟用。

### 管理功能 1：白名單管理

| 項目 | 說明 |
| --- | --- |
| 啟用開關 | 開啟後，孩子只能開啟白名單內的網站，其他網站一律導向封鎖頁 |
| 暫停 | 可暫停 15 分鐘 / 1 小時，時間到自動恢復 |
| 允許的網站（白名單） | 輸入網域或貼上網址，含所有子網域；停用時也可以先編輯 |
| 開啟非白名單網站通知 | 勾選後，孩子開啟被封鎖的網站時呼叫 API 通知家長（同一網域 60 秒內一次） |

封鎖頁上家長也可以直接輸入密碼「允許並開啟」該網站。

### 管理功能 2：網站瀏覽通知

| 項目 | 說明 |
| --- | --- |
| 啟用開關 | 開啟後，孩子瀏覽任何網站（網頁載入完成時）都呼叫 API 通知家長，**不封鎖** |
| 節流 | 同一網域 5 分鐘內只通知一次 |
| 用途 | 第一階段「先觀察」：了解孩子常去哪些網站，再建立白名單並啟用管理功能 1 |

被管理功能 1 封鎖的網站不會再算成「瀏覽」，不會重複通知。

## API 通知設定

兩個管理功能各有一組獨立設定（格式可以完全不同，例如送到不同的 Webhook）：

| 欄位 | 說明 |
| --- | --- |
| Method | `POST`、`GET`、`PUT`、`PATCH`（GET 不送 Payload） |
| URL | 接收通知的網址，可含變數 |
| Payload | 請求內容，可含變數；是合法 JSON 時以 `application/json` 送出，否則為純文字 |

| 變數 | 封鎖通知 | 瀏覽通知 | 說明 |
| --- | :---: | :---: | --- |
| `{{email}}` | ✓ | ✓ | 孩子登入 Chrome 的 Google 帳號（未登入時為「（未登入 Chrome）」） |
| `{{url}}` | ✓ | ✓ | 網址 |
| `{{host}}` | ✓ | ✓ | 網域 |
| `{{title}}` | | ✓ | 網頁標題 |
| `{{time}}` / `{{localTime}}` / `{{timestamp}}` | ✓ | ✓ | ISO 時間 / 本地時間 / 毫秒時間戳 |

URL 中的變數自動做網址編碼，Payload 中的變數自動做 JSON 跳脫。每組設定都有「傳送測試通知」按鈕。

範例（Payload 皆以 POST 送出）：

| 服務 | URL | 封鎖通知 Payload | 瀏覽通知 Payload |
| --- | --- | --- | --- |
| Discord | `https://discord.com/api/webhooks/<id>/<token>` | `{"content":"⛔ {{email}} 嘗試開啟 {{host}}\n{{url}}"}` | `{"content":"👀 {{email}} 瀏覽 {{title}}\n{{url}}"}` |
| Slack | `https://hooks.slack.com/services/...` | `{"text":"⛔ {{email}} 嘗試開啟 {{host}}"}` | `{"text":"👀 {{email}} 瀏覽 {{title}}（{{host}}）"}` |
| Telegram | `https://api.telegram.org/bot<token>/sendMessage` | `{"chat_id":"<chat id>","text":"⛔ {{email}} 嘗試開啟 {{host}}"}` | `{"chat_id":"<chat id>","text":"👀 {{email}} 瀏覽 {{title}}"}` |

> 通知設定同樣存在 `chrome.storage.sync`。URL 裡的權杖（token）技術上可被懂電腦的孩子從開發人員工具看到，建議搭配 `policies/windows-lockdown.reg` 停用開發人員工具，並為通知使用專用的 Bot / Webhook。

## 運作原理

| 元件 | 說明 |
| --- | --- |
| `extension/background.js` | 管理功能 1：依設定建立 `declarativeNetRequest` 動態規則（低優先規則把所有 http/https 主頁面導向 `blocked.html`，高優先規則放行白名單）。管理功能 2：監聽分頁載入完成並送出瀏覽通知。監聽 `storage.onChanged`，其他電腦同步過來的變更會自動套用。 |
| `extension/lib/store.js` | 設定讀寫（兩個管理功能分開存放，避開 sync 單一 key 8KB 上限）、白名單分段存放、網域正規化、密碼雜湊、通知請求組裝、舊版設定自動轉換。 |
| `extension/pages/options.*` | 家長設定頁。 |
| `extension/pages/blocked.*` | 封鎖頁，含家長快速放行。 |
| `extension/pages/popup.*` | 工具列彈出視窗，顯示兩個管理功能的狀態。 |

## 本機測試

1. 開啟 `chrome://extensions`，打開右上角「開發人員模式」
2. 點「載入未封裝項目」，選擇 `extension/` 資料夾
3. 會自動開啟設定頁，設定家長密碼，再啟用需要的管理功能
4. 更新程式後，在擴充功能卡片上按「重新載入」（↻）即可，**不要移除再安裝**（會清掉所有設定）
5. 單元測試：`npm test`（需要 Node.js 18+）

## 使用方式（家長）

1. 在孩子的 Chrome 中登入**孩子的 Google 帳號**，開啟同步（設定 → 你和 Google → 同步 → 確認「擴充功能」已開啟）。
2. 從 Chrome 線上應用程式商店安裝本擴充功能，設定家長密碼。
3. 建議流程：先只啟用「網站瀏覽通知」觀察一段時間 → 依通知整理出白名單 → 啟用「白名單管理」。
4. 孩子在其他電腦登入同一帳號並開啟同步後，Chrome 會自動安裝本擴充功能並同步設定。

## ⚠️ 重要限制與加強防護

Chrome 擴充功能本身無法阻止使用者到 `chrome://extensions` 停用它、使用無痕模式、訪客模式或另一個 Chrome 設定檔。
對年紀較大、懂電腦的孩子，建議搭配以下任一方式：

- **Google Family Link**（13 歲以下兒童帳號）：家長可在 Family Link 管理孩子帳號的擴充功能權限與網站。
- **Windows 原則（家裡電腦）**：以系統管理員身分執行 [`policies/windows-lockdown.reg`](policies/windows-lockdown.reg)（先把裡面的擴充功能 ID 換成上架後的 ID）。效果：
  - 強制安裝本擴充功能，孩子**無法停用或移除**
  - 停用開發人員工具（避免孩子透過開發人員工具修改設定）
  - 停用無痕模式、訪客模式與新增設定檔
  - 這些原則會套用到該電腦上**所有** Chrome 使用者（包含家長自己）。還原請執行 `policies/windows-unlock.reg`。
- 孩子使用 Windows **標準使用者**帳號（非系統管理員），才無法自行刪除上述原則。

## 上架到 Chrome 線上應用程式商店

請見 [docs/PUBLISHING.md](docs/PUBLISHING.md)。打包：`powershell -File scripts/package.ps1`，產生 `dist/kids-safe-browsing-<版本>.zip`。

## 隱私

開發者不收集任何資料；通知只會送到家長自行設定的網址。見 [PRIVACY.md](PRIVACY.md)。
