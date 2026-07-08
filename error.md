# Báo cáo kiểm thử toàn diện — Chụp & Chia sẻ

**Ngày:** 2026-07-07
**Phạm vi:** Test trực tiếp backend + capture/record + build, và audit code 4 mảng chức năng (capture/QR, video, editor, library/API/worker).

---

## 1. Kết quả test trực tiếp — ĐỀU PASS ✅

| Hạng mục | Kết quả |
|---|---|
| **API backend** (22 test) | ✅ 22/22 — auth 401, upload ảnh+video, list, detail+annotations, serve `/file` `/orig` `/v`, video Range seeking (206), PATCH title, 404, delete + xác nhận đã xóa |
| **Chụp màn hình** (Ctrl+Shift+1) | ✅ Không crash, luồng capture chạy |
| **Quay video** (Alt+D start/stop) | ✅ ffmpeg chạy→dừng sạch, tạo file unique (1.27 MB) |
| **Production build** (`tsc && vite build`) | ✅ Exit 0, 134 modules |
| **Type-check** | ✅ Sạch |

> Backend, build và luồng chụp/quay lõi đều khỏe. Các lỗi bên dưới là **lỗi logic phát hiện qua đọc code** (edge case, race, đa màn hình…), không làm sập app trong luồng cơ bản.

---

## 2. Lỗi theo mức độ

Ký hiệu: ✓ = tôi đã xác minh trực tiếp trên code · ⚠ = liên quan đến thay đổi trong phiên sửa lỗi hôm nay.

### 🔴 HIGH (8)

#### H1 ✓ — `qrModeRef` kẹt `true` khi chụp QR lỗi → lần chụp kế bị "nuốt" thành dò QR
- **File:** [capture.rs:94-99](desktop/src-tauri/src/capture.rs#L94-L99) + [App.tsx:270](desktop/src/App.tsx#L270)
- Khi bấm "Quét mã QR", nếu `begin_region_capture` chụp lỗi → emit `capture-error`. Listener `capture-error` chỉ `setError`, **không reset `qrModeRef`**. Lần sau bấm phím tắt Chụp (Ctrl+Shift+1) → ảnh full màn hình bị đưa vào `decodeQr` thay vì mở editor → ảnh mất, hiện "Không phát hiện mã QR".
- **Fix:** reset `qrModeRef.current = false` trong listener `capture-error` (và phòng thủ trước khi vào nhánh editor).

#### H2 — Chụp full màn hình trong lúc đang chọn vùng QR → tráo kết quả
- **File:** [lib.rs:28-42](desktop/src-tauri/src/lib.rs#L28-L42) + [App.tsx:254-268](desktop/src/App.tsx#L254-L268)
- Khi overlay chọn vùng QR đang mở, phím tắt Chụp vẫn chạy → emit `image-captured` (full screen) bị `decodeQr` tiêu thụ + reset `qrModeRef=false`. Sau đó người dùng kéo xong vùng → ảnh vùng lại mở trong editor thay vì dò QR. Hai hành động đổi chỗ kết quả.
- **Fix:** chặn/hoãn `trigger_capture` khi đang chụp vùng, hoặc cho QR dùng event riêng thay vì chung `image-captured`.

#### H3 — Chụp vùng & quét QR chỉ dùng MÀN HÌNH CHÍNH (đa màn hình sai)
- **File:** [capture.rs:27-39](desktop/src-tauri/src/capture.rs#L27-L39) (`capture_primary_raw` luôn lấy `is_primary()`), [tauri.conf.json:34-45](desktop/src-tauri/tauri.conf.json#L34-L45) (overlay `region_selector` không đặt lại vị trí), [RegionSelector.tsx](desktop/src/screens/RegionSelector.tsx)
- Overlay chọn vùng full-screen nhưng không được dời sang màn hình đang thao tác; luôn crop từ buffer màn hình chính. Trên máy 2 màn hình → crop sai/rác. Nếu toạ độ vượt kích thước màn chính → `cw==0/ch==0` → `Err("Vùng chọn quá nhỏ")`, mà `onMouseUp` không `.catch` → overlay đóng im lặng, không báo lỗi.
- **Fix:** chụp đúng màn hình chứa overlay (hoặc chụp toàn virtual desktop + offset theo gốc màn hình); đặt vị trí/kích thước overlay theo màn hình đích trước khi hiện; thêm xử lý lỗi cho `onMouseUp`.

#### H4 ✓ — ffmpeg tải THIẾU vẫn được cache vĩnh viễn → quay video hỏng mãi
- **File:** [ffmpeg.rs:16](desktop/src-tauri/src/ffmpeg.rs#L16), [ffmpeg.rs:63-68](desktop/src-tauri/src/ffmpeg.rs#L63-L68)
- Chỉ kiểm tra `MIN_SIZE = 5MB`, nhưng ffmpeg.exe thật ~80MB+. Nếu mạng đứt giữa chừng (đã ghi >5MB) → file cụt vẫn qua kiểm tra → rename thành `ffmpeg.exe`. Mọi lần sau đều tái dùng file hỏng → quay báo "Không quay được" mãi, không tự tải lại.
- **Fix:** so `downloaded` với `content_length()` (khớp chính xác khi server báo dung lượng), và/hoặc chạy `ffmpeg -version` xác thực trước khi cache.

#### H5 ✓ — Bấm Quay 2 lần nhanh (khi đang tải ffmpeg) → sinh 2 tiến trình ffmpeg, mồ côi tiến trình cũ
- **File:** [record.rs:77-84](desktop/src-tauri/src/record.rs#L77-L84), [record.rs:103-137](desktop/src-tauri/src/record.rs#L103-L137), [record.rs:168-200](desktop/src-tauri/src/record.rs#L168-L200)
- Cờ `recording`/`paused` chỉ được đặt **sau** `spawn_segment` (có thể chờ tải ffmpeg vài giây + retry 8×700ms). Trong cửa sổ đó, toggle lần 2 đọc cờ cũ → chạy `start()` thứ hai. Cả hai ghi cùng `ffmpeg.exe.part` (làm hỏng — nối vào H4) và cùng `seg0.mp4`; `start` thứ hai đè `child`/`stdin` → ffmpeg đầu bị mồ côi, tiếp tục quay/giữ file tới khi thoát app. Lỗi tương tự ở `resume()`.
- **Fix:** đặt cờ "đang khởi động"/`recording=true` **trong lock trước khi spawn**, rollback nếu spawn lỗi.

#### H6 ✓ — Resize/phóng to cửa sổ khi đang sửa → annotation lệch + LƯU SAI toạ độ gốc
- **File:** [EditorScreen.tsx:184-190](desktop/src/screens/EditorScreen.tsx#L184-L190), [EditorScreen.tsx:193-210](desktop/src/screens/EditorScreen.tsx#L193-L210), [EditorScreen.tsx:353-361](desktop/src/screens/EditorScreen.tsx#L353-L361)
- Annotation lưu theo toạ độ hiển thị tính từ `fit.scale` lúc mở; khi resize `fit.scale` đổi, ảnh nền vẽ lại kích thước mới nhưng **shape không được rescale** → lệch. Khi Lưu, `b.x / s` dùng scale **mới** trên toạ độ **cũ** → toạ độ gốc lưu sai + ảnh xuất cũng lệch.
- **Fix:** khi `fit.scale` đổi, nhân toạ độ mọi shape theo `newScale/oldScale`; hoặc lưu annotation theo toạ độ ảnh gốc, chỉ scale khi vẽ/xuất.

#### H7 ⚠ — Ctrl+S khi đang mở ô sửa Ghi chú → mất chữ note + note biến mất khỏi ảnh xuất
- **File:** [EditorScreen.tsx:115-119](desktop/src/screens/EditorScreen.tsx#L115-L119) + [EditorScreen.tsx:342-369](desktop/src/screens/EditorScreen.tsx#L342-L369) + [AnnotateCanvas.tsx:328-329](desktop/src/components/AnnotateCanvas.tsx#L328-L329)
- **Liên quan fix Ctrl+S hôm nay:** giờ Ctrl+S chạy cả khi focus trong `<textarea>` note. Nhưng `handleSave` không commit note đang gõ → note giữ `text:""`, bị ẩn khi flatten → ảnh xuất KHÔNG có note, chữ vừa gõ mất.
- **Fix:** trong `handleSave` (và luồng copy) commit note đang mở trước khi flatten — gọi `finishNote(true)`/blur `document.activeElement` rồi chờ 1 frame; hoặc chặn flatten khi `editing` đang set.

#### H8 ✓ — Đặt trùng phím tắt → TẤT CẢ phím tắt toàn cục ngừng hoạt động
- **File:** [SettingsScreen.tsx:76-99](desktop/src/screens/SettingsScreen.tsx#L76-L99) (không kiểm tra trùng), [App.tsx:735-749](desktop/src/App.tsx#L735-L749), [lib.rs:54-67](desktop/src-tauri/src/lib.rs#L54-L67)
- UI cho phép gán 2 chức năng cùng 1 tổ hợp. Rust `apply_shortcuts` gọi `unregister_all()` rồi `register(cap)?; register(rec)?; ...`. Đăng ký trùng lần 2 lỗi → `?` return sớm → `ShortcutCfg` (đặt sau `?`) không cập nhật, phím cũ đã bị gỡ → **mọi phím tắt chết** tới khi khởi động lại app. Chỉ có toast chung "Lưu phím tắt lỗi".
- **Fix:** trong `onSaveShortcuts`/SettingsScreen từ chối lưu khi 4 tổ hợp không phân biệt, chỉ rõ field nào trùng.

### 🟠 MEDIUM (9)

#### M1 — Hai đường chụp hành xử khác nhau với chế độ QR (gốc của H1/H2)
- **File:** [App.tsx:428-440](desktop/src/App.tsx#L428-L440) (nút "Chụp ảnh" gọi `capture_screen`, không qua `image-captured`) vs [lib.rs:28-42](desktop/src-tauri/src/lib.rs#L28-L42) (phím tắt/tray emit `image-captured`). Nút sidebar miễn nhiễm `qrModeRef`, phím tắt thì không → lỗi khó tái hiện. Nên hợp nhất về một cơ chế.

#### M2 — Quét QR liên tiếp nhanh → hiện kết quả cũ (stale)
- **File:** [App.tsx:446-470](desktop/src/App.tsx#L446-L470), [EditorScreen.tsx:80-86](desktop/src/screens/EditorScreen.tsx#L80-L86)
- `decodeQr` load `Image` bất đồng bộ; `onload` xong sau cùng thắng, không phải lần quét cuối. **Fix:** gắn id/generation cho mỗi lần quét, bỏ qua `onload` không phải mới nhất.

#### M3 — `resume()` thất bại không reset session → Rust và frontend lệch pha, rò segment
- **File:** [record.rs:195-197](desktop/src-tauri/src/record.rs#L195-L197) vs [App.tsx:276-283](desktop/src/App.tsx#L276-L283)
- Resume lỗi → emit `video-error`; frontend đặt `recording=false` + nhảy màn kết quả, nhưng Rust vẫn `recording=true/paused=true/segments=[seg0]`. Lần bấm Quay kế → `stop()` finalize clip cũ (bất ngờ). `seg0.mp4` bị rò. **Fix:** nhánh `Err` của resume reset session (cờ + xóa child/stdin + xóa segment) trước khi emit lỗi.

#### M4 — `pause()` chạy đè `stop()` → mất TOÀN BỘ clip
- **File:** [record.rs:139-166](desktop/src-tauri/src/record.rs#L139-L166) vs [record.rs:202-243](desktop/src-tauri/src/record.rs#L202-L243)
- `pause` đặt `paused=true` + lấy child **trước khi** push segment (push sau `child.wait()`, ngoài lock). Nếu `stop` chen vào: thấy `child=None, paused=true, segments=[]` → bỏ qua đóng đoạn hiện tại → `finalize(&[])` → `Err("Không có dữ liệu quay")`. **Fix:** `pause` push segment ngay trong lock cùng lúc đặt `paused=true`.

#### M5 — Tên segment cố định dùng chung mọi lần quay → hỏng nối nếu quay lại khi finalize chưa xong
- **File:** [record.rs:33-35](desktop/src-tauri/src/record.rs#L33-L35), [record.rs:284-327](desktop/src-tauri/src/record.rs#L284-L327)
- Sau khi Dừng, `finalize` (concat) đọc `seg0/seg1` có thể mất vài giây. Người dùng bấm Quay ngay → ffmpeg mới ghi `seg0.mp4` với `-y`, cắt ngang file concat đang đọc → video trước hỏng. (Tên file **cuối** đã được sửa unique hôm nay; nhưng tên **segment** trung gian vẫn cố định.) **Fix:** đặt tên segment theo session (kèm timestamp như file cuối).

#### M6 — Nút "Xoá" ở màn kết quả bật hộp xác nhận HAI lần, huỷ lần 2 thì kẹt màn hình
- **File:** [App.tsx:1087-1094](desktop/src/App.tsx#L1087-L1094) bọc `onDeleteItem`, mà [App.tsx:660-678](desktop/src/App.tsx#L660-L678) tự mở confirm thứ hai. `onDeleteItem` không resolve khi huỷ → `await` treo → `backHome()` không chạy. **Fix:** ở màn kết quả gọi thẳng logic xóa, không bọc lại; và resolve promise khi huỷ.

#### M7 — Kiểm tra cập nhật thủ công báo nhầm "đang dùng bản mới nhất" khi lỗi mạng
- **File:** [updater.ts:8-15](desktop/src/lib/updater.ts#L8-L15) (nuốt mọi lỗi → `null`) + [App.tsx:394-407](desktop/src/App.tsx#L394-L407) (coi `null` là "mới nhất"). Offline/endpoint lỗi → vẫn báo "Bạn đang dùng bản mới nhất". **Fix:** phân biệt "không có bản mới" và "kiểm tra lỗi".

#### M8 — Ảnh WebP bị lưu & phục vụ nhãn `image/png`
- **File:** [worker/index.ts:137-141](worker/src/index.ts#L137-L141), [worker/index.ts:264](worker/src/index.ts#L264); ảnh thực tế là WebP ([flatten.ts:17](desktop/src/lib/flatten.ts#L17)). `<img>` hiển thị được (browser tự nhận diện) nhưng "Save as .png" ra file không mở được đúng, một số bộ unfurl chat/social hỏng. **Fix:** đặt `ext="webp"`/`mime="image/webp"` cho ảnh, và hard-code `image/webp` ở `/orig`.

#### M9 ⚠ — Gộp `listItems` (coalescing) có thể làm item vừa xoá "hiện lại"
- **File:** [api.ts:113-127](desktop/src/lib/api.ts#L113-L127) + [App.tsx:608-619](desktop/src/App.tsx#L608-L619) + [App.tsx:668](desktop/src/App.tsx#L668)
- **Liên quan fix coalescing hôm nay:** bấm "Làm mới" (request B đang bay) → xóa item X (xóa lạc quan tại chỗ) → B trả về snapshot TRƯỚC khi xóa → `setLibItems(B)` thêm lại X (ghost, 404 thumbnail). Refresh cũng không ép tải mới được vì bị gộp. **Fix:** mutation reset `itemsInFlight`; hoặc `openLibrary`/Refresh bỏ qua coalescing (ép fetch mới).

### 🟡 LOW (14)

- **L1** — Buffer RGBA full-screen giữ trong `RegionState` sau khi dùng (không clear) → ~33MB@4K nằm lì giữa các lần chụp. [capture.rs:127-130](desktop/src-tauri/src/capture.rs#L127-L130).
- **L2** — Listener đăng ký bất đồng bộ; event bắn trước khi `listen()` xong sẽ mất (race khởi động). [App.tsx:253-288](desktop/src/App.tsx#L253-L288).
- **L3** — `video-error` luôn `setScreen("result")`, có thể phá màn hình editor đang mở dở (mất annotate chưa lưu). [App.tsx:276-283](desktop/src/App.tsx#L276-L283).
- **L4** — Dán step marker nhân đôi SỐ thay vì cấp số kế tiếp. [EditorScreen.tsx:167-168](desktop/src/screens/EditorScreen.tsx#L167-L168).
- **L5** — CapsLock bật → copy/paste shape hỏng (match `e.key === "c"/"v"` chữ thường). [EditorScreen.tsx:140,145,156](desktop/src/screens/EditorScreen.tsx#L140).
- **L6** — `handleSave` không có try/finally → nếu flatten lỗi (ảnh quá lớn vượt max canvas) sẽ kẹt "Đang lưu…". [EditorScreen.tsx:344-367](desktop/src/screens/EditorScreen.tsx#L344-L367).
- **L7** — Dán lặp lại chồng shape đúng một chỗ (`clipboard.current` không tiến offset). [EditorScreen.tsx:159-173](desktop/src/screens/EditorScreen.tsx#L159-L173).
- **L8** — Lịch sử Undo không giới hạn → phiên sửa dài tích luỹ snapshot (deep clone) tốn RAM. [EditorScreen.tsx:234-241](desktop/src/screens/EditorScreen.tsx#L234-L241).
- **L9** — Kích thước nét/chữ/vòng step cố định theo pixel hiển thị → cùng annotation xuất ra dày/mỏng khác nhau tuỳ kích thước cửa sổ lúc sửa. [AnnotateCanvas.tsx:215,304,335](desktop/src/components/AnnotateCanvas.tsx#L215).
- **L10** — `/api/items` `LIMIT 200` không phân trang → khi >200 mục, mục cũ nhất biến mất khỏi thư viện VÀ `calcStats` đếm thiếu. [worker/index.ts:169](worker/src/index.ts#L169).
- **L11** — Usage stats + badge cảnh báo không cập nhật sau xóa/upload (chỉ mới khi mở màn Usage). [App.tsx:660-708](desktop/src/App.tsx#L660-L708).
- **L12** — Đổi tiêu đề inline: blur luôn PATCH kể cả khi không đổi → tốn write op D1. [LibraryScreen.tsx:148-154](desktop/src/screens/LibraryScreen.tsx#L148-L154).
- **L13** — Route item (GET/PATCH/DELETE) không try/catch → lỗi trả 500 THIẾU CORS (client không đọc được); DELETE không nguyên tử (xóa R2 xong, xóa D1 lỗi → rác). [worker/index.ts:184-242](worker/src/index.ts#L184-L242).
- **L14** ⚠ — POST `/api/upload` không idempotent, `fetchRetry` retry (tới 120s abort) có thể tạo item TRÙNG nếu response mất. [api.ts:24-49](desktop/src/lib/api.ts#L24-L49). *(Tương tác với timeout 120s thêm hôm nay.)*

### ℹ️ Theo thiết kế (không phải lỗi)
- Bộ lọc mặc định "Hôm nay" ẩn mục cũ khi mở thư viện — **bạn đã chọn GIỮ**. Muốn thấy cũ hơn: bấm 7 ngày / 30 ngày / Tất cả. [LibraryScreen.tsx:126-128](desktop/src/screens/LibraryScreen.tsx#L126-L128).

---

## 3. Lỗi liên quan đến các sửa đổi trong phiên hôm nay (⚠)
Ba mục cần ưu tiên vì phát sinh/lộ ra từ thay đổi hôm nay:
- **H7** — fix Ctrl+S (chạy cả khi focus ở input) làm lộ việc `handleSave` không commit note đang gõ.
- **M9** — coalescing `listItems` khiến item vừa xóa có thể hiện lại nếu trùng lúc Refresh.
- **L14** — timeout upload 120s + retry POST có thể tạo item trùng khi response mất.

## 4. Đề xuất thứ tự sửa
1. **H4, H5** (video hỏng vĩnh viễn / ffmpeg trùng) — nghiêm trọng nhất về chức năng lõi.
2. **H7, H1, H8** (mất dữ liệu note / ảnh / chết phím tắt) — dễ gặp, mất dữ liệu.
3. **H6** (resize làm lệch + lưu sai) — ảnh hưởng chất lượng ảnh lưu.
4. **M9, M6, M3, M4** (race xóa/quay) rồi tới **M8, M7**.
5. Các mục LOW gom sửa 1 đợt (nhiều mục 1-2 dòng: L4, L5, L6, L12).

---
*Backend/API, build, capture, record cơ bản đều PASS. Các lỗi trên chủ yếu là edge case, đa màn hình, race và tính bền vững — không chặn luồng dùng chính, nhưng nên sửa dần theo thứ tự trên.*
