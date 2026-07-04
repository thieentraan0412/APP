# Đề xuất chức năng mới — CaptureShare

> Tài liệu đề xuất các tính năng bổ sung cho app **CaptureShare** (Tauri desktop + Cloudflare Worker).
> Mỗi mục nêu: **vấn đề đang gặp**, **giải pháp đề xuất**, **thay đổi kỹ thuật cần làm**, **độ ưu tiên** và **độ khó**.
> Ngày lập: 2026-07-04.

---

## 0. Tóm tắt hiện trạng

App hiện đã có:
- 📸 Chụp toàn màn hình / chụp vùng / 🎥 quay video (ffmpeg sidecar)
- ✏️ Annotate: khung (box), mũi tên (arrow), số bước (step), ghi chú (note)
- ☁️ Upload lên R2 + metadata D1 → link chia sẻ công khai `/v/:id`
- 🗂 Thư viện: xem / copy link / mở / sửa annotate / xoá, lọc theo thời gian & loại
- 🔳 Quét QR, 📊 màn hình Usage (ước lượng hạn mức Cloudflare)
- ⌨️ Phím tắt toàn cục tùy chỉnh, 🔔 system tray, 🔄 auto-update qua GitHub Releases

Các đề xuất dưới đây **kế thừa** kiến trúc này, ưu tiên tận dụng R2/D1/Worker sẵn có, tránh thêm dịch vụ mới không cần thiết.

---

## 1. Bảo mật & kiểm soát link chia sẻ 🔐

**Ưu tiên: CAO · Độ khó: Trung bình**

### Vấn đề
Mọi link `/v/:id` hiện **công khai vĩnh viễn** — ai có link đều xem được, không thể thu hồi, không hết hạn. Rủi ro lộ ảnh chụp màn hình nhạy cảm (thông tin cá nhân, mã, dữ liệu nội bộ).

### Đề xuất
- **Link hết hạn (expiry):** cho phép đặt thời gian sống (1 giờ / 1 ngày / 7 ngày / vĩnh viễn) khi upload.
- **Bảo vệ bằng mật khẩu:** thêm passcode; trang `/v/:id` yêu cầu nhập trước khi xem.
- **Thu hồi / vô hiệu hoá link:** nút "Ngừng chia sẻ" trong thư viện (giữ file nhưng chặn truy cập công khai).
- **Xem 1 lần rồi tự xoá (burn after read):** tuỳ chọn cho ảnh nhạy cảm.

### Thay đổi kỹ thuật
- **D1 schema:** thêm cột `expires_at INTEGER`, `password_hash TEXT`, `revoked INTEGER DEFAULT 0`, `view_once INTEGER DEFAULT 0`.
- **Worker `/v/:id` & `/file/:id`:** kiểm tra `expires_at`, `revoked`, xác thực mật khẩu (dùng WebCrypto SHA-256, không lưu plaintext).
- **Desktop:** thêm ô cấu hình trong màn hình kết quả upload + nút thu hồi trong `LibraryScreen`.

---

## 2. Đồng bộ & lịch sử clipboard nhanh 📋

**Ưu tiên: CAO · Độ khó: Thấp**

### Vấn đề
Sau khi upload xong người dùng thường chỉ cần **link** hoặc **ảnh trong clipboard**. Hiện luồng còn qua nhiều bước.

### Đề xuất
- **Auto-copy link ngay sau upload** (tuỳ chọn bật/tắt trong Settings).
- **Copy trực tiếp ảnh (không upload):** phím tắt chụp-rồi-copy-vào-clipboard cho lúc chỉ cần dán nhanh vào chat/mail, không cần link.
- **Định dạng copy tuỳ chọn:** link thuần, Markdown `![](url)`, hoặc HTML `<img>` — hữu ích khi dán vào tài liệu/PR.

### Thay đổi kỹ thuật
- **Desktop:** thêm setting `autoCopyLink`, `copyFormat`; tận dụng `plugin-clipboard-manager` đã có (`writeText`, `writeImage`).
- Thêm 1 phím tắt "chụp & copy ảnh" trong `SettingsScreen`.

---

## 3. Chú thích nâng cao trong Editor ✏️➕

**Ưu tiên: TRUNG BÌNH · Độ khó: Trung bình**

### Vấn đề
Editor mới có box / arrow / step / note. Thiếu các công cụ annotate phổ biến khi hướng dẫn/báo lỗi.

### Đề xuất
- **Làm mờ / che (blur / pixelate / block):** che thông tin nhạy cảm (email, token, mặt người) — rất cần khi chia sẻ công khai.
- **Highlight / bút dạ quang** vùng chữ nhật bán trong suốt.
- **Chữ tự do (free text)** ngoài note dạng ghim.
- **Vẽ tay (pen / freehand)** cho khoanh tròn nhanh.
- **Crop / cắt ảnh** trước khi lưu.
- **Undo/Redo** (Ctrl+Z / Ctrl+Y) nếu chưa có.

### Thay đổi kỹ thuật
- **Konva/react-konva** đã sẵn — thêm shape mới (`Line` freehand, `Rect` filter blur qua `Konva.Filters.Blur`).
- Mở rộng `types.ts`: thêm `Blur`, `Highlight`, `FreeText`, `PenPath` vào `Annotations`.
- **Lưu ý:** blur/pixelate phải được **flatten cứng vào ảnh gốc** trước upload (không chỉ overlay) để tránh lộ dữ liệu khi tải ảnh gốc `/orig/:id`.

---

## 4. Tổ chức thư viện: thư mục, tag, tìm kiếm 🗂🔎

**Ưu tiên: TRUNG BÌNH · Độ khó: Trung bình**

### Vấn đề
Thư viện chỉ lọc theo thời gian & loại. Khi số item tăng, khó tìm lại đúng ảnh.

### Đề xuất
- **Tìm kiếm theo tiêu đề / nội dung note.**
- **Tag / nhãn màu** để nhóm (bug, design, hoá đơn…).
- **Đánh dấu yêu thích (star).**
- **Xoá hàng loạt (multi-select)** thay vì xoá từng cái.

### Thay đổi kỹ thuật
- **D1:** thêm cột `tags TEXT` (JSON mảng), `starred INTEGER`; hoặc bảng phụ `tags`.
- **Worker `/api/items`:** hỗ trợ query param `?q=`, `?tag=`, `?starred=1`.
- **Desktop:** UI filter + ô search trong `LibraryScreen`.

---

## 5. OCR — trích xuất chữ từ ảnh 🔤

**Ưu tiên: TRUNG BÌNH · Độ khó: Trung bình–Cao**

### Vấn đề
Người dùng hay chụp để **copy chữ** (mã lỗi, số, đoạn text không select được).

### Đề xuất
- Nút **"Sao chép chữ trong ảnh"** ngay sau khi chụp / trong Editor.
- Ứng dụng đã có tiền lệ xử lý ảnh (jsQR quét QR) → thêm OCR là bước tự nhiên.

### Thay đổi kỹ thuật
- **Phương án A (offline):** dùng Windows OCR API qua Rust (`windows` crate) — nhanh, không cần mạng, không tốn hạn mức.
- **Phương án B:** thư viện WASM (Tesseract) ở frontend — nặng hơn, đa nền tảng.
- Khuyến nghị **Phương án A** vì app hiện chỉ chạy Windows.

---

## 6. GIF / cắt & nén video 🎬

**Ưu tiên: TRUNG BÌNH · Độ khó: Trung bình**

### Vấn đề
Video quay ra dạng mp4 đầy đủ; chia sẻ nhanh "thao tác 5 giây" thì file to, tốn R2 storage & Class B ops (đã cảnh báo trong Usage).

### Đề xuất
- **Xuất GIF** cho clip ngắn (chèn vào PR/chat tiện, autoplay).
- **Cắt (trim) video** đầu/cuối trước khi upload.
- **Chọn mức nén / độ phân giải** (720p/1080p, bitrate) để giảm dung lượng.

### Thay đổi kỹ thuật
- **ffmpeg sidecar** đã có — thêm lệnh `-ss/-to` (trim), `-vf palettegen` (GIF), preset nén trong `record.rs`/`ffmpeg.rs`.
- **Desktop:** thanh trim đơn giản (2 handle) trong màn hình xem lại video trước khi upload.

---

## 7. Cấu hình khởi động & trải nghiệm nền 🚀

**Ưu tiên: THẤP · Độ khó: Thấp**

### Đề xuất
- **Khởi động cùng Windows** (auto-launch) — tuỳ chọn trong Settings.
- **Thu nhỏ xuống tray khi đóng** thay vì thoát hẳn.
- **Âm thanh / thông báo** khi chụp/upload xong (tuỳ chọn tắt).
- **Chế độ tối / sáng (theme)** theo hệ thống.

### Thay đổi kỹ thuật
- Plugin `tauri-plugin-autostart` cho auto-launch.
- Xử lý sự kiện `CloseRequested` để minimize-to-tray.
- CSS biến theme (đã có `App.css`) + toggle trong Settings.

---

## 8. Đa thiết bị / dọn dẹp tự động ♻️

**Ưu tiên: THẤP · Độ khó: Trung bình**

### Vấn đề
Usage cảnh báo R2 storage tăng dần; không có cách dọn tự động các item cũ.

### Đề xuất
- **Tự xoá item quá X ngày** (tuỳ chọn, ví dụ 30/90 ngày) — cron trên Worker.
- **Nén/dọn "thùng rác":** xoá mềm rồi purge sau N ngày.

### Thay đổi kỹ thuật
- **Cloudflare Cron Trigger** trong `wrangler.toml` → handler `scheduled()` quét `expires_at`/tuổi item, xoá R2 + D1.
- **D1:** cột `deleted_at` cho xoá mềm.

---

## Bảng tổng hợp ưu tiên

| # | Chức năng | Ưu tiên | Độ khó | Tận dụng sẵn có |
|---|-----------|---------|--------|-----------------|
| 1 | Bảo mật link (hết hạn / mật khẩu / thu hồi) | 🔴 Cao | Trung bình | Worker + D1 |
| 2 | Clipboard nhanh & định dạng copy | 🔴 Cao | Thấp | plugin-clipboard |
| 3 | Annotate nâng cao (blur, highlight, crop, undo) | 🟡 TB | Trung bình | Konva |
| 4 | Thư viện: tag / tìm kiếm / multi-select | 🟡 TB | Trung bình | D1 + Worker |
| 5 | OCR trích xuất chữ | 🟡 TB | TB–Cao | tiền lệ jsQR |
| 6 | GIF / trim / nén video | 🟡 TB | Trung bình | ffmpeg sidecar |
| 7 | Auto-launch / tray / theme / âm báo | 🟢 Thấp | Thấp | Tauri plugins |
| 8 | Dọn dẹp tự động (cron) | 🟢 Thấp | Trung bình | Cron + D1 |

---

## Đề xuất lộ trình (roadmap)

- **Giai đoạn 1 (quick win):** #2 Clipboard nhanh + #7 Auto-launch/tray/theme — ít code, tăng trải nghiệm ngay.
- **Giai đoạn 2 (giá trị cao):** #1 Bảo mật link + #3 Annotate blur/crop — giải quyết rủi ro lộ dữ liệu, cần cho chia sẻ công khai.
- **Giai đoạn 3 (mở rộng):** #4 Tổ chức thư viện + #6 GIF/nén video.
- **Giai đoạn 4 (nâng cao):** #5 OCR + #8 Dọn dẹp tự động.

> Ghi chú migration: các thay đổi D1 (#1, #4, #8) đều là **thêm cột / bảng** — dùng `ALTER TABLE ... ADD COLUMN` trong `worker/schema.sql`, chạy `npm run db:schema`. Không phá dữ liệu cũ.
