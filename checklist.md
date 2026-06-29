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

---

## Ý tưởng tính năng mới (Roadmap v2)

> Các tính năng được nhóm theo mức độ ưu tiên và độ phức tạp. Đánh dấu ☐ khi bắt đầu làm, tick ✅ khi xong.

---

### Nhóm A — Công cụ chỉnh sửa nâng cao (Editor)

- [x] **Thêm công cụ vẽ: mũi tên (Arrow)**
  > Vẽ mũi tên chỉ vào vùng cần chú ý. Dùng Konva Line + Arrow. Hỗ trợ chọn/di chuyển/xoá như khung hiện tại.
  > *Tại sao:* mũi tên là công cụ annotate phổ biến nhất trong screenshot tool (Skitch, Greenshot, ShareX đều có).
  > ✅ Đã làm: thêm `Arrow` interface vào types.ts, tool `"arrow"` vào Toolbar, render `<KArrow>` trong AnnotateCanvas (kéo vẽ, chọn/di chuyển/xoá bằng Delete), save/load annotations đầy đủ.

- [ ] **Blur / che thông tin nhạy cảm (Mosaic tool)**
  > Vẽ vùng chữ nhật → pixel trong vùng đó bị làm mờ (Gaussian blur hoặc pixelate) trước khi lưu.
  > *Tại sao:* cần che email, số điện thoại, mật khẩu khi share ảnh chụp màn hình. Implement: vẽ Rect màu mờ trên canvas, khi flatten dùng `ctx.filter = blur`.

- [x] **Công cụ đánh số thứ tự (Step marker)**
  > Click để đặt vòng tròn có số (1, 2, 3…) — dùng để hướng dẫn từng bước thao tác.
  > *Tại sao:* rất hữu ích khi viết hướng dẫn. Implement: thêm kiểu shape `step` vào types.ts, vẽ Circle + Text trong Konva.
  > ✅ Đã làm: `StepMarker` interface, tool `"step"` vào Toolbar (nút ① Bước), render `<Group><Circle><Text>` trong Konva — click đặt số tự tăng, kéo di chuyển, Delete xoá, save/load scale đầy đủ.

- [ ] **Undo / Redo trong editor (Ctrl+Z / Ctrl+Y)**
  > Lưu lịch sử thao tác (mảng snapshot), Ctrl+Z pop về trạng thái trước.
  > *Tại sao:* hiện tại lỡ xoá nhầm phải làm lại từ đầu — ảnh hưởng trải nghiệm nhiều nhất.

- [ ] **Chọn màu tự do cho khung và note**
  > Thêm color picker (input type=color hoặc thư viện nhỏ) vào Toolbar, áp dụng cho shape/note đang vẽ.
  > *Tại sao:* hiện tại màu cố định đỏ. Người dùng muốn dùng màu khác nhau để phân loại vùng chú ý.

- [ ] **Chụp vùng chọn (Region capture) thay vì toàn màn hình**
  > Sau khi bấm Ctrl+Shift+1, hiện overlay mờ toàn màn hình cho kéo chọn vùng muốn chụp.
  > *Tại sao:* chụp toàn màn hình thường chứa quá nhiều thứ thừa. Implement ở Rust: tạo cửa sổ transparent fullscreen để user kéo chọn rồi crop ảnh.

---

### Nhóm B — Chụp & Quay nâng cao (Capture)

- [ ] **Chụp cửa sổ ứng dụng cụ thể (Window capture)**
  > Liệt kê danh sách cửa sổ đang mở, cho chọn 1 cửa sổ để chụp riêng nó.
  > *Tại sao:* crate `xcap` đã hỗ trợ `Window::all()` — chỉ cần thêm command Rust và màn hình chọn cửa sổ ở frontend.

- [ ] **Chụp có đếm ngược (Countdown timer)**
  > Bấm chụp → đếm ngược 3 giây rồi mới chụp — để kịp chuẩn bị màn hình.
  > *Tại sao:* cần thiết khi chụp tooltip, dropdown hoặc trạng thái hover. Implement: `thread::sleep` trong Rust hoặc đếm ở frontend rồi gọi lệnh chụp.

- [ ] **Quay video chọn màn hình / cửa sổ cụ thể (Multi-monitor)**
  > Khi có nhiều màn hình, cho chọn màn hình nào sẽ được quay thay vì mặc định màn hình 1.
  > *Tại sao:* người dùng nhiều màn hình rất cần tính năng này. ffmpeg hỗ trợ qua `-offset_x/-offset_y -video_size`.

- [ ] **Xuất GIF từ video quay ngắn**
  > Sau khi quay video ngắn (< 30s), thêm nút "Xuất GIF" — dùng ffmpeg chuyển mp4 → gif rồi upload.
  > *Tại sao:* GIF dễ nhúng vào Slack, GitHub, Notion hơn video mp4. ffmpeg: `ffmpeg -i in.mp4 -vf "fps=10,scale=800:-1" out.gif`.

- [ ] **Tự động chụp theo lịch (Scheduled capture)**
  > Cài đặt chụp màn hình tự động mỗi X phút (5/10/30 phút), lưu thẳng lên cloud.
  > *Tại sao:* hữu ích để theo dõi tiến độ làm việc theo thời gian (time-lapse công việc).

---

### Nhóm C — Chia sẻ & Bảo mật (Share)

- [ ] **Link có mật khẩu (Password-protected link)**
  > Khi lưu, cho đặt mật khẩu tuỳ chọn. Trang `/v/:id` yêu cầu nhập mật khẩu trước khi xem.
  > *Tại sao:* chia sẻ nội dung nội bộ, không muốn ai có link cũng xem được.
  > *Backend:* lưu hash mật khẩu vào D1, Worker kiểm tra qua POST form trước khi stream file.

- [ ] **Link có thời hạn (Expiring link)**
  > Khi upload, chọn thời hạn: 1h / 24h / 7 ngày / vĩnh viễn. Worker kiểm tra `expires_at` trước khi trả file.
  > *Tại sao:* tránh nội dung tồn tại mãi trên cloud, phù hợp share tạm thời.
  > *Backend:* thêm cột `expires_at INTEGER` vào bảng `items`, thêm Cron Trigger dọn bản ghi hết hạn.

- [ ] **Chia sẻ nhanh lên clipboard không upload (Local copy)**
  > Thêm nút/phím tắt "Chỉ copy ảnh" — flatten ảnh + annotate rồi copy thẳng vào clipboard dưới dạng image, không upload lên cloud.
  > *Tại sao:* đôi khi chỉ cần paste vào Slack/Discord/email mà không cần link.
  > *Implement:* Tauri clipboard API hỗ trợ write image.

- [ ] **Chia sẻ nhanh lên Slack / Discord webhook**
  > Trong Cài đặt, nhập Webhook URL của Slack/Discord. Sau khi upload, nút "Gửi lên Slack" post link vào channel.
  > *Tại sao:* workflow phổ biến nhất: chụp bug → share ngay vào channel team mà không cần mở Slack.

- [ ] **QR code cho link chia sẻ**
  > Hiện QR code của link ngay trên màn hình kết quả — dùng thư viện `qrcode` nhỏ ở frontend.
  > *Tại sao:* dễ share sang điện thoại hoặc trình chiếu (presentation).

---

### Nhóm D — Thư viện & Tổ chức (Library)

- [ ] **Tìm kiếm và lọc trong thư viện**
  > Ô tìm kiếm lọc theo tiêu đề; filter theo loại (ảnh/video); sắp xếp theo ngày mới/cũ.
  > *Tại sao:* khi thư viện nhiều mục, không có tìm kiếm rất khó dùng.
  > *Backend:* thêm `LIKE` query trong `GET /api/items`, hoặc filter ở frontend với dữ liệu đã load.

- [ ] **Tags / nhãn cho mỗi capture**
  > Gắn tag (bug, design, tutorial…) khi lưu. Lọc thư viện theo tag.
  > *Tại sao:* phân loại nội dung khi dùng lâu dài. Lưu tags vào cột JSON trong D1.

- [ ] **Chọn nhiều mục — xoá/copy link hàng loạt (Batch actions)**
  > Checkbox trên mỗi thẻ thư viện, thanh action nổi lên khi chọn ≥ 1 mục: "Xoá tất cả", "Copy tất cả link".
  > *Tại sao:* xoá từng mục một rất chậm khi dọn thư viện.

- [ ] **Pinned / Ghim mục quan trọng**
  > Ghim capture lên đầu thư viện, không bị đẩy xuống khi có mục mới.
  > *Backend:* thêm cột `pinned BOOLEAN DEFAULT 0`, sort `pinned DESC, created_at DESC`.

- [ ] **Xem trước ảnh toàn màn hình (Lightbox)**
  > Click vào thumbnail trong thư viện → mở ảnh to toàn cửa sổ với nút Prev/Next.
  > *Tại sao:* thumbnail nhỏ khó xem chi tiết, phải mở link trên trình duyệt.

---

### Nhóm E — Trải nghiệm & Hiệu năng (UX/Performance)

- [ ] **Dark mode / Light mode**
  > Thêm toggle theme trong Cài đặt; lưu preference vào localStorage.
  > *Tại sao:* app hiện chỉ có light mode — người dùng ban đêm hoặc thích dark mode không có lựa chọn.

- [ ] **Nén ảnh trước khi upload (Image compression)**
  > Trước khi upload, resize ảnh về tối đa 2560px và nén quality 85% bằng Canvas API.
  > *Tại sao:* ảnh 4K chụp toàn màn hình có thể > 5MB — nén xuống ~500KB giúp upload nhanh hơn 10x.

- [ ] **Thông báo hệ thống (System notification)**
  > Sau khi upload xong, hiện Windows notification nhỏ "✓ Đã copy link" dù cửa sổ app đang ẩn.
  > *Implement:* `tauri-plugin-notification`.

- [ ] **Lưu ảnh ra file local (Save to disk)**
  > Thêm nút "Lưu về máy" trong editor và thư viện — lưu file PNG/MP4 ra thư mục tự chọn.
  > *Tại sao:* đôi khi chỉ cần lưu file, không cần upload.

- [ ] **Lịch sử clipboard (Clipboard history)**
  > Giữ lại 10 link gần nhất đã copy — xem lại và copy lại từ tray menu mà không cần mở thư viện.
  > *Tại sao:* lỡ mất link vừa copy do copy thứ khác vào clipboard rất hay gặp.

- [ ] **Icon app riêng + splash screen**
  > Thiết kế icon .ico cho app (hiện đang dùng icon mặc định Tauri). Thêm splash screen loading ngắn.
  > *Tại sao:* app đang dùng icon placeholder — ảnh hưởng tính chuyên nghiệp khi chạy ở tray.

---

### Nhóm F — Đăng nhập & Đa thiết bị (Auth / Sync)

- [ ] **Đăng nhập bằng Google / GitHub (OAuth)**
  > Người dùng đăng nhập → capture gắn với tài khoản → xem thư viện của mình từ bất kỳ thiết bị nào.
  > *Implement:* Cloudflare Access hoặc tự build OAuth flow trong Worker + lưu `user_id` vào D1.

- [ ] **Thư viện riêng theo tài khoản**
  > `GET /api/items` chỉ trả về items của `user_id` đang đăng nhập, không lộ data người khác.
  > *Phụ thuộc:* Nhóm F — Đăng nhập.

- [ ] **Giới hạn dung lượng theo tài khoản (Storage quota)**
  > Mỗi tài khoản có quota (ví dụ 1GB free). Hiện thanh dung lượng trong Cài đặt.
  > *Backend:* SUM size từ D1, so sánh với quota khi upload.

---

### Nhóm G — Tích hợp & API (Integration)

- [ ] **Browser extension (Chrome/Firefox)**
  > Extension cho phép chụp tab đang xem, crop vùng chọn ngay trên trình duyệt rồi upload lên cùng backend.
  > *Tại sao:* mở rộng usecase sang web — không cần cài app desktop.

- [ ] **API public cho developer**
  > Tài liệu API công khai + API key cá nhân để tích hợp từ tool khác (CI/CD paste screenshot, script tự động).
  > *Backend:* thêm bảng `api_keys`, middleware xác thực, trang tạo key trong Settings.

- [ ] **Zapier / Make (Automation) webhook**
  > Sau mỗi lần upload, Worker gọi webhook URL đã cấu hình — tích hợp với Zapier, Make, n8n để tự động hoá luồng.
  > *Ví dụ:* upload ảnh → tự tạo Jira ticket, gửi email, lưu vào Notion.
