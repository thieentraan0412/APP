# Mô tả dự án

## Ý tưởng tổng quan
Xây dựng một **ứng dụng desktop** cho phép người dùng dùng **phím tắt toàn cục** để **chụp ảnh** hoặc **quay toàn màn hình** ngay lập tức, sau đó **chỉnh sửa ảnh** (kẻ khung đánh dấu, ghi chú/note), **lưu lên Cloudflare R2** và **nhận ngay một đường link chia sẻ** cho nội dung vừa tạo.

## Chức năng chính

### 1. Thu thập nội dung (Capture)
- Chụp ảnh trực tiếp từ camera / màn hình của thiết bị.
- Quay video trực tiếp.
- (Tuỳ chọn) Tải lên ảnh hoặc video có sẵn từ thiết bị.

#### Phím tắt nhanh (Global hotkey) ⭐
- Người dùng bấm **một phím tắt từ màn hình máy tính** là **chụp ảnh** hoặc **quay video** ngay, không cần mở sẵn giao diện.
- Mục tiêu: thao tác cực nhanh, giống công cụ chụp màn hình (screenshot tool).

**→ Đã chốt: Desktop App.** Lý do: ưu tiên "bấm phím tắt là quay/chụp ngay toàn màn hình", không qua bước chọn màn hình, chạy được cả khi không mở trình duyệt.

- Phím tắt **toàn cục** (global hotkey) đăng ký ở tầng hệ điều hành.
- Bấm phím tắt → chụp ảnh hoặc quay **toàn bộ màn hình** ngay lập tức.
- Sau khi chụp/quay xong → mở màn hình chỉnh sửa (annotate ảnh) → lưu lên R2 → lấy link.

> Công nghệ gợi ý: **Tauri** (Rust + frontend web như React) — nhẹ, file cài nhỏ; hoặc **Electron** (nặng hơn nhưng phổ biến, dễ tìm tài liệu).

### 2. Chỉnh sửa ảnh (Edit / Annotate) — ngay trước khi lưu
> Chỉ áp dụng cho **ảnh**. Video chỉ chụp/quay rồi lưu, không cần chỉnh sửa.

- Sau khi chụp ảnh, ảnh hiển thị ngay trên một màn hình chỉnh sửa **trực tiếp**, chưa lưu vào database.
- **Kẻ khung đánh dấu (highlight box)**: vẽ khung hình chữ nhật lên vùng cần làm nổi bật trên ảnh.
- Thêm **note / chú thích** bằng văn bản gắn với vùng đánh dấu hoặc đặt tự do trên ảnh.
- Có thể di chuyển, chỉnh sửa, xoá hoặc làm lại các khung/note trước khi quyết định lưu.
- Chỉ khi người dùng nhấn **Lưu**, ảnh kèm các khung đánh dấu và note mới được đẩy vào database.

### 3. Lưu trữ (Storage) — Cloudflare R2
- File ảnh/video gốc được lưu trên **Cloudflare R2** (object storage).
- **Database** chỉ lưu metadata: thời gian tạo, người tạo, loại nội dung (ảnh/video), key của file trên R2, và dữ liệu annotate (danh sách khung đánh dấu + note kèm toạ độ).
- Tách bạch: file nặng → R2, dữ liệu mô tả nhẹ → database.

### 4. Chia sẻ (Share)
- Tự động sinh **link chia sẻ ngay lập tức** sau khi lưu.
- Người nhận có thể mở link để xem nội dung đã chỉnh sửa.

## Luồng sử dụng (User flow)
1. Người dùng mở website.
2. Chụp ảnh hoặc quay video.
3. Thêm highlight và note vào nội dung.
4. Nhấn lưu → dữ liệu được đẩy vào database.
5. Hệ thống trả về một link chia sẻ để sao chép và gửi đi.

## Công nghệ & yêu cầu kỹ thuật

### Đã chốt
- **Dạng ứng dụng**: **Desktop App** (gợi ý Tauri, hoặc Electron) — để có phím tắt toàn cục và quay toàn màn hình tức thì.
- **Lưu trữ file**: **Cloudflare R2** (tương thích S3 API). Ảnh sau khi annotate và video được upload lên R2.

### Cách lấy link với R2
- **Cách 1 — Public bucket / custom domain**: bật public access cho bucket (hoặc gắn domain riêng), mỗi file có URL công khai cố định → lấy link ngay lập tức.
- **Cách 2 — Presigned URL**: backend sinh link có thời hạn cho từng file (riêng tư hơn, link hết hạn sau một khoảng thời gian).

### Đề xuất cho các mục còn lại (kèm ưu/nhược điểm)

#### 1. Khung Desktop App: **Tauri** (khuyên dùng) vs Electron
| | Tauri ⭐ | Electron |
|---|---|---|
| Ưu | File cài nhỏ (vài MB), nhẹ RAM, bảo mật tốt, UI vẫn viết bằng React; có sẵn plugin global-shortcut | Rất phổ biến, nhiều tài liệu, mọi thư viện JS đều chạy |
| Nhược | Cần chút Rust cho phần native, cộng đồng nhỏ hơn | Nặng (file ~100MB+), ngốn RAM |

#### 2. Frontend UI + thư viện vẽ khung: **React + Konva** (khuyên dùng)
| | React + Konva ⭐ | Fabric.js | Canvas thuần |
|---|---|---|---|
| Ưu | Hợp React, dễ vẽ/di chuyển/sửa khung + text | Mạnh, nhiều tính năng vẽ | Nhẹ nhất, không phụ thuộc |
| Nhược | Thêm 1 thư viện | API kiểu cũ, ít hợp React | Tự code nhiều, dễ bug |

#### 3. Backend / API: **Cloudflare Workers** (khuyên dùng)
| | Cloudflare Workers ⭐ | Backend riêng (Node/Express) |
|---|---|---|
| Ưu | Cùng hệ với R2/D1, kết nối gọn, không cần quản server, rẻ | Linh hoạt, dễ debug local, không khóa vào 1 nhà cung cấp |
| Nhược | Giới hạn runtime, khóa vào Cloudflare | Phải tự host, tự lo scale/bảo trì |

#### 4. Database: **Cloudflare D1** hoặc Supabase
| | Cloudflare D1 ⭐ (nếu chỉ lưu metadata) | Supabase (Postgres) |
|---|---|---|
| Ưu | Cùng hệ Cloudflare, liền mạch với Workers, đủ cho metadata + annotate | Mạnh hơn, có sẵn Auth + realtime, dễ mở rộng |
| Nhược | Còn mới, tính năng SQL hạn chế hơn | Thêm 1 nhà cung cấp ngoài Cloudflare |

→ Chỉ lưu metadata đơn giản: chọn **D1**. Muốn sẵn hệ thống đăng nhập: chọn **Supabase**.

#### 5. Quyền truy cập link: **Public link** cho bản đầu
| | Public link ⭐ | Presigned / private |
|---|---|---|
| Ưu | Có link là xem ngay, đơn giản, đúng nhu cầu gửi nhanh | Bảo mật, link có thể hết hạn |
| Nhược | Ai có link đều xem được (kể cả lọt ra ngoài) | Phức tạp hơn, link có hạn dùng |

#### 6. Xác thực người dùng: **Ẩn danh** cho bản đầu
| | Ẩn danh ⭐ | Có đăng nhập |
|---|---|---|
| Ưu | Dùng được ngay, không rào cản, làm nhanh | Quản lý "ai sở hữu gì", lịch sử, xoá/sửa |
| Nhược | Không biết của ai, khó quản lý/xoá sau | Phải làm hệ thống tài khoản, chậm hơn |

### Bộ đề xuất gọn nhất (MVP)
> **Tauri + React + Konva** → **Cloudflare Workers** → **R2** + **D1**, **link công khai**, **ẩn danh**.
>
> Cùng một hệ Cloudflare, ít nhà cung cấp, ra bản chạy được nhanh nhất. Có thể thêm đăng nhập / link riêng tư sau.
