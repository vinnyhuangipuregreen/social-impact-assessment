# SIA REST API

## 居住縣市與地區

- `GET /api/v1/config` 的 `residenceLocations` 提供縣市 `cities` 與地區 `districts`，含 `id`、`name`、`sort_order`、`active`，地區另有 `city_id`。前台僅提供啟用選項，既有停用選取保留顯示。
- `PATCH /api/v1/me/profile` 使用 `residenceCityId`、`residenceDistrictId`（空字串表示未選）。兩欄選填，地區必須屬於所選縣市。省略兩欄會保留既有居住資料。`GET /api/v1/me` 回傳對應的 snake_case ID 與 `residence_city`、`residence_district` 名稱。
- 系統管理員可透過 `GET /api/v1/admin/residence-locations` 查看全部選項與使用人數；`POST /api/v1/admin/residence-cities`、`POST /api/v1/admin/residence-districts` 新增，`PATCH /api/v1/admin/residence-cities/{id}`、`PATCH /api/v1/admin/residence-districts/{id}` 修改。內容為 `name`、`sortOrder`、`active`；新增地區另需 `cityId`。既有地區的所屬縣市不變。
- 停用不刪除已保存的參照，更名同步顯示。所有維護均寫入稽核，僅全平台 `admin` 可操作。
- 問卷派送預覽可用 `residenceCityId`、`residenceDistrictId` 篩選；會員清單同步回傳縣市、地區 ID 與名稱。既有 `region` 仍保存縣市名稱，供舊名單篩選使用。

初始資料來源：[內政部國土測繪中心行政區代碼服務](https://data.gov.tw/dataset/102011)，2026-11-25 擷取，含 22 縣市及 368 鄉鎮市區。採政府資料開放授權條款第 1 版。正式執行時使用資料庫內可維護的選項，不依賴外部行政區 API。

請求前綴為 `/api/v1`。一般請求使用 `application/json`，二進位上傳使用檔案 MIME。列表共同回傳 `{items,nextCursor,total}`，支援 `limit`（最多 100）及 `cursor`。寫入後台會檢查角色與場次或組織範圍。參與者與職員分別使用 HttpOnly Cookie。

錯誤格式如下，`requestId` 可回查稽核。

```json
{"error":{"code":"SURVEY_CLOSED","message":"問卷已截止","requestId":"…"}}
```

## 前台

| 方法與路徑 | 請求或供應內容 |
| --- | --- |
| GET /config | 方案、階段、告知版本、告知文字與組織 |
| POST /auth/otp/request | `{phone,purpose}`。purpose 可用 login 或 change，回傳 challengeId |
| POST /auth/otp/verify | `{challengeId,code}`，核發本人 Cookie |
| GET /auth/line/start | 初始化授權並建立 state |
| GET /auth/line/callback | 正式模式回呼，須帶 state 與 code |
| POST /auth/line/callback | 僅 Demo，`{state,subject}` |
| POST /auth/logout | 本人登出 |
| GET /me、PATCH /me/profile | 讀取遮罩資料。更新用 `{name,region,member,districtId,chapterId,card}` |
| POST /me/consents | `{purpose,scope,choice,noticeVersion}`。目的為 privacy、tracking 或 marketing |
| POST /me/files、GET /me/files/{id} | 照片上傳與本人讀取 |
| GET /events | 公開活動，可指定 program |
| POST /events/{id}/enrollments | `{action}` 可用 enroll 或 cancel |
| GET /me/enrollments、GET /me/surveys | 本人活動與問卷。問卷包含版本、開放期間、資格與已完成回執 |
| POST /event-surveys/{id}/responses | `{versionId,answers}`。相同答案重送取得同一回執，競爭寫入不同答案回 409 |
| POST /me/invitations/open | `{token}`，需登入為指定收件人 |
| GET /me/rights、POST /me/rights | 讀取或新增權利請求。建立用 `{kind,note}` |

## 後台

| 方法與路徑 | 請求或供應內容 |
| --- | --- |
| POST /auth/admin/login、GET /admin/me | 後台登入、角色與組織 |
| POST /auth/admin/logout | 後台登出 |
| GET /admin/staff | 系統管理員查詢帳號、角色與組織範圍，回傳 `{items,roles}` |
| POST /admin/staff、PATCH /admin/staff/{id} | 系統管理員建立或維護帳號，寫入 `{id,label,role,orgId,active,reason}`；PATCH 不變更 id。admin 須為全平台，至少保留一位啟用 admin；授權異動撤銷該帳號登入並留下稽核紀錄 |
| GET/POST /admin/events、PATCH /admin/events/{id} | 查詢、建立或更新草稿。寫入用 `{program,title,region,venue,orgId,startsAt,endsAt,registrationOpens,registrationCloses,timezone,anchorType}` |
| POST /admin/events/{id}/status | `{status}`，執行狀態轉換 |
| POST /admin/events/{id}/surveys | `{stage,versionId,opensAt,closesAt}`，選填時間可採預設 |
| GET /admin/events/{id}/roster、POST /admin/events/{id}/attendance-imports | 查名冊，或送 `{participantIds,preview}` 預覽、執行批次簽到 |
| GET/POST /admin/survey-versions | 讀取版本，或提交 `{program,stage,form}` 做新草稿 |
| POST /admin/survey-versions/{id}/{publish 或 retire} | 發布或停用版本，舊場次保留版本 |
| GET /admin/dispatch-jobs、POST /admin/dispatch-jobs/preview | 查任務，或用 `{surveyId,audience,cards,regions,statuses}` 預覽 |
| POST /admin/dispatch-jobs | `{previewId,dueAt}` 轉成持久任務。同一預覽重送回原任務 |
| GET /admin/dispatch-jobs/{id} | 逐人嘗試、管道接受、回收、邀請轉換率 |
| POST /admin/dispatch-jobs/{id}/{reminders、cancel 或 reconcile} | 提醒、取消待發、查核不明結果 |
| GET /admin/reports/{recovery、outcomes 或 export} | 支援 eventId、program、member、district、chapter、stage、since、until |
| GET/POST /admin/evidence、POST /admin/evidence/files | 讀取或建立證據，保存附件與內容雜湊 |
| GET /admin/evidence/{id}/file、POST /admin/evidence/{id}/review | 授權附件下載、證據複核 |
| GET/POST /admin/metric-snapshots | 讀取或建立成果快照，建立用 `{eventId,stage,evidenceIds,reason}` |
| POST /admin/metric-snapshots/{id}/review | `{approve,reason}`，核准發布或退回 |
| GET /admin/responses/{id}、POST /admin/responses/{id}/corrections | 依回執查去識別答案，提交 `{answers,reason}` |
| GET /admin/response-reviews、GET/POST /admin/response-reviews/{id} | 查更正差異，`{approve,reason}` 獨立複核 |
| GET /admin/members、POST /admin/members/{id}/review | 會員清單，`{approve,reason}` 卡號核驗 |
| GET /admin/identity-cases、GET /admin/identity-cases/{id}/conflicts | 授權身分案件與重複回覆 |
| POST /admin/identity-cases/{id}/{propose 或 review} | 提案 `{action,reason,fieldConflicts,keep}` 或複核 `{approve,reason}` |
| GET /admin/rights、PATCH /admin/rights/{id} | 查或處理資料權利請求。處理用 `{status,reason}` |
| GET /admin/audit | 全平台管理員可搜尋操作稽核 |

時間欄寫入須附時區。固定問卷期間起點含、終點不含。追蹤窗以場次當地日曆日計算。指南可設定從每人首次啟用日起算。

## 正式管道介接

應用服務在正式模式使用 `SIMP_GATEWAY_URL` 下的 HTTPS JSON 端點，以 `Authorization: Bearer <SIMP_GATEWAY_KEY>` 呼叫。依服務商契約實作下列轉接層，金鑰由部署端設定。

| Gateway POST | 請求欄位 | 結果 |
| --- | --- | --- |
| `otp/send` | phone、code、expiresSeconds、challenge | `{status:"accepted"}` |
| `line/start` | state、callback | `{url}`，LINE 授權 HTTPS 網址 |
| `line/exchange` | code、state、callback | `{issuer,subject,oaReachable}`。驗證授權碼、提供者權杖與請求身分後回傳 |
| `staff/verify` | account、password、mfa | `{id,label,role,org,mfa_verified}`。角色為 operator、identity、analyst、publisher 或 admin |
| `push/line` | issuer、subject、key、url、message | `{status,reference,acceptedAt}`。status 可用 accepted、delivered、failed、retry、unknown。以 key 做管道去重 |
| `push/status` | key | `{status,reference,acceptedAt}`，用原 key 查核 |

LINE OA 觸達狀態異動可由可信 Gateway 呼叫 `POST /api/v1/integrations/line/reachability`，請求為 `{issuer,subject,reachable}` 並帶同一 Bearer 憑證。登入 issuer 與 OA 觸達對應由轉接層確認。只有確知送達的管道結果應回傳 delivered；僅接受傳送時使用 accepted。失敗結果不明時以同一 key 查核。

應用採資料庫持久佇列。正式執行環境應持續運行 Node.js 程序，設定核定個資告知、正式組織與 HTTPS 反向代理。請以停用 Demo 的獨立資料庫執行正式試點。
