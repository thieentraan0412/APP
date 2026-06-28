# Checklist thực hiện App

> Danh sách công việc chi tiết từ đầu đến hoàn thiện. Dựa trên [begin.md](begin.md) và [implement.md](implement.md).
> Stack: **Tauri + React + Konva** → **Cloudflare Workers** → **R2 + D1**, link công khai, ẩn danh.

Mỗi lần thực hiện một checklist --> Sau khi thực hiện xong thì tick vào ☐ đã hoàn thành , và ghi chú vào dưới hàng đó những công việc đã làm

**Tiến độ tổng:** ✅ Giai đoạn 0 → 6 xong (gồm đổi phím tắt, retry upload, cảnh báo video dài, dọn file tạm, đổi tên app; chỉ còn icon riêng). ✅ Giai đoạn 8: đã build **.msi** (sau khi tắt Smart App Control). Còn lại: Giai đoạn 7 (kiểm thử) + cài thử máy sạch + (tuỳ chọn) ký số/icon.

---

## Giai đoạn 0 — Chuẩn bị môi trường

- [x] Cài **Node.js** (bản LTS) — kiểm tra `node -v`
  > Đã có sẵn: Node.js **v25.9.0**, npm **11.12.1**.
- [x] Cài **Rust** qua rustup — kiểm tra `rustc --version`
  > Cài qua winget (Rustlang.Rustup). rustc/cargo **1.96.0**, toolchain `stable-x86_64-pc-windows-msvc`. Đã build thử 1 project Rust → thành công.
- [x] Cài điều kiện build Tauri trên Windows (WebView2, Visual Studio Build Tools)
  > WebView2 đã có sẵn (149.0.4022.80). Cài **Visual Studio Build Tools 2022** + workload VCTools (qua winget, chạy quyền Admin/UAC). Đã xác minh MSVC C++ tools hoạt động.
- [x] Cài **ffmpeg** và thêm vào PATH — kiểm tra `ffmpeg -version`
  > Cài qua winget (Gyan.FFmpeg) **v8.1.2**. Đã thêm vào User PATH (cần mở lại terminal để dùng lệnh `ffmpeg` trực tiếp).
- [x] Tạo tài khoản **Cloudflare**
  > Người dùng đã đăng ký tài khoản Cloudflare từ trước.
- [x] Cài Wrangler: `npm i -g wrangler`
  > Đã cài global, **v4.105.0**.
- [x] Đăng nhập: `wrangler login`
  > Đã đăng nhập OAuth, email **thieentraan@gmail.com**, Account ID `238081236ed2681c74bf7687ee55f0ee`. Quyền workers/d1 đầy đủ.
  > ✅ Đã kích hoạt **R2** + thêm thẻ trên dashboard Cloudflare (sẵn sàng cho Giai đoạn 1).

**Hoàn tất khi:** mọi lệnh kiểm tra ở trên chạy ra version, đăng nhập Cloudflare thành công. ✅ ĐÃ XONG

---

## Giai đoạn 1 — Backend: Worker + R2 + D1

### Tạo hạ tầng
- [x] Tạo thư mục `worker/`
- [x] Tạo bucket R2: `wrangler r2 bucket create captures`
  > Bucket **captures** đã tạo (region tự động).
- [x] Tạo D1: `wrangler d1 create captures-db` → lưu lại `database_id`
  > database_id = `1df501ed-4f9a-4cba-ae6c-c0f35bc9b66e` (region APAC).
- [x] Viết `worker/schema.sql` (bảng `items` theo implement.md mục 4)
- [x] Áp schema: `wrangler d1 execute captures-db --file=schema.sql --remote`
  > Đã tạo bảng `items` + index trên D1 remote.

### Cấu hình & code
- [x] Viết `worker/wrangler.toml` (binding BUCKET + DB, dán `database_id`)
- [x] Viết `worker/src/index.ts` với các route:
  - [x] `POST /api/upload` — nhận file + annotate → PUT R2 → INSERT D1 → trả `{ id, url }`
  - [x] `GET /file/:id` — stream file từ R2
  - [x] `GET /v/:id` — trang HTML xem ảnh/video
- [x] Thêm header **CORS** cho phép app Tauri gọi
- [x] Cài `nanoid` (hoặc tự sinh id)
  > Không dùng nanoid — tự viết hàm `makeId()` sinh id base62 bằng `crypto.getRandomValues` (không cần thư viện ngoài).
  > Thêm `package.json` + `tsconfig.json` (chỉ dùng @cloudflare/workers-types cho TypeScript).

### Deploy & test
- [x] Deploy: `wrangler deploy` → lưu URL
  > URL Worker: **https://captures-api.thieentraan.workers.dev** (đã bật workers.dev, Public).
- [x] Test upload bằng curl/Postman → nhận link
  > Upload ảnh test → trả `{ id, url }`. VD: `/v/5PuK085fWf`.
- [x] Mở link `/v/:id` trên trình duyệt → thấy file
  > Kiểm chứng: `/v/:id` → HTTP 200 HTML; `/file/:id` → HTTP 200 image/png; D1 có bản ghi. ✅ Chạy thông end-to-end.

**Hoàn tất khi:** upload 1 file qua curl, mở link trả về xem được nội dung. ✅ ĐÃ XONG

---

## Giai đoạn 2 — Khung Tauri + phím tắt + chụp ảnh

### Khởi tạo
- [x] `npm create tauri-app@latest desktop` (chọn React + TypeScript)
  > Đã tạo `desktop/` (Tauri 2 + React + TS), `npm install` xong.
- [x] Chạy thử `npm run tauri dev` → cửa sổ app mở được
  > Build dev xong (~2m16s, không lỗi), cửa sổ mở OK. Người dùng đã test: nút chụp, phím tắt Ctrl+Shift+1, tray — **chạy đúng hết**.
- [x] Thêm crate `tauri-plugin-global-shortcut` vào `Cargo.toml`
  > Đã thêm v2.3.2.
- [x] Thêm crate `xcap` (chụp màn hình)
  > Đã thêm xcap v0.9.6, kèm `image` v0.25.10 + `base64` (mã hoá PNG → data URL).

### Phím tắt + chụp ảnh
- [x] Viết `src-tauri/src/capture.rs` — chụp toàn màn hình → PNG (data URL base64)
  > Dùng `xcap` lấy màn hình chính, mã hoá PNG bằng crate `image`, trả `data:image/png;base64,...` cho frontend (không qua file tạm).
- [x] Đăng ký phím tắt `Ctrl+Shift+1` (ảnh)
  > Đăng ký trong `lib.rs` qua plugin global-shortcut. (`Ctrl+Shift+2` cho video để Giai đoạn 5.)
- [x] Khi bấm phím tắt ảnh → chụp → emit event `image-captured`
  > Gửi data URL ảnh qua event; có thêm event `capture-error` khi lỗi.
- [x] Mở cửa sổ editor khi có ảnh mới
  > Sau khi chụp, hiện + focus cửa sổ `main`; frontend chuyển sang màn hình xem ảnh.

### System tray (chạy nền)
- [x] System tray — icon khay hệ thống + menu (Chụp / Mở cửa sổ / Thoát)
  > Làm thẳng trong `lib.rs` bằng `TrayIconBuilder` (Tauri 2 có sẵn, không cần file `tray.rs` riêng).
- [x] App ẩn xuống tray thay vì tắt khi đóng cửa sổ
  > `on_window_event` chặn CloseRequested → `hide()` thay vì thoát.

**Hoàn tất khi:** bấm `Ctrl+Shift+1` → có ảnh đúng nội dung màn hình + cửa sổ editor mở lên. ✅ ĐÃ XONG (đã test thực tế OK).

---

## Giai đoạn 3 — Màn hình chỉnh sửa ảnh (React + Konva)

- [x] Cài: `npm i konva react-konva nanoid`
- [x] `src/screens/EditorScreen.tsx` — nhận ảnh, tự co vừa khung, quản lý tool/boxes/notes/selection
  > Tính tỉ lệ fit theo cửa sổ; xuất ảnh đúng độ phân giải gốc (pixelRatio = 1/scale); bỏ chọn trước khi xuất để Transformer không lọt vào ảnh.
- [x] `src/components/AnnotateCanvas.tsx`:
  - [x] Hiển thị ảnh nền trên `<Stage>`
  - [x] Công cụ **Khung**: kéo chuột vẽ hình chữ nhật (viền đỏ + nền đỏ nhạt, tự bỏ khung quá nhỏ)
  - [x] Chọn / di chuyển / đổi kích thước khung (Transformer)
  - [x] Công cụ **Note**: bấm để thêm text (prompt), bấm đúp để sửa/xoá
  - [x] Xoá phần tử đang chọn (phím Delete)
- [x] `src/components/Toolbar.tsx` — nút Chọn / Khung / Ghi chú / Xoá / Quay lại / Lưu
- [x] `src/lib/flatten.ts` — `stage.toDataURL()` → Blob PNG đã gộp annotate (+ `dataUrlToBlob`)
- [x] Nút **Lưu** trên giao diện
  > Lưu → tạo ảnh gộp + dữ liệu annotations (toạ độ quy về ảnh gốc) → màn hình xem trước (Giai đoạn 4 sẽ upload).
  > Thêm `src/types.ts` (Tool/Box/Note/Annotations).

**Hoàn tất khi:** vẽ được khung + note, di chuyển/xoá được, ảnh xuất ra đã gộp đúng annotate. ✅ ĐÃ XONG (đã test thực tế OK).

---

## Giai đoạn 4 — Kết nối upload + hiện link

- [x] `src/lib/api.ts` — hàm `uploadImage(blob, annotations)` gọi Worker (`POST /api/upload`)
  > Dùng `window.fetch` + FormData (Worker đã bật CORS *), trỏ tới https://captures-api.thieentraan.workers.dev.
- [x] Nút **Lưu** → flatten → upload → nhận `{ id, url }`
- [x] Màn hình kết quả — hiện link + nút Copy + Mở link
  > Làm trong `App.tsx` (màn hình `result`): ô link, nút Copy, nút "Mở link" (plugin opener `openUrl`).
- [x] Tự copy link vào clipboard (plugin `tauri-plugin-clipboard-manager`)
  > Đăng ký plugin trong `lib.rs`; thêm quyền `clipboard-manager:allow-write-text` + `opener:allow-open-url`. Link tự copy sau khi upload (hiện "Đã copy ✓").
- [x] Hiện trạng thái "Đang tải lên..." khi upload
- [x] Báo lỗi khi upload thất bại

**Hoàn tất khi:** chạy trọn vẹn: phím tắt → annotate → Lưu → nhận link → mở link xem đúng ảnh đã annotate. ✅ ĐÃ XONG (đã test thực tế OK).

---

## Giai đoạn 5 — Quay video

- [x] Đóng gói **ffmpeg** làm sidecar trong `tauri.conf.json`
  > Copy ffmpeg.exe → `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` (231MB), khai báo `bundle.externalBin = ["binaries/ffmpeg"]`. Thêm plugin `tauri-plugin-shell` (chạy sidecar) + `tauri-plugin-fs` (đọc file để upload).
- [x] Viết `src-tauri/src/record.rs`:
  - [x] Phím tắt lần 1 → bắt đầu quay (`-f gdigrab -framerate 30 -i desktop -c:v libx264 -preset ultrafast`)
  - [x] Phím tắt lần 2 → dừng quay sạch → ra `capture_rec.mp4`
    > Gửi `q` vào stdin ffmpeg để đóng file mp4 hợp lệ (không cắt cụt); theo dõi sự kiện Terminated rồi báo frontend.
  - [x] Hiện chỉ báo đang quay
    > Banner đỏ "● Đang quay…" trên giao diện + mục tray "Quay / Dừng video". (Phím tắt Ctrl+Shift+2.)
- [x] Upload video thẳng (bỏ qua editor)
  > Frontend đọc file mp4 (`@tauri-apps/plugin-fs`) → Blob → `uploadVideo()` (type=video) → Worker.
- [x] Nhận link → hiện màn hình kết quả
  > Tái dùng màn hình result: xem trước bằng `<video>`, link tự copy, nút Copy / Mở link.

**Hoàn tất khi:** quay vài giây → dừng → link phát được video. ✅ ĐÃ XONG (đã test thực tế OK).

---

## Giai đoạn 6 — Hoàn thiện trải nghiệm

### Trang quản lý dữ liệu / link (làm đầu tiên)
> Cho phép xem lại, sửa, xoá các nội dung đã lưu. Cần bổ sung API ở Worker + màn hình mới trong app.

**Backend (Worker — thêm route):**
- [x] `GET /api/items` — liệt kê danh sách (id, type, link, created_at)
  > Trả tối đa 200 mục, mới nhất trước. (Phân trang để sau nếu cần.)
- [x] `GET /api/items/:id` — chi tiết 1 mục (kèm annotations + originalUrl)
- [x] `DELETE /api/items/:id` — xoá file R2 (cả ảnh gốc) + bản ghi D1
- [x] `PATCH /api/items/:id` — sửa: thay ảnh đã gộp + cập nhật annotations
- [ ] (Cân nhắc) thêm cột `title`/`note` để đặt tên — *chưa làm (tuỳ chọn)*
- [x] (Bảo mật) khoá các route quản lý bằng **API key** (header `x-api-key`)
  > Secret `API_KEY` trên Worker; route quản lý 401 nếu sai key. Thêm cột `r2_key_orig` lưu ảnh gốc để sửa.

**Frontend (app — màn hình mới):**
- [x] `src/screens/LibraryScreen.tsx` — lưới thumbnail, loại, ngày tạo
- [x] Mỗi mục có: **Copy link**, **Mở link**, **Xoá**, **Sửa** (Sửa chỉ cho ảnh)
- [x] **Xoá**: hỏi xác nhận → `DELETE` → cập nhật lại danh sách
- [x] **Sửa**: tải ảnh gốc + annotations cũ vào editor → lưu đè (`PATCH`)
- [ ] Tìm kiếm / lọc theo loại, sắp xếp — *chưa làm (tuỳ chọn)*
- [x] Lối vào màn hình này — nút "Thư viện nội dung" ở trang chính

**Hoàn tất khi:** mở được danh sách, copy/mở link, xoá và sửa annotate. ✅ ĐÃ XONG (test thực tế OK).

### Hoàn thiện khác
- [x] Thông báo (toast) khi copy / xoá / cập nhật
- [x] Màn hình **Cài đặt**: cho đổi phím tắt
  > `SettingsScreen` — bấm ô rồi nhấn tổ hợp phím mới (dùng e.code, cần ≥1 modifier). Lưu vào localStorage + lệnh Rust `set_shortcuts` (unregister_all rồi register lại). Handler so khớp theo state động.
- [x] Retry tự động khi upload lỗi mạng
  > `fetchRetry` trong api.ts: thử lại 3 lần (cách 1.2s) khi lỗi mạng, không thử lại khi server trả mã lỗi.
- [x] Giới hạn / cảnh báo khi video quá dài
  > Banner đếm thời gian quay; quá 2 phút chuyển vàng + cảnh báo "video đã khá dài".
- [x] Dọn file tạm sau khi upload xong
  > Lệnh Rust `remove_temp(path)` xoá file mp4 tạm sau khi upload video xong.
- [~] Icon app + tên app chỉnh chu
  > Đổi tên: productName "CaptureShare", tiêu đề cửa sổ "Chụp & Chia sẻ". Icon vẫn là mặc định Tauri (đổi icon cần file ảnh nguồn — chờ logo từ người dùng).

**Hoàn tất khi:** dùng thử thực tế thấy mượt. ✅ Cơ bản xong (chỉ còn icon riêng — tuỳ chọn).

### Sửa lỗi đã gặp
- [x] Ghi chú: thay `prompt` bằng ô nhập **inline ngay tại vị trí note**; fix mất focus (focus qua ref + chặn blur giả 300ms).
- [x] Sửa tiêu đề **inline** ngay trên thẻ thư viện (Enter lưu, Esc huỷ, click ra ngoài lưu).

---

## Giai đoạn 7 — Kiểm thử toàn diện

- [ ] Worker: upload qua curl → link mở được
- [ ] Phím tắt chụp ảnh ra đúng nội dung
- [ ] Editor: vẽ / di chuyển / xoá khung + note hoạt động
- [ ] Ảnh xuất ra gộp đúng annotate
- [ ] Upload ảnh annotate → link đúng
- [ ] Quay video → dừng → link phát được
- [ ] Link tự copy vào clipboard
- [ ] Thử trên **máy sạch** (chưa cài gì) sau khi build

---

## Giai đoạn 8 — Đóng gói & phát hành

- [x] `npm run tauri build` → ra file cài **.msi**
  > ⚠️ Bị chặn bởi **Smart App Control** (Windows 11, lỗi 4551 chặn build-script chưa ký). SAC tự chuyển từ Evaluation → Enforced sau vài ngày. Đã **TẮT SAC** (vĩnh viễn) để build được.
  > Build vào `CARGO_TARGET_DIR=C:\captureshare-build` (tránh OneDrive đồng bộ artifacts). Ra `CaptureShare_0.1.0_x64_en-US.msi` (91.5MB), đã copy ra Desktop.
- [ ] Cài thử trên máy khác → chạy được — *chưa làm*
- [x] Viết README hướng dẫn cài + dùng
- [ ] (Tuỳ chọn) Ký số (code signing) để tránh cảnh báo SmartScreen — *chưa làm*
- [ ] (Tuỳ chọn) Trang tải về / cập nhật — *chưa làm*

**Hoàn tất khi:** có file cài đặt, người khác cài và dùng được trọn vẹn. ✅ Đã có .msi (cài thử trên máy sạch để xác nhận hoàn toàn).

---

## Theo dõi rủi ro (kiểm chứng sớm)

- [ ] ⚠️ **Quay video ffmpeg + gdigrab** chạy ổn (codec, FPS, dừng sạch) — phần khó nhất, thử sớm
- [ ] ⚠️ **CORS** giữa app Tauri và Worker đã thông
- [ ] ⚠️ Version **Tauri 2** và các plugin khớp tài liệu chính thức
- [ ] ⚠️ Kích thước / thời gian upload **video** chấp nhận được

---

## Sau MVP (nâng cấp về sau)

- [ ] Đăng nhập + "thư viện của tôi"
- [ ] Link riêng tư / link hết hạn (presigned URL)
- [ ] Annotate cho video
- [ ] Nén ảnh/video trước khi upload
- [ ] Lịch sử + tìm kiếm + xoá nội dung
