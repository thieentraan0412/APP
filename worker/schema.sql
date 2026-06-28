-- Bảng lưu metadata mỗi nội dung (ảnh/video)
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,      -- id ngắn dùng trong link
  type        TEXT NOT NULL,         -- 'image' | 'video'
  r2_key      TEXT NOT NULL,         -- key file để xem/chia sẻ (ảnh đã gộp annotate)
  r2_key_orig TEXT,                  -- key ảnh GỐC (để sửa lại annotate); NULL nếu video
  mime        TEXT NOT NULL,         -- 'image/png' | 'video/mp4'
  annotations TEXT,                  -- JSON khung + note (NULL nếu video)
  created_at  INTEGER NOT NULL       -- thời gian tạo (epoch ms)
);

CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
