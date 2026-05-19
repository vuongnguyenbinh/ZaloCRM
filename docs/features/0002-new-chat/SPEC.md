# Feature 0002: Bắt đầu cuộc trò chuyện mới với khách hàng

## 1. Mô tả

Hiện tại `/chat` chỉ hiển thị cuộc trò chuyện đã tồn tại — Conversation chỉ được tạo khi listener Zalo nhận tin nhắn. Sale muốn chủ động liên hệ với khách (đã có trong danh bạ) mà không phải chuyển sang điện thoại nhắn trước.

Feature này thêm:
1. **Backend endpoint** `POST /api/v1/conversations` — tạo conversation rỗng từ `accountId + contactId`.
2. **Frontend dialog** "+ Chat mới" ở đầu `ConversationList` — chọn Zalo account + contact đã sync → tạo conversation → auto-select.

## 2. User Stories

- **US-0001:** Là Sale, sau khi sync danh bạ Zalo, tôi muốn bấm "+ Chat mới" → chọn khách → bắt đầu nhắn ngay từ giao diện web mà không cần dùng điện thoại.
- **US-0002:** Là Sale member, tôi chỉ thấy được các Zalo account mà tôi có quyền `chat` trở lên ở dialog.

## 3. Business Rules

- **BR-0001:** Contact phải có `zaloUid` (đã sync danh bạ). Không tạo được conversation với contact chưa có `zaloUid`.
- **BR-0002:** Idempotent — nếu Conversation đã tồn tại (`zaloAccountId + externalThreadId=contact.zaloUid`), trả về conversation hiện có thay vì tạo mới (HTTP 200 thay vì 201).
- **BR-0003:** Yêu cầu permission `chat` trở lên trên Zalo account (theo `requireZaloAccess('chat')`). Owner/admin bypass.
- **BR-0004:** Contact + Zalo account phải thuộc cùng `orgId` của user.
- **BR-0005:** Conversation mới tạo với `threadType='user'` (1-1), `unreadCount=0`, `isReplied=true` (theo schema defaults).

## 4. API contract

### POST /api/v1/conversations

**Auth:** JWT bắt buộc.

**Request body:**
```json
{
  "accountId": "<zalo-account-uuid>",
  "contactId": "<contact-uuid>"
}
```

**Response 201 (created)** / **200 (already exists):**
```json
{
  "id": "<conversation-uuid>",
  "orgId": "...",
  "zaloAccountId": "...",
  "contactId": "...",
  "threadType": "user",
  "externalThreadId": "<contact.zaloUid>",
  "unreadCount": 0,
  "isReplied": true,
  "contact": { "id": "...", "fullName": "...", "phone": "...", "avatarUrl": "...", "zaloUid": "..." },
  "zaloAccount": { "id": "...", "displayName": "...", "zaloUid": "..." },
  "messages": []
}
```

**Errors:**
- `400` — body thiếu field hoặc contact chưa có `zaloUid`
- `403` — user không có quyền `chat` trên Zalo account
- `404` — account/contact không tồn tại trong org

## 5. Edge cases

- **EC-0001:** Contact và account cùng `orgId` nhưng contact chưa sync (`zaloUid=null`) → 400 với message "Contact chưa được sync từ Zalo".
- **EC-0002:** Conversation đã tồn tại (vì khách đã nhắn lần nào đó) → return existing với HTTP 200.
- **EC-0003:** Race condition — 2 user cùng bấm tạo cho 1 cặp account+contact → 1 thắng (201), 1 trả về existing (200). Đảm bảo bằng unique constraint `(zaloAccountId, externalThreadId)` có sẵn trong schema.
- **EC-0004:** User member không có ZaloAccountAccess → 403 (middleware `requireZaloAccess('chat')` xử lý).

## 6. Acceptance Criteria

- [ ] **AC-0001:** `POST /conversations` với account+contact hợp lệ → 201, conversation row mới, có thể GET ngay.
- [ ] **AC-0002:** Gọi 2 lần liên tiếp với cùng input → lần 2 trả 200 với cùng `id`.
- [ ] **AC-0003:** Body thiếu `accountId` hoặc `contactId` → 400.
- [ ] **AC-0004:** Contact `zaloUid=null` → 400.
- [ ] **AC-0005:** User member không có access → 403.
- [ ] **AC-0006:** Contact của org khác → 404.
- [ ] **AC-0007:** FE dialog: chọn account + contact → click "Bắt đầu" → conversation xuất hiện trong list + auto-select.
- [ ] **AC-0008:** Build TypeScript pass cả BE và FE.

## 7. Dependencies

- Backend: tái sử dụng `requireZaloAccess('chat')` middleware có sẵn.
- Frontend: tái sử dụng API contact search có sẵn (`/contacts?search=...`).
- Schema: không thay đổi (đã có unique constraint `(zaloAccountId, externalThreadId)`).

## 8. Test plan

### Unit
- Validation: thiếu field → 400; contact zaloUid=null → 400.
- Idempotency: 2nd call returns existing.
- Permission: role gate qua middleware mock.

### Integration
- Real Postgres: tạo org + account + contact → endpoint trả 201 + DB có row mới.
- Gọi 2 lần → count conv = 1.
- Cross-org contact → 404.

### Manual UI
- Trên `/chat`: bấm "+ Chat mới" → dialog hiện autocomplete contact đã sync.
- Chọn contact → bấm "Bắt đầu" → conversation mới xuất hiện ở đầu list + tự select.
- Reload page → conversation vẫn còn (persisted).
