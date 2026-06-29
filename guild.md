# Hướng dẫn phát hành bản cập nhật mới (update version)

> Mỗi khi muốn ra bản mới để app người dùng tự cập nhật, làm theo các bước dưới đây.
> **Nhớ:** push code thường KHÔNG tạo update. Chỉ **tăng version + push tag** mới kích hoạt.

---

## Các bước

### 1. Sửa code xong, kiểm tra chạy được
```bash
cd desktop
npm run tauri dev      # test thử trước khi phát hành
```

### 2. Tăng version ở **3 file** (phải GIỐNG NHAU)

| File | Dòng cần sửa |
|------|--------------|
| `desktop/src-tauri/tauri.conf.json` | `"version": "0.2.0"` |
| `desktop/src-tauri/Cargo.toml` | `version = "0.2.0"` |
| `desktop/package.json` | `"version": "0.2.0"` |

> Quy tắc version (semver): `0.1.0` → `0.1.1` (sửa lỗi nhỏ) / `0.2.0` (thêm tính năng) / `1.0.0` (bản lớn).
> Version mới **phải cao hơn** bản cũ, nếu không app sẽ không nhận là update.

### 3. Commit + push code lên main
```bash
git add -A
git commit -m "feat: <mô tả thay đổi>"
git push origin main
```

### 4. Tạo tag + push (← BƯỚC KÍCH HOẠT BUILD)
```bash
git tag v0.2.0
git push origin v0.2.0
```
> Tên tag phải là `v` + version, ví dụ version `0.2.0` → tag `v0.2.0`.

### 5. Chờ CI build (~3-7 phút nhờ cache; lần đầu ~15 phút)
- Xem tiến trình: `https://github.com/thieentraan0412/APP/actions`
- CI tự: build → ký → tạo **GitHub Release (draft)** + sinh `latest.json`.

### 6. Publish release
- Vào `https://github.com/thieentraan0412/APP/releases`
- Mở release `v0.2.0` (đang là **Draft**) → sửa ghi chú nếu muốn → bấm **Publish release**.
- ⚠️ Phải Publish (bỏ draft) thì app người dùng mới thấy, vì updater đọc `releases/latest`.

### 7. Xong — app tự cập nhật
- Người dùng mở app (bản cũ) → hiện banner **"Có bản cập nhật v0.2.0"** → bấm **Cập nhật ngay** → app tự tải + cài + khởi động lại.

---

## Tóm tắt nhanh (copy-paste)
```bash
# sau khi đã sửa version ở 3 file thành 0.2.0:
git add -A
git commit -m "feat: mô tả thay đổi"
git push origin main
git tag v0.2.0
git push origin v0.2.0
# rồi vào GitHub Releases → Publish bản draft
```

---

## Lưu ý / xử lý sự cố

- **Quên Publish** → app không thấy bản mới. Vào Releases bấm Publish.
- **Version 3 file lệch nhau** → build lỗi hoặc so sánh sai. Kiểm tra cả 3.
- **Build lỗi "create-a-release / Resource not accessible"** → vào Settings → Actions → General → **Workflow permissions** = **Read and write permissions** → Save.
- **Đặt nhầm tag trùng** (vd v0.2.0 đã tồn tại) → xóa rồi tạo lại:
  ```bash
  git push origin :refs/tags/v0.2.0   # xóa remote
  git tag -d v0.2.0                    # xóa local
  git tag v0.2.0 && git push origin v0.2.0
  ```
- **Muốn build nhanh hơn** → đã có cache Rust trong workflow, lần sau tự nhanh.
- **ffmpeg**: CI tự tải, không cần làm gì. Nếu muốn đổi bản ffmpeg → sửa URL trong `.github/workflows/release.yml`.

---

## Những thứ KHÔNG cần làm lại mỗi lần
- ❌ Không cần tạo lại khóa ký (đã có, dùng mãi).
- ❌ Không cần build .exe bằng tay (CI lo).
- ❌ Không cần đụng Cloudflare/Worker (chỉ liên quan ảnh/video, không liên quan update).
- ❌ Người dùng KHÔNG cần tải/cài tay (app tự cập nhật tại chỗ).
