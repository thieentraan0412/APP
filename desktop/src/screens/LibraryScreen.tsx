import { useMemo, useState } from "react";
import type { LibraryItem } from "../lib/api";

interface Props {
  items: LibraryItem[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onBack: () => void;
  onCopy: (url: string) => void;
  onOpen: (url: string) => void;
  onDelete: (id: string) => void;
  onEdit: (item: LibraryItem) => void;
}

function fmtDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString("vi-VN");
  } catch {
    return "";
  }
}

// yyyy-mm-dd (theo giờ địa phương) cho <input type="date">
function toInputDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function startOfDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
function endOfDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

export function LibraryScreen(props: Props) {
  const { items, loading, error, onRefresh, onBack, onCopy, onOpen, onDelete, onEdit } = props;

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");

  function presetDays(days: number) {
    const today = new Date();
    const start = new Date();
    start.setDate(today.getDate() - (days - 1));
    setFrom(toInputDate(start));
    setTo(toInputDate(today));
  }
  function clearFilter() {
    setFrom("");
    setTo("");
  }

  const filtered = useMemo(() => {
    const list = items.filter((it) => {
      if (from && it.createdAt < startOfDay(from)) return false;
      if (to && it.createdAt > endOfDay(to)) return false;
      if (typeFilter !== "all" && it.type !== typeFilter) return false;
      return true;
    });
    list.sort((a, b) =>
      sortOrder === "newest" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt
    );
    return list;
  }, [items, from, to, typeFilter, sortOrder]);

  return (
    <main className="container">
      <div className="topbar">
        <h2 style={{ margin: 0, flex: 1 }}>Thư viện nội dung</h2>
        <button onClick={onRefresh} disabled={loading}>
          {loading ? "Đang tải…" : "↻ Làm mới"}
        </button>
        <button onClick={onBack}>← Trang chính</button>
      </div>

      {/* Lọc theo thời gian */}
      <div className="filterbar">
        <label>
          Từ:{" "}
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Đến:{" "}
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button onClick={() => presetDays(1)}>Hôm nay</button>
        <button onClick={() => presetDays(7)}>7 ngày</button>
        <button onClick={() => presetDays(30)}>30 ngày</button>
        <button onClick={clearFilter}>Tất cả</button>

        <label>
          Loại:{" "}
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
            <option value="all">Tất cả</option>
            <option value="image">Ảnh</option>
            <option value="video">Video</option>
          </select>
        </label>
        <label>
          Sắp xếp:{" "}
          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}>
            <option value="newest">Mới nhất</option>
            <option value="oldest">Cũ nhất</option>
          </select>
        </label>

        <span className="count">
          {filtered.length}/{items.length} mục
        </span>
      </div>

      {error && <p className="error">Lỗi: {error}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="hint">Chưa có nội dung nào. Hãy chụp ảnh hoặc quay video.</p>
      )}
      {!loading && !error && items.length > 0 && filtered.length === 0 && (
        <p className="hint">Không có nội dung nào trong khoảng thời gian đã chọn.</p>
      )}

      <div className="grid">
        {filtered.map((it) => (
          <div className="card" key={it.id}>
            <div className="thumb" onClick={() => onOpen(it.url)} title="Mở link">
              {it.type === "image" ? (
                <img src={it.fileUrl} alt={it.id} loading="lazy" />
              ) : (
                <div className="thumb-video">🎥 Video</div>
              )}
            </div>
            <div className="card-meta">
              <span className="type-tag">{it.type === "image" ? "Ảnh" : "Video"}</span>
              <span className="date">{fmtDate(it.createdAt)}</span>
            </div>
            <div className="card-actions">
              <button onClick={() => onCopy(it.url)} title="Copy link">📋</button>
              <button onClick={() => onOpen(it.url)} title="Mở link">🔗</button>
              {it.type === "image" && (
                <button onClick={() => onEdit(it)} title="Sửa annotate">✏️</button>
              )}
              <button className="danger" onClick={() => onDelete(it.id)} title="Xoá">🗑</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
