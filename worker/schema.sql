-- Bảng lưu metadata mỗi nội dung (ảnh/video)
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,      -- id ngắn dùng trong link
  type        TEXT NOT NULL,         -- 'image' | 'video'
  r2_key      TEXT NOT NULL,         -- key file để xem/chia sẻ (ảnh đã gộp annotate)
  r2_key_orig TEXT,                  -- key ảnh GỐC (để sửa lại annotate); NULL nếu video
  mime        TEXT NOT NULL,         -- 'image/png' | 'video/mp4'
  annotations TEXT,                  -- JSON khung + note (NULL nếu video)
  title       TEXT,                  -- tiêu đề do người dùng đặt (không bắt buộc)
  created_at  INTEGER NOT NULL,      -- thời gian tạo (epoch ms)
  bytes       INTEGER                -- tổng byte chiếm trên R2 (file gộp + ảnh gốc); NULL = chưa đối chiếu
);

CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);

-- Database đã tạo từ trước bảng này thì chạy thêm (worker cũng tự chạy lần đầu):
--   ALTER TABLE items ADD COLUMN bytes INTEGER;
-- rồi bấm "Đồng bộ dung lượng" trong trang Quản lý dữ liệu để điền số liệu cho dữ liệu cũ.

-- Bảng tài khoản người dùng (đăng nhập/đăng ký)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,      -- id ngẫu nhiên
  email         TEXT NOT NULL UNIQUE,  -- email (đã chuẩn hoá lowercase)
  password_hash TEXT NOT NULL,         -- PBKDF2-SHA256 (hex)
  password_salt TEXT NOT NULL,         -- salt ngẫu nhiên (hex)
  created_at    INTEGER NOT NULL       -- thời gian tạo (epoch ms)
);

-- Bảng phiên đăng nhập (session token lưu server, thu hồi được)
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,         -- token ngẫu nhiên gửi cho client
  user_id    TEXT NOT NULL,            -- trỏ tới users.id
  created_at INTEGER NOT NULL,         -- thời gian tạo (epoch ms)
  expires_at INTEGER NOT NULL,         -- thời gian hết hạn (epoch ms)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
