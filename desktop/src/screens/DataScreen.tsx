import { useEffect, useMemo, useRef, useState } from "react";
import { getStorageItems, type StorageItem, type StorageOverview } from "../lib/api";

interface Props {
  overview: StorageOverview | null;
  loading: boolean;
  error: string | null;
  /** Kết quả quét R2 gần nhất (file rác) — null nếu chưa đồng bộ lần nào trong phiên này */
  orphan: { count: number; bytes: number } | null;
  syncing: boolean;
  onRefresh: () => void;
  onSync: () => void;
  onPurgeOrphans: () => void;
  /** Trả về true nếu người dùng xác nhận và đã xoá xong */
  onPurgeRange: (from: number, to: number, label: string, items: number, bytes: number) => Promise<boolean>;
  onPurgeIds: (ids: string[], bytes: number) => Promise<boolean>;
  /** Tải các mục đã chọn về máy rồi mới xoá trên cloud. true = đã xoá xong */
  onArchiveItems: (items: StorageItem[]) => Promise<boolean>;
  /** Đọc một thư mục kho dưới máy và tải các mục trong đó lên lại */
  onRestore: () => void;
  /** Tiến độ tải về / khôi phục đang chạy (null = rảnh) */
  progress: { title: string; done: number; total: number; label: string } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"];

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}
function formatNumber(value: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(value));
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isoToDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
/** dd/mm/yyyy (gõ tay) -> yyyy-mm-dd; null nếu chưa hợp lệ */
function displayToIso(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}
/** Thứ Hai đầu tuần chứa ngày này (tuần VN bắt đầu từ thứ Hai) */
function startOfWeek(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt;
}
/** Mốc 0h00 (giờ máy) của một ngày yyyy-mm-dd */
function startOfIsoDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
function fmtDateTime(ms: number): string {
  try { return new Date(ms).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

const S = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none" as const, stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IcoTrash = () => <svg {...S}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>;
const IcoRefresh = () => <svg {...S}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>;
const IcoSync = () => <svg {...S}><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>;
const IcoSave = () => <svg {...S}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>;
const IcoRestore = () => <svg {...S}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
const IcoChevron = ({ open }: { open: boolean }) => (
  <svg {...S} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}><polyline points="9 18 15 12 9 6" /></svg>
);

interface Period {
  key: string;
  label: string;
  sub: string;
  from: number;
  to: number;
  items: number;
  bytes: number;
  images: number;
  videos: number;
  unsized: number;
}

type GroupBy = "month" | "week" | "day";

/** Gom các ngày từ server thành mốc thời gian để hiển thị (theo tháng / tuần / ngày). */
function buildPeriods(overview: StorageOverview, groupBy: GroupBy): Period[] {
  if (groupBy === "day") {
    return overview.days.map((d) => {
      const from = startOfIsoDay(d.day);
      return {
        key: d.day,
        label: isoToDisplay(d.day),
        sub: new Date(from).toLocaleDateString("vi-VN", { weekday: "long" }),
        from,
        to: from + DAY_MS - 1,
        items: d.items,
        bytes: d.bytes,
        images: d.images,
        videos: d.videos,
        unsized: d.unsized,
      };
    });
  }

  if (groupBy === "week") {
    const thisWeek = toIso(startOfWeek(toIso(new Date())));
    const lastWeek = toIso(startOfWeek(toIso(new Date(Date.now() - 7 * DAY_MS))));
    const byWeek = new Map<string, Period & { days: number }>();
    for (const d of overview.days) {
      const mon = startOfWeek(d.day);
      const key = toIso(mon);
      let p = byWeek.get(key);
      if (!p) {
        const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 23, 59, 59, 999);
        p = {
          key,
          label: `${pad(mon.getDate())}/${pad(mon.getMonth() + 1)} – ${pad(sun.getDate())}/${pad(sun.getMonth() + 1)}/${sun.getFullYear()}`,
          sub: "",
          from: mon.getTime(),
          to: sun.getTime(),
          items: 0, bytes: 0, images: 0, videos: 0, unsized: 0, days: 0,
        };
        byWeek.set(key, p);
      }
      p.items += d.items;
      p.bytes += d.bytes;
      p.images += d.images;
      p.videos += d.videos;
      p.unsized += d.unsized;
      p.days += 1;
    }
    return [...byWeek.values()]
      .sort((a, b) => b.key.localeCompare(a.key))
      .map((p) => ({
        ...p,
        sub: p.key === thisWeek ? "Tuần này" : p.key === lastWeek ? "Tuần trước" : `${p.days} ngày có dữ liệu`,
      }));
  }

  const byMonth = new Map<string, Period>();
  for (const d of overview.days) {
    const key = d.day.slice(0, 7); // yyyy-mm
    let p = byMonth.get(key);
    if (!p) {
      const [y, m] = key.split("-").map(Number);
      p = {
        key,
        label: `${MONTHS[m - 1]}/${y}`,
        sub: "",
        from: new Date(y, m - 1, 1, 0, 0, 0, 0).getTime(),
        to: new Date(y, m, 1, 0, 0, 0, 0).getTime() - 1, // hết ngày cuối tháng
        items: 0, bytes: 0, images: 0, videos: 0, unsized: 0,
      };
      byMonth.set(key, p);
    }
    p.items += d.items;
    p.bytes += d.bytes;
    p.images += d.images;
    p.videos += d.videos;
    p.unsized += d.unsized;
  }
  const list = [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
  for (const p of list) {
    const days = overview.days.filter((d) => d.day.startsWith(p.key)).length;
    p.sub = `${days} ngày có dữ liệu`;
  }
  return list;
}

// Ô chọn ngày hiển thị dd/mm/yyyy (gõ tay được) + nút mở lịch — dùng chung style với
// màn Thư viện. Input date gốc hiển thị theo locale máy (dễ ra mm/dd/yyyy), lệch với
// dòng "sẽ xoá … trước ngày dd/mm/yyyy" ngay bên dưới → rất dễ xoá nhầm khoảng.
function CutoffDate({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const [draft, setDraft] = useState(() => isoToDisplay(value));
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(isoToDisplay(value)); }, [value]);

  return (
    <span className="lib-datefield">
      <input
        className="lib-date lib-date--text"
        type="text"
        inputMode="numeric"
        placeholder="dd/mm/yyyy"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const iso = displayToIso(e.target.value);
          if (iso) onChange(iso); // chỉ nhận khi đã gõ đủ và hợp lệ
        }}
        onBlur={() => setDraft(isoToDisplay(value))}
      />
      <button
        type="button"
        className="lib-date-cal"
        title="Chọn ngày"
        onClick={() => {
          const el = picker.current;
          if (!el) return;
          if (typeof el.showPicker === "function") el.showPicker();
          else el.focus();
        }}
      >
        <svg {...S}><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
      </button>
      <input
        ref={picker}
        type="date"
        className="lib-date-native"
        value={value}
        max={toIso(new Date())}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        tabIndex={-1}
        aria-hidden
      />
    </span>
  );
}

export function DataScreen(props: Props) {
  const { overview, loading, error, orphan, syncing, onRefresh, onSync, onPurgeOrphans, onPurgeRange, onPurgeIds, onArchiveItems, onRestore, progress } = props;

  const [groupBy, setGroupBy] = useState<GroupBy>("month");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [items, setItems] = useState<StorageItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsTruncated, setItemsTruncated] = useState(false);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Mốc "xoá dữ liệu cũ hơn": mặc định 90 ngày trước
  const [cutoff, setCutoff] = useState(() => toIso(new Date(Date.now() - 90 * DAY_MS)));

  const periods = useMemo(() => (overview ? buildPeriods(overview, groupBy) : []), [overview, groupBy]);
  const maxBytes = useMemo(() => periods.reduce((m, p) => Math.max(m, p.bytes), 0), [periods]);

  // Dữ liệu cũ hơn mốc đã chọn (tính từ chính các ngày server trả về → khớp với số sẽ xoá)
  const oldStats = useMemo(() => {
    if (!overview) return { items: 0, bytes: 0 };
    return overview.days
      .filter((d) => d.day < cutoff)
      .reduce((acc, d) => ({ items: acc.items + d.items, bytes: acc.bytes + d.bytes }), { items: 0, bytes: 0 });
  }, [overview, cutoff]);

  // Danh sách đang mở không còn hợp lệ khi dữ liệu tổng thay đổi (vừa xoá / làm mới)
  useEffect(() => {
    setSelected(new Set());
  }, [overview?.generatedAt]);

  async function loadItems(p: Period) {
    setItemsLoading(true);
    setItemsError(null);
    try {
      const page = await getStorageItems(p.from, p.to);
      setItems(page.items);
      setItemsTotal(page.total);
      setItemsTruncated(page.truncated);
    } catch (err) {
      setItems([]);
      setItemsError(String(err));
    } finally {
      setItemsLoading(false);
    }
  }

  function toggleOpen(p: Period) {
    if (openKey === p.key) {
      setOpenKey(null);
      setItems([]);
      setSelected(new Set());
      return;
    }
    setOpenKey(p.key);
    setItems([]);
    setSelected(new Set());
    loadItems(p);
  }

  async function run(fn: () => Promise<boolean>, reloadPeriod?: Period) {
    setBusy(true);
    try {
      const ok = await fn();
      if (ok && reloadPeriod) await loadItems(reloadPeriod);
      return ok;
    } finally {
      setBusy(false);
    }
  }

  async function deletePeriod(p: Period) {
    const ok = await run(() => onPurgeRange(p.from, p.to, p.label, p.items, p.bytes));
    if (ok && openKey === p.key) {
      setOpenKey(null);
      setItems([]);
    }
  }

  async function deleteOld() {
    if (oldStats.items === 0) return;
    const to = startOfIsoDay(cutoff) - 1;
    await run(() => onPurgeRange(0, to, `trước ngày ${isoToDisplay(cutoff)}`, oldStats.items, oldStats.bytes));
  }

  // Tải về máy rồi mới xoá. Thứ tự này do App quyết định (App chỉ xoá những mục đã lưu
  // xong), ở đây chỉ cần bỏ chọn khi việc đó kết thúc.
  async function archiveSelected(p: Period) {
    const chosen = items.filter((it) => selected.has(it.id));
    if (chosen.length === 0) return;
    const ok = await run(() => onArchiveItems(chosen), p);
    if (ok) setSelected(new Set());
  }

  async function deleteSelected(p: Period) {
    const ids = items.filter((it) => selected.has(it.id)).map((it) => it.id);
    if (ids.length === 0) return;
    const bytes = items.filter((it) => selected.has(it.id)).reduce((s, it) => s + (it.bytes ?? 0), 0);
    const ok = await run(() => onPurgeIds(ids, bytes), p);
    if (ok) setSelected(new Set());
  }

  const selectedBytes = items.filter((it) => selected.has(it.id)).reduce((s, it) => s + (it.bytes ?? 0), 0);
  const allSelected = items.length > 0 && items.every((it) => selected.has(it.id));
  // Khôi phục chạy từ header nên không đi qua run() → busy vẫn false. Chốt riêng để trong
  // lúc tải về / khôi phục không ai bấm được nút xoá.
  const locked = busy || progress !== null;

  return (
    <div className="data-page">
      <header className="data-header">
        <div>
          <h1>Quản lý dữ liệu</h1>
          <p>
            {overview
              ? `${formatBytes(overview.total.bytes)} · ${formatNumber(overview.total.items)} mục · cập nhật ${new Date(overview.generatedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`
              : "Dung lượng đang chiếm theo thời gian"}
          </p>
        </div>
        <div className="data-header-actions">
          <button onClick={onRestore} disabled={loading || busy || !!progress} title="Chọn thư mục kho đã lưu dưới máy và tải các mục trong đó lên lại">
            <IcoRestore />Khôi phục từ máy
          </button>
          <button onClick={onSync} disabled={syncing || loading || locked} title="Quét R2 để cập nhật dung lượng thật và tìm file rác">
            <span className={syncing ? "data-spin" : ""}><IcoSync /></span>{syncing ? "Đang quét…" : "Đồng bộ dung lượng"}
          </button>
          <button onClick={onRefresh} disabled={loading || locked}>
            <span className={loading ? "data-spin" : ""}><IcoRefresh /></span>{loading ? "Đang tải…" : "Làm mới"}
          </button>
        </div>
      </header>

      <main className="data-scroll">
        {error && <p className="data-error">Lỗi: {error}</p>}

        {progress && (
          <div className="data-progress">
            <div className="data-progress-head">
              <b>{progress.title}</b>
              <span>{formatNumber(progress.done)}/{formatNumber(progress.total)}</span>
            </div>
            <div className="data-progress-bar">
              <div style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            {progress.label && <small>{progress.label}</small>}
          </div>
        )}

        {!overview && !error && (
          <div className="data-empty">{loading ? "Đang tính dung lượng…" : "Chưa tải được dữ liệu."}</div>
        )}

        {overview && (
          <>
            <div className="data-summary">
              <div className="data-stat">
                <span>Tổng dung lượng</span>
                <strong>{formatBytes(overview.total.bytes)}</strong>
                <small>{formatNumber(overview.total.items)} mục đang lưu</small>
              </div>
              <div className="data-stat">
                <span>Ảnh</span>
                <strong>{formatBytes(overview.total.imageBytes)}</strong>
                <small>{formatNumber(overview.total.images)} mục (gồm cả ảnh gốc)</small>
              </div>
              <div className="data-stat">
                <span>Video</span>
                <strong>{formatBytes(overview.total.videoBytes)}</strong>
                <small>{formatNumber(overview.total.videos)} mục</small>
              </div>
              <div className="data-stat">
                <span>Khoảng thời gian</span>
                <strong>{overview.oldestAt ? new Date(overview.oldestAt).toLocaleDateString("vi-VN") : "—"}</strong>
                <small>đến {overview.newestAt ? new Date(overview.newestAt).toLocaleDateString("vi-VN") : "—"}</small>
              </div>
            </div>

            {overview.total.unsized > 0 && (
              <div className="data-notice">
                <b>{formatNumber(overview.total.unsized)} mục chưa biết dung lượng</b>
                <span>Đây là dữ liệu tạo trước khi app ghi lại kích thước. Bấm “Đồng bộ dung lượng” để quét R2 và điền số liệu.</span>
                <button className="data-btn" onClick={onSync} disabled={syncing || locked}>{syncing ? "Đang quét…" : "Đồng bộ ngay"}</button>
              </div>
            )}

            {orphan && orphan.count > 0 && (
              <div className="data-notice data-notice--warn">
                <b>File rác: {formatNumber(orphan.count)} file · {formatBytes(orphan.bytes)}</b>
                <span>File còn trên R2 nhưng không còn nội dung nào dùng tới (do lần xoá trước bị đứt giữa chừng). Xoá đi sẽ giải phóng đúng ngần này dung lượng.</span>
                <button className="data-btn data-btn--danger" onClick={onPurgeOrphans} disabled={locked || syncing}>Dọn file rác</button>
              </div>
            )}

            <section className="data-card data-cleanup">
              <div className="data-card-head">
                <h2>Dọn nhanh dữ liệu cũ</h2>
                <span className="data-hint">Xoá mọi nội dung tạo trước một mốc thời gian</span>
              </div>
              <div className="data-cleanup-row">
                <div className="data-chips">
                  {[7, 30, 90, 180, 365].map((d) => {
                    const iso = toIso(new Date(Date.now() - d * DAY_MS));
                    return (
                      <button key={d} className={cutoff === iso ? "active" : ""} onClick={() => setCutoff(iso)}>
                        {d < 365 ? `${d} ngày` : "1 năm"}
                      </button>
                    );
                  })}
                </div>
                <span className="data-cutoff">
                  Trước ngày
                  <CutoffDate value={cutoff} onChange={setCutoff} />
                </span>
              </div>
              <div className="data-cleanup-result">
                <div>
                  {oldStats.items > 0 ? (
                    <>Sẽ xoá <b>{formatNumber(oldStats.items)} mục</b> · giải phóng <b>{formatBytes(oldStats.bytes)}</b></>
                  ) : (
                    <>Không có nội dung nào cũ hơn ngày {isoToDisplay(cutoff)}</>
                  )}
                </div>
                <button className="data-btn data-btn--danger" onClick={deleteOld} disabled={oldStats.items === 0 || locked}>
                  <IcoTrash />Xoá dữ liệu cũ
                </button>
              </div>
            </section>

            <section className="data-card">
              <div className="data-card-head">
                <h2>Dữ liệu theo thời gian</h2>
                <div className="data-segment">
                  {([["month", "Theo tháng"], ["week", "Theo tuần"], ["day", "Theo ngày"]] as const).map(([g, label]) => (
                    <button
                      key={g}
                      className={groupBy === g ? "active" : ""}
                      onClick={() => { setGroupBy(g); setOpenKey(null); setItems([]); setSelected(new Set()); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {periods.length === 0 && <div className="data-empty">Chưa có nội dung nào.</div>}

              <div className="data-periods">
                {periods.map((p) => {
                  const open = openKey === p.key;
                  return (
                    <div className={`data-period${open ? " data-period--open" : ""}`} key={p.key}>
                      <div className="data-period-row" onClick={() => toggleOpen(p)}>
                        <span className="data-period-chev"><IcoChevron open={open} /></span>
                        <div className="data-period-name">
                          <b>{p.label}</b>
                          <small>{p.sub}</small>
                        </div>
                        <div className="data-period-count">
                          {formatNumber(p.items)} mục
                          <small>{formatNumber(p.images)} ảnh · {formatNumber(p.videos)} video</small>
                        </div>
                        <div className="data-period-bar">
                          <div style={{ width: `${maxBytes > 0 ? (p.bytes / maxBytes) * 100 : 0}%` }} />
                        </div>
                        <div className="data-period-size">
                          {formatBytes(p.bytes)}
                          {p.unsized > 0 && <small>{formatNumber(p.unsized)} mục chưa rõ</small>}
                        </div>
                        <button
                          className="data-ico data-ico--danger"
                          title={`Xoá toàn bộ ${p.label}`}
                          disabled={locked}
                          onClick={(e) => { e.stopPropagation(); deletePeriod(p); }}
                        >
                          <IcoTrash />
                        </button>
                      </div>

                      {open && (
                        <div className="data-period-body">
                          {itemsLoading && <div className="data-empty">Đang tải danh sách…</div>}
                          {itemsError && <p className="data-error">Lỗi: {itemsError}</p>}
                          {!itemsLoading && !itemsError && (
                            <>
                              <div className="data-itembar">
                                <label className="data-check-label">
                                  <input
                                    type="checkbox"
                                    checked={allSelected}
                                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((it) => it.id)))}
                                  />
                                  Chọn tất cả ({items.length})
                                </label>
                                <span className="data-hint">
                                  Nặng nhất xếp trước
                                  {itemsTruncated && ` · hiển thị ${items.length}/${formatNumber(itemsTotal)} mục`}
                                </span>
                                <div className="data-spacer" />
                                {selected.size > 0 && (
                                  <>
                                    <button
                                      className="data-btn data-btn--save"
                                      onClick={() => archiveSelected(p)}
                                      disabled={locked}
                                      title="Tải về thư mục trên máy, tải xong mới xoá trên cloud — khôi phục lại được"
                                    >
                                      <IcoSave />Lưu về máy & xoá {selected.size} mục
                                    </button>
                                    <button className="data-btn data-btn--danger" onClick={() => deleteSelected(p)} disabled={locked}>
                                      <IcoTrash />Xoá hẳn {selected.size} mục ({formatBytes(selectedBytes)})
                                    </button>
                                  </>
                                )}
                              </div>

                              {items.length === 0 && <div className="data-empty">Không còn nội dung nào trong mốc này.</div>}

                              <div className="data-items">
                                {items.map((it) => (
                                  <label className={`data-item${selected.has(it.id) ? " data-item--on" : ""}`} key={it.id}>
                                    <input
                                      type="checkbox"
                                      checked={selected.has(it.id)}
                                      onChange={() => setSelected((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
                                        return next;
                                      })}
                                    />
                                    <span className={`data-badge data-badge--${it.type}`}>{it.type === "image" ? "Ảnh" : "Video"}</span>
                                    <span className="data-item-title">{it.title || <i>(không tiêu đề)</i>}</span>
                                    <span className="data-item-time">{fmtDateTime(it.createdAt)}</span>
                                    <span className="data-item-size">{it.bytes == null ? "—" : formatBytes(it.bytes)}</span>
                                  </label>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <p className="data-footnote">
              Dung lượng tính theo số byte thật trên Cloudflare R2 (ảnh đã gộp + ảnh gốc dùng để sửa lại annotate).
              “Xoá hẳn” là xoá vĩnh viễn cả file lẫn link chia sẻ, không thể hoàn tác.
              “Lưu về máy &amp; xoá” tải nội dung xuống thư mục bạn chọn trước, chỉ xoá trên cloud những mục đã lưu xong,
              và khôi phục lại được bằng nút “Khôi phục từ máy” — nhưng mục khôi phục mang link chia sẻ mới, link cũ đã hỏng thì không sống lại.
            </p>
          </>
        )}
      </main>
      <DataStyles />
    </div>
  );
}

function DataStyles() {
  return <style>{`
    .data-page{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:#f5f6f8;color:#171923}
    .data-header{height:72px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #e5e7eb;flex-shrink:0}
    .data-header h1{font-size:21px;line-height:1.1;margin:0;font-weight:800;letter-spacing:-.025em}
    .data-header p{margin:5px 0 0;color:#9097a3;font-size:12px}
    .data-header-actions{display:flex;gap:8px}
    .data-header button{border:1px solid #dfe2e7;background:#fff;border-radius:9px;padding:8px 13px;color:#374151;font-weight:650;font-size:12.5px;cursor:pointer;display:flex;gap:7px;align-items:center}
    .data-header button:hover:not(:disabled){background:#f8fafc}
    .data-header button:disabled{opacity:.55;cursor:default}
    .data-scroll{overflow:auto;padding:18px 20px 14px}
    .data-error{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:9px 12px;font-size:12px;margin:0 0 11px}
    .data-empty{padding:22px;text-align:center;color:#8d95a1;font-size:12.5px}

    .data-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px}
    .data-stat{background:#fff;border:1px solid #e4e7eb;border-radius:13px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;box-shadow:0 1px 2px rgba(15,23,42,.025)}
    .data-stat span{font-size:11.5px;color:#8a919d;font-weight:600}
    .data-stat strong{font-size:21px;font-weight:800;letter-spacing:-.025em}
    .data-stat small{font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .data-notice{margin-top:11px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px 15px;display:grid;grid-template-columns:1fr auto;gap:4px 14px;align-items:center}
    .data-notice b{font-size:12.5px;color:#1e40af}
    .data-notice span{font-size:11.5px;color:#3f6299;line-height:1.45;grid-column:1}
    .data-notice button{grid-row:1/3;grid-column:2}
    .data-notice--warn{background:#fffaf0;border-color:#fde5ad}
    .data-notice--warn b{color:#92400e}.data-notice--warn span{color:#9a6817}

    .data-card{margin-top:11px;background:#fff;border:1px solid #e4e7eb;border-radius:14px;padding:16px 18px;box-shadow:0 1px 3px rgba(15,23,42,.03)}
    .data-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .data-card-head h2{font-size:15px;margin:0;letter-spacing:-.015em}
    .data-hint{font-size:11px;color:#9aa1ac}

    .data-btn{border:1px solid #dfe2e7;background:#fff;border-radius:9px;padding:8px 13px;font-size:12px;font-weight:650;color:#374151;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
    .data-btn:hover:not(:disabled){background:#f8fafc}
    .data-btn:disabled{opacity:.5;cursor:default}
    .data-btn--danger{color:#b91c1c;border-color:#fca5a5;background:#fff}
    .data-btn--danger:hover:not(:disabled){background:#fef2f2}
    .data-btn--save{color:#1d4ed8;border-color:#bfdbfe;background:#fff}
    .data-btn--save:hover:not(:disabled){background:#eff6ff}

    .data-progress{background:#fff;border:1px solid #dbeafe;border-radius:12px;padding:12px 15px;margin-bottom:11px;box-shadow:0 1px 3px rgba(15,23,42,.04)}
    .data-progress-head{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:#1e40af}
    .data-progress-head span{font-variant-numeric:tabular-nums;color:#6b7280;font-weight:650}
    .data-progress-bar{height:7px;border-radius:99px;background:#eef0f3;overflow:hidden;margin-top:9px}
    .data-progress-bar>div{height:100%;border-radius:99px;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .25s ease}
    .data-progress small{display:block;margin-top:7px;font-size:11px;color:#8a919d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    .data-segment,.data-chips{display:flex;gap:0;background:#f1f3f6;border-radius:9px;padding:3px}
    .data-segment button,.data-chips button{border:none;background:none;border-radius:7px;padding:6px 11px;font-size:11.5px;font-weight:650;color:#6b7280;cursor:pointer}
    .data-segment button.active,.data-chips button.active{background:#fff;color:#1f2937;box-shadow:0 1px 2px rgba(15,23,42,.1)}

    .data-cleanup-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:13px}
    .data-cutoff{display:flex;align-items:center;gap:8px;font-size:11.5px;color:#6b7280;font-weight:600}
    .data-cutoff input{border:1px solid #dfe2e7;border-radius:8px;padding:6px 9px;font-size:12px;font-family:inherit;color:#1f2937}
    .data-cleanup-result{margin-top:13px;padding-top:13px;border-top:1px solid #f0f1f3;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12.5px;color:#4b5563}
    .data-cleanup-result b{color:#111827}

    .data-periods{margin-top:6px}
    .data-period{border-bottom:1px solid #f0f1f3}
    .data-period:last-child{border-bottom:none}
    .data-period-row{display:grid;grid-template-columns:18px minmax(110px,1.1fr) 120px minmax(80px,1.4fr) 110px 30px;align-items:center;gap:10px;padding:11px 2px;cursor:pointer}
    .data-period-row:hover{background:#fafbfc}
    .data-period-chev{color:#b6bcc6;display:flex}
    .data-period-name b{font-size:13px;display:block}
    .data-period-name small,.data-period-count small,.data-period-size small{display:block;font-size:10px;color:#a1a7b1;margin-top:2px}
    .data-period-count{font-size:11.5px;color:#6b7280}
    .data-period-bar{height:7px;border-radius:99px;background:#eef0f3;overflow:hidden}
    .data-period-bar>div{height:100%;border-radius:99px;background:linear-gradient(90deg,#6366f1,#8b5cf6);min-width:2px;transition:width .35s ease}
    .data-period-size{font-size:12.5px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
    .data-period-size small{font-weight:500;color:#d97706}
    .data-ico{border:1px solid transparent;background:none;border-radius:8px;width:28px;height:28px;display:grid;place-items:center;cursor:pointer;color:#9aa1ac}
    .data-ico:hover:not(:disabled){background:#f1f3f6;color:#4b5563}
    .data-ico--danger:hover:not(:disabled){background:#fef2f2;color:#dc2626;border-color:#fecaca}
    .data-ico:disabled{opacity:.4;cursor:default}

    .data-period-body{background:#fafbfc;border:1px solid #eef0f3;border-radius:10px;padding:10px 12px;margin:0 0 12px}
    .data-itembar{display:flex;align-items:center;gap:12px;padding-bottom:9px;border-bottom:1px solid #eceef1;flex-wrap:wrap}
    .data-check-label{display:flex;align-items:center;gap:7px;font-size:11.5px;color:#4b5563;font-weight:600;cursor:pointer}
    .data-spacer{flex:1}
    .data-items{display:flex;flex-direction:column}
    .data-item{display:grid;grid-template-columns:16px 48px 1fr 140px 76px;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid #f0f1f3;font-size:11.5px;cursor:pointer}
    .data-item:last-child{border-bottom:none}
    .data-item:hover{background:#f4f6f8}
    .data-item--on{background:#eef2ff}
    .data-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#252a34}
    .data-item-title i{color:#a1a7b1}
    .data-item-time{color:#9aa1ac;font-size:10.5px;white-space:nowrap}
    .data-item-size{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:#252a34}
    .data-badge{font-size:9.5px;font-weight:700;padding:2px 6px;border-radius:99px;text-align:center}
    .data-badge--image{background:#eef2ff;color:#4338ca}
    .data-badge--video{background:#fef3c7;color:#92400e}

    .data-footnote{text-align:center;color:#a4aab3;font-size:9.5px;margin:12px 0 0;line-height:1.5}
    .data-spin{display:inline-block;animation:data-spin .8s linear infinite}
    @keyframes data-spin{to{transform:rotate(360deg)}}
    @media(max-width:950px){
      .data-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
      .data-period-row{grid-template-columns:18px 1fr 100px 30px}
      .data-period-bar,.data-period-count{display:none}
      .data-item{grid-template-columns:16px 48px 1fr 76px}
      .data-item-time{display:none}
    }
  `}</style>;
}
