# Feature 0001: Đồng bộ lịch sử tin nhắn Zalo

## 1. Mô tả

Khi server đang offline (downtime/restart) hoặc khi user thêm 1 tài khoản Zalo mới, các tin nhắn đến/đi đang bị bỏ lỡ — chưa được lưu vào CRM. Feature này:

1. **Tự động hứng tin nhắn offline** đến trong lúc server downtime (sự kiện `old_messages` của zca-js).
2. **Đồng bộ chủ động lịch sử nhóm chat** (group thread) khi user yêu cầu, dùng `api.getGroupChatHistory(groupId, count)`.

> ⚠️ **Out of scope:** Lịch sử 1-1 chat. zca-js 2.1.2 không hỗ trợ API `getUserChatHistory`. Lịch sử cuộc gọi (call log) cũng không khả thi — zca-js không phát event call nào.

## 2. User Stories liên quan

- **US-0001:** Là Sale, sau khi server CRM restart, tôi muốn các tin nhắn khách hàng gửi tới trong lúc downtime vẫn được lưu vào CRM để không bỏ sót.
- **US-0002:** Là Admin, sau khi thêm 1 tài khoản Zalo có sẵn nhiều nhóm chat, tôi muốn đồng bộ N tin nhắn gần đây của các nhóm này để có context khi reply.

## 3. Business Rules

- **BR-0001 (dedupe):** Mỗi tin nhắn Zalo có `zaloMsgId` duy nhất. Khi sync/offline message, nếu `zaloMsgId` đã tồn tại trong DB → **skip insert**, không tạo bản ghi trùng.
- **BR-0002 (offline tự động):** Khi listener kết nối lại, sự kiện `old_messages` được zca-js phát tự động → backend lưu tin và emit Socket.IO `chat:message` để UI cập nhật.
- **BR-0003 (group sync chủ động):** Endpoint `POST /api/v1/zalo-accounts/:id/sync-group-history` đồng bộ tối đa `count` (mặc định 50, tối đa 200) tin nhắn của 1 group hoặc tất cả group.
- **BR-0004 (permission):** Sync group history yêu cầu role `owner` hoặc `admin` (tương tự `sync-contacts`).
- **BR-0005 (rate limit):** Khi sync nhiều group, mỗi request giãn cách 1 giây để tránh Zalo rate-limit.
- **BR-0006 (1-1 chat):** Không sync history 1-1. Nếu user gọi API yêu cầu sync với threadType=user → trả 400 với message rõ ràng.

## 4. Input / Output

### 4.1. Sự kiện tự động `old_messages` (không có API)

- **Trigger:** zca-js listener phát event `old_messages(msgs, threadType)` khi WS reconnect.
- **Hành vi:** Backend chuyển từng `msg` qua `handleIncomingMessage` (dedupe bằng `zaloMsgId`).
- **Output:** Socket.IO `chat:message` emit cho từng tin mới insert.

### 4.2. `POST /api/v1/zalo-accounts/:id/sync-group-history`

**Request body:**
```json
{
  "groupId": "string | optional",  // nếu omit → sync tất cả group
  "count": 50                       // tối đa 200, mặc định 50
}
```

**Response 200:**
```json
{
  "success": true,
  "synced": [
    { "groupId": "g1", "groupName": "Team Sale", "inserted": 23, "skipped": 27 }
  ],
  "totalInserted": 23,
  "totalSkipped": 27
}
```

**Errors:**
- `400` — `count > 200` hoặc `account chưa connect`
- `403` — role không phải owner/admin
- `404` — account không tồn tại trong org

## 5. Edge Cases

- **EC-0001:** `zaloMsgId` rỗng/null → vẫn insert (không dedupe được, nhưng không crash).
- **EC-0002:** Tin "tự gửi từ thiết bị khác" (`isSelf=true`) cũng cần lưu → `handleIncomingMessage` đã xử lý.
- **EC-0003:** Server crash giữa lúc sync → resume an toàn vì có `zaloMsgId` dedupe.
- **EC-0004:** Group không tồn tại trong CRM (chưa có conversation) → `findOrCreateConversation` tự tạo (logic có sẵn).
- **EC-0005:** Zalo trả về 0 tin (group rỗng/mới) → vẫn return success với `inserted: 0`.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Index `zaloMsgId` được tạo qua Prisma migration; query plan dùng index khi check dedupe.
- [ ] **AC-0002:** Gửi 1 tin từ điện thoại trong lúc backend dừng → start backend lại → tin nhắn xuất hiện trong DB với đúng `senderUid`, `content`, `sentAt`.
- [ ] **AC-0003:** Sync 1 group đã có 10 tin trong DB → response trả `skipped: 10, inserted: <số tin mới>`.
- [ ] **AC-0004:** Gọi sync 2 lần liên tiếp → lần 2 trả `inserted: 0` (toàn bộ skipped).
- [ ] **AC-0005:** Sync với `count: 300` → response 400 "count exceeds limit 200".
- [ ] **AC-0006:** User role `member` gọi endpoint → response 403.
- [ ] **AC-0007:** Build TypeScript pass: `cd backend && npm run build` không lỗi.

## 7. Dependencies

- Prisma schema: cần thêm `@@index([zaloMsgId])` vào model `Message`.
- zca-js 2.1.2 (đã cài): `api.getGroupChatHistory(groupId, count)` + listener event `old_messages`.
- Module liên quan: `chat/message-handler.ts`, `zalo/zalo-listener-factory.ts`, `zalo/zalo-sync-routes.ts`, `zalo/zalo-message-helpers.ts`.

## 8. Deployment notes

Sau khi merge và pull về môi trường staging/prod:

```bash
cd backend
npm install                  # (nếu có thay đổi deps — feature này thì không)
npm run db:push              # Áp dụng @@index([zaloMsgId]) — additive, không drop dữ liệu
npm run build
# restart service
```

`db:push` an toàn vì chỉ thêm một index mới (operation `CREATE INDEX`). Không có column nào bị thay đổi/xoá.

## 9. Test suite

Test tự động được implement với Vitest. Chạy bằng:

```bash
cd backend
npm run test          # All
npm run test:unit     # Unit only — không cần Docker
npm run test:integration  # Integration — cần Docker chạy (testcontainers)
npm run test:watch    # Watch mode khi develop
npm run test:coverage # Generate coverage report
```

**Hiện trạng:** 49 tests pass (~10s).

### 9.1. Unit tests (`tests/unit/`)

| File | Coverage |
|------|----------|
| [message-handler.test.ts](../../../backend/tests/unit/message-handler.test.ts) | Dedupe logic (BR-0001), group thread upsert, self-message handling |
| [process-zalo-message.test.ts](../../../backend/tests/unit/process-zalo-message.test.ts) | Name resolution + cache, group name, content serialization |
| [detect-content-type.test.ts](../../../backend/tests/unit/detect-content-type.test.ts) | Mapping `msgType` → contentType cho 13 case |
| [sync-group-history-route.test.ts](../../../backend/tests/unit/sync-group-history-route.test.ts) | Validation (AC-0005/0006), single-group sync, all-groups sync, default count |

### 9.2. Integration tests (`tests/integration/`)

Dùng `@testcontainers/postgresql` spin up Postgres 16 ephemeral, chạy `prisma db push` schema vào, dùng adapter PrismaPg giống production.

| File | Coverage |
|------|----------|
| [message-handler.integration.test.ts](../../../backend/tests/integration/message-handler.integration.test.ts) | Dedupe end-to-end (AC-0001, AC-0004), reuse conversation, unreadCount lifecycle |
| [sync-group-history.integration.test.ts](../../../backend/tests/integration/sync-group-history.integration.test.ts) | HTTP roundtrip + DB: AC-0003 (inserted/skipped count), AC-0004 (idempotent), AC-0005 (validation), AC-0006 (role) |

### 9.3. Bugs phát hiện thêm trong quá trình test

- ~~**Bug `unreadCount` double-count:** `findOrCreateConversation` seed `unreadCount: 1` + `updateConversationAfterMessage` increment +1 trên cùng 1 insert đầu tiên → conversation mới có `unreadCount = 2` sau 1 tin contact.~~ → **Đã fix** trong cùng PR này: `findOrCreateConversation` tạo conv với defaults schema (`unreadCount=0, isReplied=true`), để mọi logic count tập trung ở `updateConversationAfterMessage`. Test integration verify cả 4 case (new+self, new+contact, transition contact→self, reset cycle).

## 10. Cách test thủ công

### Test 1 — Offline message catch-up (AC-0002)
1. Server đang chạy, Zalo account A đã connect.
2. `docker compose stop app` (hoặc kill backend).
3. Từ Zalo điện thoại khác, gửi 2 tin tới A.
4. `docker compose start app` (hoặc start backend lại).
5. Sau ~10-30s, kiểm tra DB: 2 message mới phải có trong `messages` với đúng `zalo_msg_id`.
6. Log backend phải có dòng: `[zalo:<id>] old_messages processed 2/2 (user)`.

### Test 2 — Group history sync (AC-0003 + AC-0004)
```bash
# Sync 1 group cụ thể, lấy 30 tin gần nhất
curl -X POST http://localhost:3080/api/v1/zalo-accounts/<accountId>/sync-group-history \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"groupId":"<groupId>","count":30}'

# Lần đầu: inserted >= 1, skipped tuỳ
# Lần 2 ngay sau: inserted = 0, skipped = 30 (chứng minh dedupe hoạt động)
```

### Test 3 — Sync tất cả group
```bash
curl -X POST http://localhost:3080/api/v1/zalo-accounts/<accountId>/sync-group-history \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"count":50}'
```
Kiểm tra response `synced` array có nhiều entries, có rate-limit 1s giữa các group (log timing).

### Test 4 — Bad input (AC-0005)
```bash
curl -X POST .../sync-group-history -d '{"count":500}'
# → 400 "count must be between 1 and 200"
```
