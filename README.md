# Chụp & Chia sẻ (Capture & Share)

Ứng dụng desktop (Windows) chụp ảnh / quay màn hình bằng phím tắt, chú thích lên ảnh, rồi
tải lên Cloudflare và nhận link chia sẻ ngay. Phiên bản hiện tại: **0.5.1**.

---

## 1. Chụp & quay

- Chụp toàn màn hình — `Ctrl + Shift + 1`
- Chụp một vùng chọn — `Ctrl + Shift + 3`
- Quay toàn màn hình (bấm lại để dừng) — `Ctrl + Shift + 2`
- Quay theo vùng chọn — `Ctrl + Shift + 4`
- Tạm dừng / quay tiếp khi đang quay — `Ctrl + Shift + H`
- Viền nhấp nháy quanh vùng đang quay để biết chỗ nào đang được ghi
- Cắt video (chọn đoạn cần giữ) trước khi lưu
- Dán ảnh từ clipboard (Ctrl + V) vào thẳng trình chỉnh sửa
- Đổi được mọi phím tắt trong phần Cài đặt
- Chọn mức chất lượng ảnh / video trong Cài đặt (720p · Full HD · 2K) — mức 2K lưu ảnh
  WebP không nén mất dữ liệu, đúng từng pixel; video ở mức cao hơn nén nhẹ hơn (nét hơn,
  file nặng hơn — mức 2K nặng ~2,5 lần mức 720p)

## 2. Chú thích ảnh

- Hình khối: chữ nhật, tròn, đường thẳng… (nút ghép, bấm ▾ để đổi hình)
- Mũi tên
- Đánh số bước ①②③ — bấm liên tiếp để đặt
- Ghi chú bằng chữ
- Tô sáng (chỉnh được màu và độ đậm)
- Che mờ vùng riêng tư (email, số điện thoại, số tài khoản…)
- Đo kích thước một vùng
- Hút màu từ ảnh
- Quét mã QR trong ảnh (hoặc quét thẳng từ màn hình)
- Chọn / di chuyển / xoá phần tử; kéo tô một vùng để chọn và xoá cả loạt
- Hoàn tác `Ctrl + Z`, làm lại `Ctrl + Y`
- Đặt tiêu đề cho mục trước khi lưu
- Sửa lại chú thích của ảnh đã đăng (ảnh gốc vẫn được giữ)

## 3. Chia sẻ

- Lưu lên Cloudflare R2, trả link công khai dạng `/v/<id>`
- Tự copy link vào clipboard sau khi lưu
- Trang xem link có sẵn cho người nhận, không cần cài gì; bấm vào ảnh để xem đúng kích thước
  thật 1:1 (màn kết quả trong app cũng vậy)
- Lưu file về máy thay vì đăng lên (với video)

## 4. Thư viện

- Xem toàn bộ ảnh / video đã đăng
- Tìm theo tiêu đề, lọc theo thời gian và theo loại (ảnh / video)
- Copy link, mở link, đổi tiêu đề, sửa lại chú thích
- Xoá một mục hoặc chọn nhiều mục xoá cùng lúc

## 5. Quản lý dữ liệu

- Xem dung lượng đang dùng, gom theo ngày / tuần / tháng
- Dọn nhanh dữ liệu cũ theo mốc thời gian (7 / 30 / 90 / 180 ngày / 1 năm, hoặc chọn ngày)
- Tra một mục theo **id, link chia sẻ, hoặc tiêu đề** — còn sống thì hiện link, đã xoá thì
  chỉ ra máy nào, thư mục nào đang giữ bản sao
- Sao lưu về máy trước khi xoá trên cloud, và khôi phục ngược lên từ thư mục đã lưu
- Mỗi lần tải về gói gọn trong một thư mục mang tên đúng mốc đang xem (`Tháng 8-2026/`,
  `24-08 – 30-08-2026/`, `15-08-2026/`); trải nhiều ngày thì bên trong chia tiếp theo ngày,
  ảnh gốc nằm cạnh ảnh đã gộp chú thích
- Sổ kho dùng chung mọi máy: máy nào đăng nhập cùng tài khoản cũng thấy nội dung đã xoá
  đang nằm ở đâu
- Đối chiếu với R2 để tìm file rác (file còn trên cloud nhưng không còn bản ghi) và dọn đi

## 6. Mức sử dụng

- Thống kê dung lượng R2 + số bản ghi D1, tốc độ tăng dữ liệu
- Ước tính khi nào chạm giới hạn gói Free của Cloudflare
- Số lượt gọi worker do chính worker tự đếm theo từng ngày

## 7. Tài khoản & hệ thống

- Đăng ký / đăng nhập, phiên đăng nhập sống 30 ngày
- Chạy nền ở khay hệ thống (system tray)
- Tự khởi động cùng Windows (bật/tắt trong Cài đặt)
- Tự kiểm tra và cài bản cập nhật mới
- Tự tải ffmpeg lần đầu nếu máy chưa có

