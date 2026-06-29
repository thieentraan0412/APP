import { useMemo, useRef, useState } from "react";
import type { LibraryItem } from "../lib/api";

interface Props {
  items: LibraryItem[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCopy: (url: string) => void;
  onOpen: (url: string) => void;
  onDelete: (id: string) => void;
  onEdit: (item: LibraryItem) => void;
  onSaveTitle: (id: string, title: string) => void;
}

function fmtDate(ms: number): string {
  try { return new Date(ms).toLocaleString("vi-VN"); } catch { return ""; }
}
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

// ── SVG icons (explicit w/h để tránh browser default 300×150) ──
const S = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none" as const, stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const Ss = { ...S, width: 16, height: 16 };

const IcoHome = () => <svg {...S}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5Z"/><polyline points="9 21 9 12 15 12 15 21"/></svg>;
const IcoCamera = () => <svg {...S}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3.5"/></svg>;
const IcoRecord = () => <svg {...S}><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8Z"/></svg>;
const IcoLibrary = () => <svg {...S}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
const IcoSettings = () => <svg {...S}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 5a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 15 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>;
const IcoRefresh = () => <svg {...Ss}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>;
const IcoSearch = () => <svg {...Ss}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const IcoCopy = () => <svg {...Ss}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
const IcoLink = () => <svg {...Ss}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>;
const IcoEdit = () => <svg {...Ss}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>;
const IcoTag = () => <svg {...Ss}><path d="M20.59 13.41 12 22l-9-9V3h10l7.59 7.59a2 2 0 0 1 0 2.82Z"/><circle cx="7.5" cy="7.5" r="1.4"/></svg>;
const IcoTrash = () => <svg {...Ss}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;
const IcoFilm = () => <svg {...Ss}><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8Z"/></svg>;
const IcoStats = () => <svg {...S}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;

// ── Main component ─────────────────────────────────────────
export function LibraryScreen(props: Props) {
  const { items, loading, error, onRefresh, onCopy, onOpen, onDelete, onEdit, onSaveTitle } = props;

  const todayStr = toInputDate(new Date());
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [range, setRange] = useState<"today" | "7" | "30" | "all">("today");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editingRef = useRef<string | null>(null);

  function startEdit(it: LibraryItem) {
    editingRef.current = it.id;
    setEditingId(it.id);
    setDraft(it.title ?? "");
  }
  function finishEdit(save: boolean) {
    const id = editingRef.current;
    if (id == null) return;
    editingRef.current = null;
    setEditingId(null);
    if (save) onSaveTitle(id, draft.trim());
  }

  function setRangePreset(r: typeof range) {
    setRange(r);
    if (r === "all") { setFrom(""); setTo(""); return; }
    const today = new Date();
    const end = toInputDate(today);
    if (r === "today") { const s = toInputDate(today); setFrom(s); setTo(s); return; }
    const start = new Date();
    start.setDate(today.getDate() - (r === "7" ? 6 : 29));
    setFrom(toInputDate(start));
    setTo(end);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = items.filter((it) => {
      if (q && !(it.title || "").toLowerCase().includes(q)) return false;
      if (from && it.createdAt < startOfDay(from)) return false;
      if (to && it.createdAt > endOfDay(to)) return false;
      if (typeFilter !== "all" && it.type !== typeFilter) return false;
      return true;
    });
    list.sort((a, b) => sortOrder === "newest" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
    return list;
  }, [items, query, from, to, typeFilter, sortOrder]);

  return (
    <main className="lib-main">
        <div className="lib-inner">

          {/* Header */}
          <div className="lib-head">
            <h1 className="lib-title">Thư viện nội dung</h1>
            <div className="lib-head-actions">
              <button className="lib-btn lib-btn--secondary" onClick={onRefresh} disabled={loading}>
                <IcoRefresh />{loading ? "Đang tải…" : "Làm mới"}
              </button>
            </div>
          </div>

          {error && <p className="lib-error">Lỗi: {error}</p>}

          {/* Search */}
          <div className="lib-search">
            <IcoSearch />
            <input
              type="text"
              placeholder="Tìm theo tiêu đề…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && <button className="lib-clear" onClick={() => setQuery("")}>✕</button>}
          </div>

          {/* Filters */}
          <div className="lib-filters">
            <div className="lib-field">
              <label>Từ:</label>
              <input className="lib-date" type="date" value={from} max={to || undefined}
                onChange={(e) => { setFrom(e.target.value); setRange("all"); }} />
            </div>
            <div className="lib-field">
              <label>Đến:</label>
              <input className="lib-date" type="date" value={to} min={from || undefined}
                onChange={(e) => { setTo(e.target.value); setRange("all"); }} />
            </div>

            <div className="lib-segment">
              {(["today", "7", "30", "all"] as const).map((r) => (
                <button key={r} className={range === r ? "active" : ""} onClick={() => setRangePreset(r)}>
                  {r === "today" ? "Hôm nay" : r === "7" ? "7 ngày" : r === "30" ? "30 ngày" : "Tất cả"}
                </button>
              ))}
            </div>

            <div className="lib-field">
              <label>Loại:</label>
              <select className="lib-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
                <option value="all">Tất cả</option>
                <option value="image">Ảnh</option>
                <option value="video">Video</option>
              </select>
            </div>

            <div className="lib-field">
              <label>Sắp xếp:</label>
              <select className="lib-select" value={sortOrder} onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}>
                <option value="newest">Mới nhất</option>
                <option value="oldest">Cũ nhất</option>
              </select>
            </div>

            <span className="lib-count">{filtered.length}/{items.length} mục</span>
          </div>

          {/* Grid */}
          {!loading && items.length === 0 && !error && (
            <div className="lib-empty">
              <IcoCamera />
              <p>Chưa có nội dung nào. Hãy chụp ảnh hoặc quay video.</p>
            </div>
          )}
          {!loading && items.length > 0 && filtered.length === 0 && (
            <div className="lib-empty">
              <IcoSearch />
              <p>Không có nội dung phù hợp với bộ lọc.</p>
            </div>
          )}

          <div className="lib-grid">
            {filtered.map((it) => (
              <article className="lib-card" key={it.id}>
                {/* Thumbnail */}
                <div
                  className={`lib-thumb ${it.type === "video" ? "lib-thumb--video" : "lib-thumb--image"}`}
                  onClick={() => onOpen(it.url)}
                  title="Mở link"
                >
                  {it.type === "image" ? (
                    <img src={it.fileUrl} alt={it.title ?? it.id} loading="lazy" />
                  ) : (
                    <span className="lib-video-label"><IcoFilm />Video</span>
                  )}
                </div>

                {/* Title */}
                <div className="lib-card-body">
                  {editingId === it.id ? (
                    <input
                      className="lib-title-input"
                      autoFocus
                      value={draft}
                      placeholder="Nhập tiêu đề…"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); finishEdit(true); }
                        else if (e.key === "Escape") { e.preventDefault(); finishEdit(false); }
                      }}
                      onBlur={() => finishEdit(true)}
                    />
                  ) : (
                    <div className="lib-card-title" onClick={() => startEdit(it)} title="Bấm để sửa tiêu đề">
                      {it.title || <span className="lib-untitled">(không tiêu đề)</span>}
                    </div>
                  )}

                  {/* Meta */}
                  <div className="lib-card-meta">
                    <span className={`lib-badge ${it.type === "video" ? "lib-badge--video" : "lib-badge--image"}`}>
                      {it.type === "image" ? "Ảnh" : "Video"}
                    </span>
                    <span className="lib-card-time">{fmtDate(it.createdAt)}</span>
                  </div>

                  {/* Actions */}
                  <div className="lib-card-actions">
                    <button className="lib-ico" onClick={() => onCopy(it.url)} title="Copy link"><IcoCopy /></button>
                    <button className="lib-ico" onClick={() => onOpen(it.url)} title="Mở link"><IcoLink /></button>
                    <button className="lib-ico" onClick={() => startEdit(it)} title="Đổi tiêu đề"><IcoTag /></button>
                    {it.type === "image" && (
                      <button className="lib-ico" onClick={() => onEdit(it)} title="Sửa annotate"><IcoEdit /></button>
                    )}
                    <button className="lib-ico lib-ico--danger" onClick={() => onDelete(it.id)} title="Xoá"><IcoTrash /></button>
                  </div>
                </div>
              </article>
            ))}
          </div>

        </div>
      </main>
  );
}
