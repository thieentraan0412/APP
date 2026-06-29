# Kế hoạch tối ưu tốc độ build + cập nhật

> Mục tiêu: giảm thời gian CI build mỗi lần ra bản mới, và giảm dung lượng người dùng phải tải khi update.

---

## 1. Chẩn đoán — vì sao build lâu

Build hiện ~12-18 phút. 3 thứ ngốn thời gian nhất:

| Nguyên nhân | Mức độ |
|-------------|--------|
| **Nén ~300MB ffmpeg vào bộ cài** (LZMA rất chậm) | 🔴 Lớn nhất |
| Biên dịch Rust release (hàng trăm crate) | 🟠 Vừa (đã cache 1 phần) |
| Tải ffmpeg 319MB mỗi lần | 🟡 Nhỏ |

→ Gốc rễ: **ffmpeg quá nặng và bị nhồi vào bộ cài mỗi lần build**.

---

## 2. Đã làm (có hiệu lực từ v0.1.3)

- [x] **Chỉ build NSIS** (`targets: ["nsis"]`) — bỏ MSI, không nén ffmpeg 2 lần
- [x] **Cache ffmpeg** (`actions/cache`) — từ build thứ 2 khỏi tải 319MB
- [x] **Rust cache** (`Swatinem/rust-cache`) — không compile lại deps từ đầu

→ Dự kiến đã giảm kha khá. Phần dưới là các bước tối ưu thêm, xếp theo **hiệu quả / công sức**.

---

## 3. Lộ trình tối ưu (ưu tiên từ trên xuống)

### ⭐ Bước 1 — Dùng bản ffmpeg tối giản (DỄ, hiệu quả cao)
- [ ] Thay bản ffmpeg full (~240MB) bằng bản **chỉ chứa encoder cần** cho `gdigrab` + mp4 (~30-90MB).
- **Vì sao**: app chỉ quay màn hình → xuất mp4 (H.264/AAC), không cần toàn bộ codec. Bản nhỏ → nén nhanh hơn nhiều + bộ cài nhẹ → user tải nhanh hơn.
- **Cách**: tự build ffmpeg tối giản (`--disable-everything` + bật đúng phần cần) hoặc tìm bản "essentials" nhỏ; đặt lên 1 GitHub Release riêng; đổi URL trong workflow.
- **Hiệu quả**: giảm cả thời gian nén lẫn dung lượng tải. Công sức: thấp-trung bình.

### ⭐⭐ Bước 2 — Tách ffmpeg ra khỏi bộ cài (LỚN nhất, công sức trung bình)
- [ ] Bỏ `externalBin` trong `tauri.conf.json`.
- [ ] App tải ffmpeg **1 lần** lúc dùng video đầu tiên, lưu vào `app_data_dir`, verify SHA-256.
- [ ] Sửa `record.rs`: gọi ffmpeg từ đường dẫn đã tải thay vì sidecar.
- **Vì sao**: bộ cài chỉ còn **app ~15-40MB** → build + nén **nhanh hẳn**, và **mỗi update chỉ tải ~vài chục MB** thay vì vài trăm MB.
- **Đánh đổi**: lần đầu chạy cần mạng để tải ffmpeg.
- **Hiệu quả**: lớn nhất cho cả tốc độ build LẪN tốc độ update. Công sức: trung bình (đụng Rust).

### Bước 3 — Giảm mức nén NSIS (RẤT DỄ, đánh đổi dung lượng)
- [ ] Trong `tauri.conf.json`: `bundle.windows.nsis.compression = "none"` (hoặc `"bzip2"`).
- **Vì sao**: bỏ/giảm nén LZMA → build nhanh hơn nhiều.
- **Đánh đổi**: bộ cài **to hơn** → user tải lâu hơn (R2/GitHub băng thông free nên không tốn tiền, chỉ chậm tải).
- **Khi nào dùng**: nếu vẫn bundle ffmpeg và muốn build nhanh, chấp nhận file to. Nếu đã làm Bước 2 thì không cần.

### Bước 4 — Tinh chỉnh Cargo release profile (DỄ)
- [ ] Thêm vào `desktop/src-tauri/Cargo.toml`:
  ```toml
  [profile.release]
  lto = false           # tắt link-time optimization -> compile nhanh hơn
  codegen-units = 16    # song song hoá -> nhanh hơn
  strip = true          # bỏ symbol -> binary nhỏ hơn
  ```
- **Vì sao**: mặc định release bật LTO (nén tối ưu, compile chậm). Tắt LTO → build nhanh hơn, binary chỉ to/chậm hơn không đáng kể với app này.
- **Đánh đổi**: app chạy chậm hơn 1 chút (gần như không cảm nhận được với app desktop nhẹ).

### Bước 5 — Giữ rust-cache hiệu quả (đã ổn)
- Cache đã hoạt động. Mỗi lần bump version, `Cargo.lock` đổi → key đổi, nhưng rust-cache vẫn **restore một phần** (deps không đổi) nên vẫn nhanh. Không cần làm gì thêm.

---

## 4. Khuyến nghị

| Tình huống | Nên làm |
|-----------|---------|
| Muốn nhanh **ngay**, ít công | Bước 1 (ffmpeg nhỏ) + Bước 4 (profile) + Bước 3 (giảm nén) |
| Muốn tối ưu **triệt để** (build nhanh + update nhẹ) | **Bước 2 (tách ffmpeg)** — đáng đầu tư nhất |
| Đã ổn với tốc độ hiện tại | Giữ nguyên 3 thứ đã làm ở mục 2 |

→ **Đề xuất**: làm **Bước 1 + Bước 4** trước (dễ, hiệu quả ngay). Nếu vẫn muốn nhanh hơn nữa và update nhẹ hơn thì đầu tư **Bước 2**.

---

## 5. Ước lượng hiệu quả (tương đối)

| Cấu hình | Thời gian build | Dung lượng update |
|----------|----------------|-------------------|
| Ban đầu (all targets, ffmpeg full, LZMA) | ~15-18 phút | ~300MB |
| Đã làm (nsis only + cache) | ~8-12 phút | ~300MB |
| + Bước 1 (ffmpeg nhỏ) | ~5-8 phút | ~80-120MB |
| + Bước 4 (tắt LTO) | ~4-6 phút | ~80-120MB |
| + Bước 2 (tách ffmpeg) | **~3-5 phút** | **~20-40MB** |

> Số liệu ước lượng, tùy máy CI và bản ffmpeg cụ thể.

---

## 6. Việc KHÔNG nên làm
- ❌ Đừng commit ffmpeg vào git (vượt 100MB, làm repo nặng).
- ❌ Đừng tắt cache để "cho chắc" — mất luôn lợi ích.
- ❌ Đừng build `targets: "all"` nếu chỉ phát hành Windows — MSI thừa.
