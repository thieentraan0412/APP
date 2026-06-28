# Chụp & chia sẻ (Capture & Share)

Ứng dụng desktop chụp ảnh / quay màn hình bằng **phím tắt toàn cục**, chỉnh sửa ảnh (kẻ khung + ghi chú), lưu lên **Cloudflare R2** và nhận **link chia sẻ ngay lập tức**.

## Tính năng
- 📸 Chụp toàn màn hình: `Ctrl + Shift + 1`
- 🎥 Quay toàn màn hình (bật/tắt): `Ctrl + Shift + 2`
- ✏️ Kẻ khung đánh dấu + ghi chú trên ảnh trước khi lưu
- ☁️ Lưu lên Cloudflare R2 + metadata trong D1, trả link công khai
- 🗂 Thư viện quản lý: xem / copy link / mở / **sửa annotate** / xoá, lọc theo thời gian & loại
- 🔔 Chạy nền ở khay hệ thống (system tray)

## Công nghệ
- **App desktop**: Tauri 2 (Rust) + React + TypeScript + Konva
- **Chụp màn hình**: crate `xcap`; **Quay video**: `ffmpeg` (sidecar) + gdigrab
- **Backend**: Cloudflare Workers + R2 (file) + D1 (metadata)

## Cấu trúc
- `desktop/` — ứng dụng Tauri (frontend `src/`, Rust `src-tauri/`)
- `worker/` — Cloudflare Worker (API)
- `begin.md`, `implement.md`, `checklist.md` — mô tả / kế hoạch / tiến độ

## Thiết lập sau khi clone
1. **ffmpeg sidecar** (không có trong repo do vượt 100MB): tải `ffmpeg.exe` rồi đặt vào
   `desktop/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`
2. Cài phụ thuộc:
   ```bash
   cd desktop && npm install
   cd ../worker && npm install
   ```
3. Chạy app (dev): `cd desktop && npm run tauri dev`
4. Deploy Worker: `cd worker && wrangler deploy`

## Yêu cầu
- Node.js, Rust (toolchain MSVC), Visual Studio Build Tools (C++), ffmpeg
- Tài khoản Cloudflare (R2 + D1)
