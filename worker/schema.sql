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

-- Sổ đăng ký các kho lưu trữ dưới máy. Mục đích: từ bất kỳ máy nào cũng tra được một
-- nội dung đã xoá khỏi cloud hiện đang nằm ở MÁY NÀO, THƯ MỤC NÀO.
-- Một kho = một thư mục trên một máy, nên (device, dir) là khoá.
CREATE TABLE IF NOT EXISTS archive_stores (
  id         TEXT PRIMARY KEY,      -- id ngẫu nhiên, dùng để tham chiếu từ archive_items
  device     TEXT NOT NULL,         -- tên máy (COMPUTERNAME)
  dir        TEXT NOT NULL,         -- đường dẫn thư mục trên máy đó
  items      INTEGER NOT NULL,      -- số mục trong kho
  bytes      INTEGER NOT NULL,      -- tổng dung lượng kho
  updated_at INTEGER NOT NULL,      -- lần cập nhật gần nhất (epoch ms)
  UNIQUE (device, dir)
);

-- Từng mục nằm trong kho nào. Một mục có thể nằm ở nhiều kho (lưu nhiều bản sao) nên
-- khoá là cặp (item_id, store_id).
CREATE TABLE IF NOT EXISTS archive_items (
  item_id     TEXT NOT NULL,        -- id cũ của mục, khớp items.id lúc chưa xoá
  store_id    TEXT NOT NULL,
  type        TEXT NOT NULL,        -- 'image' | 'video'
  title       TEXT,
  bytes       INTEGER,
  created_at  INTEGER,              -- thời điểm chụp/quay gốc
  archived_at INTEGER,              -- thời điểm lưu về máy
  file        TEXT,                 -- tên file trong thư mục kho
  PRIMARY KEY (item_id, store_id),
  FOREIGN KEY (store_id) REFERENCES archive_stores(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_archive_items_store ON archive_items(store_id);
CREATE INDEX IF NOT EXISTS idx_archive_items_item ON archive_items(item_id);

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
