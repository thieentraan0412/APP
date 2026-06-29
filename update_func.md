# Auto-update — Checklist triển khai

> Phương án: update **toàn bộ bộ cài** (full installer) + host trên **GitHub Releases**. App tự kiểm tra, tải, cài, khởi động lại. Không dùng R2 cho update.

---

## ✅ Checklist từng bước

### A. Chuẩn bị khóa ký (1 lần)
- [x] A1. Đã tạo khóa (KHÔNG mật khẩu): `captureshare-updater.key` (private) + `.key.pub` (public)
- [x] A2. Đã thêm `*.key` vào `.gitignore` → private key không lên git
- [x] A3. Đã lưu private key vào GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` (repo thieentraan0412/APP)
- [x] A4. Đã backup file `captureshare-updater.key`

> Public key (dùng cho bước C3): `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDMzNDJGNDYyN0VBNzZDOTkKUldTWmJLZCtZdlJDTThaSGlaMDNlS2dlSUF0QkRYbVFDQTFUa0lvcHJSUnBqanlsaGhqdmdGTEcK`

### B. Cài plugin
- [x] B1. Đã thêm Rust: `tauri-plugin-updater` v2.10.1 + `tauri-plugin-process` v2.3.1
- [x] B2. Đã cài JS: `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`

### C. Cấu hình `tauri.conf.json`
- [x] C1. `bundle.createUpdaterArtifacts = true`
- [x] C2. Giữ nguyên `bundle.externalBin = ["binaries/ffmpeg"]`
- [x] C3. Thêm `plugins.updater.pubkey` (public key từ A)
- [x] C4. `endpoints` trỏ tới `https://github.com/thieentraan0412/APP/releases/latest/download/latest.json`
- [x] C5. `plugins.updater.windows.installMode = "passive"`

### D. Quyền (`capabilities/default.json`)
- [x] D1. Đã thêm `"updater:default"`
- [x] D2. Đã thêm `"process:allow-restart"`

### E. Đăng ký plugin (`src-tauri/src/lib.rs`)
- [x] E1. Đã thêm `.plugin(tauri_plugin_process::init())`
- [x] E2. Đã thêm `.plugin(tauri_plugin_updater::Builder::new().build())`

### F. Frontend
- [x] F1. Đã tạo `desktop/src/lib/updater.ts` (`checkForUpdate` + `applyUpdate`)
- [x] F2. `App.tsx`: kiểm tra update lúc khởi động + banner "Có bản cập nhật vX [Cập nhật] [Để sau]" (hiện ở mọi màn hình)
- [x] F3. Thanh tiến trình % khi tải (trong banner)
- [x] F4. `SettingsScreen`: nút "Kiểm tra cập nhật" (báo "đã mới nhất" nếu không có)

### G. CI tự phát hành (`.github/workflows/release.yml`)
- [x] G1. Workflow kích hoạt khi push tag `v*` (có `permissions: contents: write`)
- [x] G2. Step tải ffmpeg (BtbN build) về `binaries/ffmpeg-x86_64-pc-windows-msvc.exe` — *có thể thay URL bằng release riêng*
- [x] G3. `tauri-apps/tauri-action@v0` + `includeUpdaterJson: true` + secret ký (password rỗng)
- [x] G4. `releaseDraft: true`
- [x] G5. (phụ) Đã dọn 5 icon thừa ở `LibraryScreen.tsx` để `tsc` build production qua được

### H. Phát hành & kiểm thử
- [ ] H1. Tăng version khớp ở 3 file: `tauri.conf.json`, `Cargo.toml`, `package.json`
- [ ] H2. `git tag v0.2.0 && git push origin v0.2.0`
- [ ] H3. Chờ CI build xong → vào GitHub Releases → **Publish** (bỏ draft)
- [ ] H4. Cài bản cũ → mở app → thấy thông báo update → cập nhật → app restart sang bản mới ✅

---

## 📖 Giải thích

### Cơ chế hoạt động
```
App đang chạy v0.1.0
  → check() đọc latest.json trên GitHub Release mới nhất
  → Tauri tự so phiên bản: có bản mới hơn không?
       không → đứng yên
       có   → tải TOÀN BỘ *-setup.exe từ GitHub
              → kiểm chữ ký bằng public key nhúng trong app
              → chạy bộ cài NSIS → relaunch()
  → App khởi động lại ở v0.2.0
```

### A — Khóa ký (vì sao cần)
Mỗi bản update phải được **ký số** bằng *private key* của bạn; app chỉ chấp nhận file khớp *public key* nhúng sẵn. Nhờ vậy, dù kẻ tấn công chiếm được GitHub cũng **không thể** đẩy bản độc hại (thiếu private key để ký). `createUpdaterArtifacts` (C1) là thứ làm Tauri sinh file `.sig` lúc build — thiếu nó thì không có chữ ký, updater báo lỗi xác minh.
⚠️ **Mất private key = không phát hành update được cho các bản đã cài** (chúng chỉ tin key cũ) → A4 backup là bắt buộc.

### B — Plugin
- `tauri-plugin-updater`: lo việc kiểm tra/tải/cài.
- `tauri-plugin-process`: cung cấp `relaunch()` để khởi động lại app sau khi cài.
- Mỗi plugin có 2 nửa: Rust (B1) + JS (B2), phải cài cả hai.

### C — Cấu hình (ví dụ)
```jsonc
"bundle": {
  "createUpdaterArtifacts": true,
  "externalBin": ["binaries/ffmpeg"]
},
"plugins": {
  "updater": {
    "pubkey": "<PUBLIC KEY>",
    "endpoints": ["https://github.com/<user>/<repo>/releases/latest/download/latest.json"],
    "windows": { "installMode": "passive" }
  }
}
```
`endpoints` trỏ tới `latest.json` — file mô tả bản mới nhất (version, url, chữ ký) do CI tự sinh và đính vào release. `installMode: "passive"` = cài nhanh, hiện progress tối thiểu.

### D — Quyền
Tauri 2 chặn mọi API theo cơ chế permission. Không khai báo `updater:default` và `process:allow-restart` thì gọi `check()`/`relaunch()` sẽ bị từ chối.

### E — Đăng ký plugin
Thêm 2 dòng `.plugin(...)` vào `tauri::Builder::default()` trong `lib.rs` (cạnh các plugin hiện có quanh dòng 72-76), nếu không plugin không được nạp.

### F — Frontend (ví dụ `updater.ts`)
```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function checkForUpdate() {
  return await check();                 // null nếu đã mới nhất
}
export async function applyUpdate(update, onProgress) {
  let total = 0, got = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started")  total = e.data.contentLength ?? 0;
    if (e.event === "Progress") { got += e.data.chunkLength; onProgress?.(total ? got/total : 0); }
  });
  await relaunch();
}
```
Vì bộ cài nặng (~vài trăm MB do ffmpeg), F3 (thanh %) giúp người dùng biết app đang tải chứ không bị treo.

### G — CI (ví dụ workflow)
```yaml
name: release
on: { push: { tags: ["v*"] } }
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: dtolnay/rust-toolchain@stable
      - run: cd desktop && npm install
      # G2: tải ffmpeg về binaries/ TRƯỚC khi build (vì file này không có trên git)
      - name: Fetch ffmpeg
        run: |
          curl -L -o desktop/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe <URL_FFMPEG>
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: desktop
          tagName: ${{ github.ref_name }}
          releaseName: "CaptureShare ${{ github.ref_name }}"
          releaseDraft: true
          includeUpdaterJson: true
```
**Quan trọng (G2):** ffmpeg ~231MB bị `.gitignore` (vượt 100MB GitHub) nên **không có trên repo**. CI phải tự tải về đúng đường dẫn trước khi build, nếu không bản build thiếu ffmpeg → app không quay được video. `<URL_FFMPEG>` đặt một nơi cố định (vd một GitHub Release riêng chứa ffmpeg).

### H — Phát hành
- **3 file version phải khớp** (H1): lệch sẽ khiến so sánh phiên bản sai.
- Quy trình gọn: tăng version → push tag → CI lo build/ký/release → bạn chỉ cần Publish.

### Tài nguyên & chi phí
| Việc | Tốn gì |
|------|--------|
| Kiểm tra version | 1 request GitHub — rất nhẹ |
| Tải bản update (toàn bộ) | băng thông GitHub — **miễn phí với repo public** |
| R2/Worker hiện tại | như cũ, **không liên quan update** |

→ Gần như **$0**, không phình R2. Đánh đổi: mỗi update tải lại toàn bộ bộ cài (gồm ffmpeg).

### Lưu ý
- **Repo phải public** để băng thông tải miễn phí. Private vẫn chạy nhưng có giới hạn băng thông.
- **`.sig` phải tồn tại sau build** — nếu thiếu nghĩa là chưa bật `createUpdaterArtifacts` hoặc thiếu biến ký.
- Hiện chỉ làm **Windows**. Mở rộng macOS/Linux thì `tauri-action` tự thêm khóa platform vào `latest.json`.
