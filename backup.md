# Kế hoạch: Chuyển video cũ sang Mega để lưu trữ (giữ nguyên API/link)

> Mục tiêu: giảm dung lượng lưu trên Cloudflare R2 bằng cách chuyển các **video cũ** sang
> Mega, nhưng **URL công khai (`/v/:id`, `/file/:id`) và toàn bộ API giữ nguyên** — người
> dùng đã lưu/chia sẻ link cũ vẫn xem được bình thường.

---

## 1. Vì sao link giữ nguyên được

Link công khai được định danh bằng `id` trong D1, **tách rời khỏi nơi lưu file**:

```
/file/:id  →  tra D1 lấy khoá  →  stream bytes
```

`id` không phụ thuộc file nằm ở R2 hay Mega. Chỉ cần D1 biết "item này ở Mega" thì worker
đổi nguồn lấy bytes, còn URL người dùng đã có **không đổi một ký tự nào**.

## 2. Điểm vướng chính: Mega ≠ HTTP host thường

| | R2 (hiện tại) | Mega |
|---|---|---|
| Lấy bytes | `GET key` ra ngay | File **mã hoá đầu-cuối (AES)** |
| Link công khai | Trỏ thẳng `<video src>` được | `mega.nz/file/xxx#key` mở web app để giải mã trong trình duyệt — **không** trỏ thẳng được |
| Range (tua video) | Hỗ trợ sẵn | Phải tự tính offset + giải mã AES-CTR |

➡️ **Không** dùng redirect 302 sang Mega được. Cách duy nhất giữ API y hệt: **worker đóng
vai proxy** — với item ở Mega, worker tải chunk → giải mã → stream ra như đang làm với R2.

---

## 3. Kiến trúc sau khi làm

```
Client  ──GET /file/:id──►  Worker
                              │  tra D1: storage = ?
                    ┌─────────┴─────────┐
              storage='r2'         storage='mega'
                    │                   │
              serveR2()            serveMega()
              (như cũ)         tải từ Mega → giải mã AES → stream
                    │                   │
                  R2 Bucket          Mega account
```

API công khai **KHÔNG đổi**: `/v/:id`, `/file/:id` (+ HEAD), `/api/items`, `/api/upload`,
`/api/items/:id` giữ nguyên hành vi.

---

## 4. Thay đổi schema (D1)

Thêm cột vào bảng `items` (migration, không phá dữ liệu cũ):

```sql
ALTER TABLE items ADD COLUMN storage    TEXT NOT NULL DEFAULT 'r2';  -- 'r2' | 'mega'
ALTER TABLE items ADD COLUMN mega_handle TEXT;   -- file handle trên Mega
ALTER TABLE items ADD COLUMN mega_key    TEXT;   -- khoá giải mã (base64)
ALTER TABLE items ADD COLUMN size        INTEGER; -- byte, cần cho Content-Length/Range
```

- Item cũ mặc định `storage='r2'` → không ảnh hưởng gì.
- Khi migrate 1 video: set `storage='mega'`, điền `mega_handle` + `mega_key` + `size`,
  rồi mới xoá object khỏi R2.

---

## 5. Thay đổi worker (`worker/src/index.ts`)

### 5.1. Route `/file/:id` — rẽ nhánh theo `storage`

```ts
const row = await env.DB.prepare(
  "SELECT r2_key, mime, storage, mega_handle, mega_key, size FROM items WHERE id = ?"
).bind(id).first();
if (!row) return 404;

if (row.storage === "mega") {
  return serveMega(env, row, req);     // hàm mới
}
return serveR2(env, row.r2_key, row.mime, req);  // như cũ
```

### 5.2. Hàm mới `serveMega()`

Trách nhiệm:
1. Đảm bảo có session Mega (login 1 lần, cache session trong biến module/KV).
2. Xin URL tải tạm của file theo `mega_handle` (Mega API `g` command).
3. `fetch` bytes (áp Range nếu client yêu cầu tua).
4. **Giải mã AES-CTR** với `mega_key` — CTR cho phép seek: tính counter từ byte offset.
5. Trả về `Response` với `Content-Type`, `Accept-Ranges: bytes`, `Content-Range` (nếu 206),
   `Content-Length`, `Cache-Control` — **giống hệt `serveR2`**.

> Lưu ý: Mega không có SDK chạy sẵn trên Worker → phải tự viết phần login + `g` command +
> giải mã bằng WebCrypto (`crypto.subtle`, thuật toán AES-CTR).

---

## 6. Script migrate video cũ (chạy 1 lần, ngoài worker)

Chạy tại máy (Node) hoặc script tạm:

```
Cho mỗi video cũ cần chuyển:
  1. Tải file từ R2 (qua /file/:id hoặc R2 API).
  2. Upload lên Mega  → nhận mega_handle + mega_key.
  3. UPDATE items SET storage='mega', mega_handle=?, mega_key=?, size=? WHERE id=?
  4. Kiểm tra phát được qua /v/:id (giải mã + tua OK).
  5. CHỈ khi bước 4 OK → xoá object R2 (env.BUCKET.delete(r2_key)).
```

**Nguyên tắc an toàn: verify xong mới xoá R2.** Nếu lỗi, dữ liệu vẫn còn ở R2.

Tiêu chí chọn "video cũ": ví dụ `type='video' AND created_at < <mốc thời gian>`.

---

## 7. Rủi ro & cân nhắc (đọc trước khi quyết)

- **Băng thông/CPU worker**: mọi lượt xem video Mega giờ đi qua worker (tải → giải mã →
  stream). Worker có giới hạn CPU-time/request; video lớn có thể chạm giới hạn. R2 trước đây
  stream trực tiếp nên nhẹ hơn nhiều.
- **Rate-limit & quota Mega**: tài khoản free bị bóp băng thông (~5GB/ngày/IP). Dùng làm CDN
  công khai dễ bị chặn tải giữa chừng.
- **Độ trễ**: thêm 1 chặng (Mega → worker) → video load chậm hơn, tua có thể khựng.
- **Bảo mật**: `mega_key` nằm trong D1 = ai có DB là giải mã được. Chấp nhận được vì file
  vốn công khai qua link, nhưng cần biết.
- **Bảo trì**: tự implement giao thức Mega → dễ hỏng khi Mega đổi API.

## 8. Phương án thay thế (cân nhắc trước khi làm Mega)

- **R2 vốn rất rẻ + miễn phí egress** — nếu mục tiêu là tiết kiệm tiền, kiểm tra hoá đơn
  R2 thực tế trước; có thể chưa cần chuyển.
- **R2 lifecycle / Infrequent Access**: hạ storage class cho object cũ, vẫn giữ egress miễn
  phí và Range trực tiếp — đơn giản hơn Mega nhiều.
- **Host khác hỗ trợ direct-download + Range** (Backblaze B2, S3 Glacier-ish...) nếu cần
  rời hẳn R2 mà không muốn proxy.

---

## 9. Checklist thực thi

- [ ] Xác nhận lý do chuyển (tiết kiệm tiền / hết quota) + dung lượng video cũ.
- [ ] Migration schema: thêm 4 cột vào `items` (mục 4).
- [ ] Viết `serveMega()` + rẽ nhánh trong `/file/:id` và HEAD (mục 5).
- [ ] Viết + test module login/tải/giải mã Mega (unit test với 1 file mẫu).
- [ ] Script migrate + verify + xoá R2 an toàn (mục 6).
- [ ] Chạy thử trên 1 video cũ, kiểm tra: xem được, tua được, HEAD trả đúng size.
- [ ] Migrate hàng loạt theo mốc thời gian.
- [ ] Theo dõi CPU-time worker + băng thông Mega sau khi lên.

---

**Kết luận:** Giữ nguyên API/link là **khả thi 100%** — chỉ cần D1 lưu thêm "file ở đâu" và
worker proxy khi ở Mega. Chi phí đánh đổi là **CPU/băng thông worker + phụ thuộc Mega**;
nên cân nhắc R2 lifecycle trước nếu chỉ để tiết kiệm.
