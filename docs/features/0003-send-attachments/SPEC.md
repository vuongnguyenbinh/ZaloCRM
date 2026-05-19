# Feature 0003: Gửi file & ảnh từ giao diện chat web

## 1. Mô tả

Hiện tại giao diện chat web chỉ gửi được tin nhắn text. Để gửi ảnh/file, sale phải chuyển sang Zalo trên điện thoại — phá vỡ flow làm việc.

Feature này thêm:
1. **Backend endpoint** `POST /api/v1/conversations/:id/attachments` — nhận multipart upload, đẩy buffer trực tiếp vào `api.sendMessage(...)` của zca-js.
2. **Frontend UI** — paperclip button trong `MessageThread`, drag-and-drop area, image preview trước khi gửi.

## 2. User Stories

- **US-0001:** Là Sale, tôi muốn click icon paperclip trong khung chat → chọn ảnh/file → preview → gửi → khách nhận như nhắn từ Zalo điện thoại.
- **US-0002:** Là Sale, tôi muốn kéo-thả ảnh từ desktop vào khung chat để gửi nhanh.
- **US-0003:** Là Sale, tôi muốn thấy progress / loading khi đang upload file lớn (vài MB).

## 3. Business Rules

- **BR-0001:** Reuse `requireZaloAccess('chat')` permission từ endpoint send-text.
- **BR-0002:** Rate limit qua `zaloRateLimiter.checkLimits()` — file count như 1 send.
- **BR-0003:** Giới hạn kích thước **20MB / file** (Zalo client limit). Reject với 413 nếu lớn hơn.
- **BR-0004:** Whitelist MIME types: ảnh (`image/jpeg`, `image/png`, `image/gif`, `image/webp`), file thông dụng (`application/pdf`, `application/msword`, `application/vnd.openxmlformats-*`, `text/plain`, `application/zip`). Reject với 415 nếu type không match.
- **BR-0005:** Chỉ nhận 1 file/request. Multi-file upload làm sau (track loop riêng).
- **BR-0006:** Lưu Message vào DB với `contentType` chính xác (`image`/`file`) và `attachments` chứa metadata (filename, size, mime).
- **BR-0007:** Emit Socket.IO `chat:message` để các tab khác sync ngay.

## 4. API contract

### POST /api/v1/conversations/:id/attachments

**Auth:** JWT + `requireZaloAccess('chat')`.

**Content-Type:** `multipart/form-data`

**Form fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | ✅ | Single file, max 20MB |

**Response 201:**
```json
{
  "id": "<message-uuid>",
  "conversationId": "...",
  "senderType": "self",
  "content": "<filename>",
  "contentType": "image | file",
  "attachments": [{
    "filename": "abc.jpg",
    "size": 123456,
    "mimeType": "image/jpeg",
    "zaloMsgId": "...",
    "width": 1200,    // chỉ ảnh
    "height": 800     // chỉ ảnh
  }],
  "sentAt": "ISO8601",
  "zaloMsgId": "..."
}
```

**Errors:**
- `400` — không có file trong form
- `403` — không có quyền `chat`
- `404` — conversation không tồn tại trong org
- `413` — file > 20MB
- `415` — MIME type không cho phép
- `429` — rate limit (>200 tin/ngày)
- `502` — zca-js sendMessage thất bại

## 5. Edge cases

- **EC-0001:** File rỗng (0 bytes) → 400.
- **EC-0002:** Filename chứa ký tự đặc biệt (Unicode VN, emoji) → safe vì truyền qua Buffer, không qua filesystem.
- **EC-0003:** Zalo trả error (mất kết nối giữa chừng) → 502, không insert Message vào DB.
- **EC-0004:** Concurrent upload trong cùng conversation → mỗi request có rate limit check riêng, ok.
- **EC-0005:** Ảnh không có dimension metadata → vẫn upload được, omit width/height.
- **EC-0006:** Group thread → cùng flow, `threadType=1`.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Upload ảnh JPG 2MB → 201, file đến trên Zalo của khách, Message hiển thị trong UI với image preview.
- [ ] **AC-0002:** Upload PDF 5MB → 201, hiện file card với nút download.
- [ ] **AC-0003:** Upload file 25MB → 413 với message rõ.
- [ ] **AC-0004:** Upload file `.exe` (MIME `application/x-msdownload`) → 415.
- [ ] **AC-0005:** Không có file trong form → 400.
- [ ] **AC-0006:** User member chỉ có `read` permission → 403.
- [ ] **AC-0007:** Drag-and-drop file vào chat area → tự fill vào file picker, hiện preview.
- [ ] **AC-0008:** Click paperclip → file dialog mở → chọn ảnh → preview → bấm Gửi → ảnh hiện trong thread.
- [ ] **AC-0009:** Đang upload → button gửi disabled + loading.
- [ ] **AC-0010:** Build cả BE + FE pass.

## 7. Dependencies

- `@fastify/multipart` (đã có trong `package.json`, chưa register vào app).
- zca-js `api.sendMessage({ msg, attachments: [{data: Buffer, filename, metadata}] }, threadId, type)`.
- Frontend: native `<input type="file">` + drag/drop events. Không cần lib mới.

## 8. Out of scope (feature sau)

- Multi-file upload (chọn nhiều cùng lúc).
- Voice message ghi từ trình duyệt (cần MediaRecorder + codec convert).
- Sticker picker.
- Forward file từ message khác.

## 9. Test plan

### Integration
- Real Postgres + Fastify inject với `formAutoContent` cho multipart.
- Mock `zaloPool.getInstance(...)` trả về `api.sendMessage` mock.
- Verify: 201 → Message row insert đúng, attachments JSON đúng shape.
- Verify: 413/415/400/403/429/502.

### Manual UI
- Click paperclip → chọn ảnh PNG → preview → Gửi → image bubble hiện trong thread + Zalo điện thoại nhận file.
- Drag PDF từ Finder → preview file card → Gửi → khách nhận PDF.
- Upload 30MB → toast 413.
