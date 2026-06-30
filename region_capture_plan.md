# ✂️ Chụp vùng màn hình kéo chuột

Bấm phím tắt `Ctrl+Shift+3` → Rust chụp toàn màn hình, lưu vào RAM, mở một cửa sổ phủ toàn màn hình trong suốt. Người dùng kéo chuột để khoanh vùng muốn chụp. Khi thả chuột, tọa độ được nhân với DPI scale rồi gửi về Rust để cắt đúng vùng từ ảnh gốc. Cửa sổ overlay đóng lại, ảnh đã cắt được gửi thẳng vào EditorScreen như chụp toàn màn hình bình thường.

## Bước 1 — `capture.rs`
- [ ] Thêm struct `RegionState` lưu ảnh full vào RAM
- [ ] Thêm command `start_region_capture` — chụp full, lưu state, mở overlay window
- [ ] Thêm command `confirm_region_capture(x, y, w, h)` — crop ảnh, đóng overlay, emit `image-captured`
- [ ] Thêm command `cancel_region_capture` — đóng overlay, hiện lại main window
- [ ] Clamp tọa độ crop để tránh out-of-bounds

## Bước 2 — `lib.rs`
- [ ] Đăng ký `RegionState` vào Builder
- [ ] Thêm phím tắt `Ctrl+Shift+3` → gọi `start_region_capture`
- [ ] Thêm menu tray item "Chụp vùng"
- [ ] Đăng ký 3 command mới vào `invoke_handler`

## Bước 3 — `tauri.conf.json`
- [ ] Thêm window `region_selector`: transparent, fullscreen, always-on-top, ẩn lúc đầu, không titlebar

## Bước 4 — `capabilities/default.json`
- [ ] Thêm `region_selector` vào danh sách windows được cấp quyền

## Bước 5 — `RegionSelector.tsx` (tạo mới)
- [ ] Canvas fullscreen, con trỏ crosshair, nền trong suốt
- [ ] Kéo chuột vẽ vùng chọn: overlay mờ + vùng sáng + viền xanh + tooltip kích thước
- [ ] Thả chuột — nhân tọa độ với `devicePixelRatio` rồi gửi Rust
- [ ] Vùng chọn < 10px — tự động huỷ
- [ ] Nhấn ESC — huỷ, đóng overlay

## Bước 6 — `main.tsx`
- [ ] Check label window: nếu là `region_selector` → render `RegionSelector`, còn lại render `App`

## Bước 7 — `App.tsx`
- [ ] Thêm nút "Chụp vùng" vào sidebar
- [ ] Thêm hàm `manualRegionCapture` gọi `invoke("start_region_capture")`

## Bước 8 — Test
- [ ] Tọa độ crop đúng ở DPI 100%, 125%, 150%
- [ ] ESC đóng overlay, main window hiện lại
- [ ] Click không kéo (< 10px) tự huỷ không crash
- [ ] Kéo ra ngoài mép màn hình không crash
- [ ] Phím tắt hoạt động khi app đang ẩn dưới tray
- [ ] Ảnh crop vào EditorScreen đúng vùng đã chọn
