# Hướng dẫn Build & Deploy (CaptureShare)

> Tài liệu tổng hợp: cách build app desktop và cách đẩy backend lên **Cloudflare Worker**.
> Phần **phát hành update tự động** (tăng version + push tag) xem chi tiết ở [`guild.md`](guild.md).

---

## 0. Kiến trúc tổng quan

Dự án gồm **2 phần**:

| Phần | Thư mục | Là gì | Deploy đi đâu |
|------|---------|-------|---------------|
| **Desktop app** | `desktop/` | App Tauri (React + Rust) — chụp màn hình, quay video, annotate | Đóng gói `.exe` (NSIS) → GitHub Releases |
| **Worker (backend)** | `worker/` | Cloudflare Worker — nhận upload, lưu file & metadata, sinh link chia sẻ | Cloudflare (`captures-api`) |

Luồng dữ liệu:
```
Desktop app  --(upload ảnh/video + x-api-key)-->  Worker  -->  R2 (file) + D1 (metadata)
Người xem    --(mở link chia sẻ /v/:id)-------->  Worker  -->  trả HTML/ảnh/video
```

Worker dùng 2 dịch vụ Cloudflare:
- **R2** (`BUCKET` = bucket `captures`): kho lưu file ảnh/video.
- **D1** (`DB` = database `captures-db`): lưu metadata mỗi item.

---

## 1. Yêu cầu môi trường (cài 1 lần)

| Công cụ | Dùng cho | Ghi chú |
|---------|----------|---------|
| **Node.js 20+** | frontend + worker | `node -v` |
| **Rust (stable)** | build backend Tauri | cài qua [rustup](https://rustup.rs) |
| **Visual Studio Build Tools** (Desktop C++) | link Rust trên Windows | bắt buộc trên Windows |
| **Tài khoản Cloudflare** | deploy Worker | dùng `wrangler login` |

Cài dependencies:
```bash
# frontend + tauri cli
cd desktop && npm install

# worker (wrangler)
cd ../worker && npm install
```

---

## 2. Build & chạy App Desktop

### 2.1. Cấu hình `.env` (bắt buộc trước khi chạy)

App cần biết địa chỉ Worker và API key để upload. Tạo file `desktop/.env` từ mẫu:

```bash
cd desktop
cp .env.example .env
```

Điền giá trị:
```ini
# URL Worker đã deploy (mục 3)
VITE_WORKER_URL=https://captures-api.thieentraan.workers.dev
# Khoá ghi/quản lý — PHẢI khớp secret API_KEY trên Worker
VITE_API_KEY=<khoá-bí-mật>
```

> ⚠️ `.env` bị `.gitignore` (không commit). Trên CI, giá trị này được tạo tự động từ **GitHub Secret** `VITE_API_KEY` (xem `.github/workflows/release.yml`). Chỉ biến có tiền tố `VITE_` mới được Vite expose ra frontend.

### 2.2. Chạy dev (test tại máy)

```bash
cd desktop
npm run tauri dev
```
- Vite chạy ở `http://localhost:1420`, Rust compile rồi mở cửa sổ app.
- Lần đầu compile Rust ~30s–vài phút; các lần sau nhanh nhờ cache.
- Hỗ trợ hot-reload: sửa frontend cập nhật ngay; sửa Rust (`src-tauri/`) sẽ tự build lại.

### 2.3. Build bản cài local (`.exe`)

```bash
cd desktop
npm run tauri build
```
- Output: `desktop/src-tauri/target/release/bundle/nsis/*.exe` (installer NSIS).
- `beforeBuildCommand` tự chạy `tsc && vite build` để đóng gói frontend vào `../dist`.
- Cấu hình bundle nằm ở `desktop/src-tauri/tauri.conf.json` (`bundle.targets = ["nsis"]`).

> 💡 Build local chỉ để test đóng gói. Để phát hành cho người dùng (kèm ký + updater), **dùng CI** — xem mục 4.

---

## 3. Deploy Worker (Cloudflare)

Thư mục `worker/`. Cấu hình ở `worker/wrangler.toml`:
```toml
name = "captures-api"        # tên worker
main = "src/index.ts"
[[r2_buckets]]  binding = "BUCKET"  bucket_name = "captures"
[[d1_databases]] binding = "DB"     database_name = "captures-db"  database_id = "..."
```

### 3.1. Đăng nhập Cloudflare (1 lần)
```bash
cd worker
npx wrangler login
```

### 3.2. Tạo tài nguyên (chỉ lần đầu, nếu chưa có)
```bash
# Tạo R2 bucket
npx wrangler r2 bucket create captures

# Tạo D1 database (dán database_id nhận được vào wrangler.toml)
npx wrangler d1 create captures-db
```

### 3.3. Nạp schema vào D1 (lần đầu / khi đổi bảng)
```bash
cd worker
npm run db:schema
# = wrangler d1 execute captures-db --file=schema.sql --remote
```

### 3.4. Đặt secret API_KEY (1 lần / khi đổi khoá)
Worker yêu cầu header `x-api-key` khớp secret `API_KEY` cho mọi thao tác ghi/xoá/sửa:
```bash
cd worker
npx wrangler secret put API_KEY
# dán chuỗi khoá bí mật — PHẢI giống VITE_API_KEY ở desktop/.env
```

### 3.5. Chạy thử Worker tại máy (tuỳ chọn)
```bash
cd worker
npm run dev        # wrangler dev — chạy local
```

### 3.6. Deploy lên Cloudflare
```bash
cd worker
npm run deploy     # = wrangler deploy
```
Sau khi deploy, URL sẽ dạng `https://captures-api.<account>.workers.dev`. Cập nhật URL này vào:
- `desktop/.env` → `VITE_WORKER_URL` (build local)
- GitHub Secret / `release.yml` (build CI, nếu URL đổi)

### 3.7. Các endpoint chính (tham khảo)
| Method | Path | Auth | Chức năng |
|--------|------|------|-----------|
| POST | `/api/upload` | x-api-key | Upload ảnh/video |
| GET | `/api/items` | x-api-key | Liệt kê item |
| GET/DELETE/PATCH | `/api/items/:id` | x-api-key | Xem/xoá/sửa item |
| GET | `/file/:key`, `/orig/:key` | công khai | Tải file |
| GET | `/v/:id` | công khai | Trang xem/chia sẻ (HTML) |

---

## 4. Phát hành App cho người dùng (CI tự động)

App tự cập nhật qua **GitHub Releases** + updater. **Push code thường KHÔNG tạo update** — chỉ **push tag `v*`** mới kích hoạt.

Tóm tắt (chi tiết đầy đủ ở [`guild.md`](guild.md)):

1. Tăng version **giống nhau** ở 3 file:
   - `desktop/src-tauri/tauri.conf.json` → `"version"`
   - `desktop/src-tauri/Cargo.toml` → `version`
   - `desktop/package.json` → `"version"`
2. Commit + push `main`.
3. Tạo & push tag (kích hoạt build):
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. CI (`.github/workflows/release.yml`) tự: build → **ký** → tạo GitHub Release + sinh `latest.json`.
5. App người dùng đọc `releases/latest/download/latest.json` → hiện banner cập nhật → tự tải & cài.

### Secrets cần có sẵn trên GitHub (Settings → Secrets → Actions)
| Secret | Dùng cho |
|--------|----------|
| `TAURI_SIGNING_PRIVATE_KEY` | ký bản update (khoá riêng, khớp `pubkey` trong `tauri.conf.json`) |
| `VITE_API_KEY` | inject vào `.env` lúc CI build frontend |

> Public key ký nằm ở `captureshare-updater.key.pub` và trong `tauri.conf.json > plugins.updater.pubkey`. **Không tạo lại khoá** trừ khi thực sự cần (tạo mới = mọi bản cũ không cập nhật được).

---

## 5. Checklist nhanh

**Đổi backend logic** → sửa `worker/src/index.ts` → `cd worker && npm run deploy`.
**Đổi schema DB** → sửa `worker/schema.sql` → `npm run db:schema`.
**Test app tại máy** → điền `desktop/.env` → `cd desktop && npm run tauri dev`.
**Ra bản mới cho người dùng** → tăng version 3 file → push tag `v*` → Release tự sinh.

## 6. Sự cố thường gặp
- **App báo "Thiếu cấu hình..."** → chưa tạo `desktop/.env` hoặc thiếu `VITE_WORKER_URL`/`VITE_API_KEY`.
- **Upload trả 401/403** → `VITE_API_KEY` (desktop) khác secret `API_KEY` (worker). Đặt lại cho khớp.
- **`wrangler deploy` lỗi auth** → chạy `npx wrangler login` lại.
- **CI build lỗi "Resource not accessible"** → Settings → Actions → General → Workflow permissions = **Read and write**.
- **Build Rust local lỗi linker** → thiếu Visual Studio Build Tools (Desktop development with C++).
