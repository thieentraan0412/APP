import type { ReactNode } from "react";
import type { UsageStats } from "../lib/api";

interface Props {
  stats: UsageStats | null;
  loading: boolean;
  onRefresh: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LIMITS = {
  r2Storage: 10_000_000_000,
  r2ClassA: 1_000_000,
  r2ClassB: 10_000_000,
  d1Database: 500_000_000,
  d1Account: 5_000_000_000,
  d1RowsRead: 5_000_000,
  d1RowsWrite: 100_000,
  workersRequests: 100_000,
};

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(value));
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(value);
}

function percent(value: number, max: number): number {
  return max > 0 ? Math.min((value / max) * 100, 100) : 0;
}

function statusColor(pct: number): string {
  if (pct >= 90) return "#dc2626";
  if (pct >= 70) return "#d97706";
  return "#16a34a";
}

function forecast(current: number, limit: number, perDay: number, now: number) {
  if (current >= limit) return { days: 0, at: now };
  if (!Number.isFinite(perDay) || perDay <= 0) return null;
  const days = Math.ceil((limit - current) / perDay);
  return { days, at: now + days * DAY_MS };
}

function forecastText(result: ReturnType<typeof forecast>): string {
  if (!result) return "Chưa đủ dữ liệu tăng trưởng";
  if (result.days === 0) return "Đã chạm giới hạn";
  if (result.days > 3650) return "Trên 10 năm với tốc độ hiện tại";
  return `Khoảng ${formatDate(result.at)} · còn ~${formatNumber(result.days)} ngày`;
}

function Progress({ value, max }: { value: number; max: number }) {
  const pct = percent(value, max);
  return (
    <div className="usage-progress" aria-label={`${pct.toFixed(2)}%`}>
      <div style={{ width: `${pct}%`, background: statusColor(pct) }} />
    </div>
  );
}

function StatCard({ label, value, note, color }: { label: string; value: string; note: string; color: string }) {
  return (
    <div className="usage-stat-card">
      <div className="usage-stat-accent" style={{ background: color }} />
      <div className="usage-stat-label">{label}</div>
      <div className="usage-stat-value">{value}</div>
      <div className="usage-stat-note">{note}</div>
    </div>
  );
}

function ServiceCard({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return (
    <section className="usage-service-card">
      <div className="usage-card-head">
        <div>
          <div className="usage-eyebrow">{eyebrow}</div>
          <h2>{title}</h2>
        </div>
        <span className="usage-live"><i /> Dữ liệu thật</span>
      </div>
      {children}
    </section>
  );
}

function DataRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="usage-data-row">
      <div><span>{label}</span>{sub && <small>{sub}</small>}</div>
      <strong>{value}</strong>
    </div>
  );
}

export function UsageScreen({ stats, loading, onRefresh }: Props) {
  const s = stats;

  if (!s) {
    return (
      <div className="usage-page">
        <Header loading={loading} onRefresh={onRefresh} />
        <div className="usage-empty">
          <div className="usage-empty-icon">↗</div>
          <h2>{loading ? "Đang quét toàn bộ dữ liệu…" : "Chưa tải được thống kê"}</h2>
          <p>Worker sẽ đọc toàn bộ bucket R2 và database D1, không còn giới hạn 200 nội dung.</p>
          {!loading && <button onClick={onRefresh}>Thử lại</button>}
        </div>
        <UsageStyles />
      </div>
    );
  }

  const oldestAt = s.d1.oldestItemAt ?? s.generatedAt;
  const ageDays = Math.max(1, (s.generatedAt - oldestAt) / DAY_MS);
  const sampleDays = Math.min(30, ageDays);
  const recent = s.growth.last30Days;
  const avgImageBytes = s.d1.imageCount ? s.r2.imageBytes / s.d1.imageCount : 0;
  const avgVideoBytes = s.d1.videoCount ? s.r2.videoBytes / s.d1.videoCount : 0;
  const r2BytesPerDay = (recent.images * avgImageBytes + recent.videos * avgVideoBytes) / sampleDays;
  const d1BytesPerItem = s.d1.totalItems ? s.d1.bytes / s.d1.totalItems : 0;
  const d1BytesPerDay = recent.items * d1BytesPerItem / sampleDays;
  const itemsPerDay = recent.items / sampleDays;
  const r2Forecast = forecast(s.r2.bytes, LIMITS.r2Storage, r2BytesPerDay, s.generatedAt);
  const d1Forecast = forecast(s.d1.bytes, LIMITS.d1Database, d1BytesPerDay, s.generatedAt);
  const r2Pct = percent(s.r2.bytes, LIMITS.r2Storage);
  const d1Pct = percent(s.d1.bytes, LIMITS.d1Database);

  return (
    <div className="usage-page">
      <Header loading={loading} onRefresh={onRefresh} generatedAt={s.generatedAt} />

      <main className="usage-scroll">
        <div className="usage-summary-grid">
          <StatCard label="Tổng nội dung" value={formatNumber(s.d1.totalItems)} note={`${formatNumber(s.d1.imageCount)} ảnh · ${formatNumber(s.d1.videoCount)} video`} color="#4f46e5" />
          <StatCard label="R2 đang lưu" value={formatBytes(s.r2.bytes)} note={`${formatNumber(s.r2.objectCount)} object thực tế`} color="#2563eb" />
          <StatCard label="D1 đang lưu" value={formatBytes(s.d1.bytes)} note={`${formatNumber(s.d1.userCount)} tài khoản · ${formatNumber(s.d1.sessionCount)} phiên`} color="#7c3aed" />
          <StatCard label="Tốc độ 30 ngày" value={`${itemsPerDay.toFixed(itemsPerDay < 10 ? 1 : 0)} mục/ngày`} note={`+${formatNumber(recent.items)} nội dung`} color="#059669" />
        </div>

        <section className="usage-forecast">
          <div className="usage-forecast-intro">
            <span>DỰ BÁO</span>
            <h2>Khi nào chạm giới hạn Free?</h2>
            <p>Dựa trên dữ liệu hiện có và tốc độ tạo nội dung tối đa 30 ngày gần nhất.</p>
          </div>
          <div className="usage-forecast-item">
            <div><b>R2 Storage</b><span>{formatBytes(r2BytesPerDay)}/ngày</span></div>
            <strong style={{ color: statusColor(r2Pct) }}>{forecastText(r2Forecast)}</strong>
          </div>
          <div className="usage-forecast-item">
            <div><b>D1 Database</b><span>~{formatBytes(d1BytesPerDay)}/ngày</span></div>
            <strong style={{ color: statusColor(d1Pct) }}>{forecastText(d1Forecast)}</strong>
          </div>
        </section>

        <div className="usage-services-grid">
          <ServiceCard title="Cloudflare R2" eyebrow="OBJECT STORAGE">
            <div className="usage-limit-head">
              <div><strong>{formatBytes(s.r2.bytes)}</strong><span> trên 10 GB miễn phí/tháng</span></div>
              <b style={{ color: statusColor(r2Pct) }}>{r2Pct.toFixed(r2Pct < 1 ? 2 : 1)}%</b>
            </div>
            <Progress value={s.r2.bytes} max={LIMITS.r2Storage} />
            <div className="usage-data-list">
              <DataRow label="Ảnh (gồm bản gốc)" value={formatBytes(s.r2.imageBytes)} sub={`${formatNumber(s.d1.imageCount)} nội dung`} />
              <DataRow label="Trong đó: ảnh gốc" value={formatBytes(s.r2.originalBytes)} />
              <DataRow label="Video" value={formatBytes(s.r2.videoBytes)} sub={`${formatNumber(s.d1.videoCount)} nội dung`} />
              {s.r2.otherBytes > 0 && <DataRow label="Object khác" value={formatBytes(s.r2.otherBytes)} />}
              <DataRow label="Chi phí lần làm mới này" value={`${formatNumber(s.r2.listOperations)} Class A op`} sub="1 ListObjects cho mỗi 1.000 object" />
            </div>
          </ServiceCard>

          <ServiceCard title="Cloudflare D1" eyebrow="DATABASE">
            <div className="usage-limit-head">
              <div><strong>{formatBytes(s.d1.bytes)}</strong><span> trên 500 MB/database</span></div>
              <b style={{ color: statusColor(d1Pct) }}>{d1Pct.toFixed(d1Pct < 1 ? 2 : 1)}%</b>
            </div>
            <Progress value={s.d1.bytes} max={LIMITS.d1Database} />
            <div className="usage-data-list">
              <DataRow label="Tất cả bản ghi nội dung" value={formatNumber(s.d1.totalItems)} />
              <DataRow label="Tài khoản" value={formatNumber(s.d1.userCount)} />
              <DataRow label="Phiên đăng nhập" value={formatNumber(s.d1.sessionCount)} />
              <DataRow label="Rows read lần làm mới này" value={formatNumber(s.d1.rowsReadByThisRefresh)} sub={`Free: ${formatNumber(LIMITS.d1RowsRead)}/ngày`} />
              <DataRow label="Giới hạn toàn tài khoản" value={formatBytes(LIMITS.d1Account)} sub="Database này bị chặn trước ở 500 MB" />
            </div>
          </ServiceCard>
        </div>

        <section className="usage-history-card">
          <div>
            <span className="usage-eyebrow">TỐC ĐỘ TĂNG</span>
            <h2>Lịch sử nội dung</h2>
          </div>
          <div className="usage-history-grid">
            <HistoryPeriod label="7 ngày gần nhất" period={s.growth.last7Days} />
            <HistoryPeriod label="30 ngày gần nhất" period={s.growth.last30Days} />
            <div className="usage-history-period">
              <span>Khoảng dữ liệu</span>
              <strong>{s.d1.oldestItemAt ? formatDate(s.d1.oldestItemAt) : "—"}</strong>
              <small>Mới nhất: {s.d1.newestItemAt ? formatDate(s.d1.newestItemAt) : "—"}</small>
            </div>
          </div>
        </section>

        <section className="usage-analytics-note">
          <div className="usage-note-icon">i</div>
          <div>
            <h3>Ba chỉ số không thể suy ra từ dữ liệu đang lưu</h3>
            <p>Workers requests ({formatNumber(LIMITS.workersRequests)}/ngày), R2 Class A ({formatNumber(LIMITS.r2ClassA)}/tháng), R2 Class B ({formatNumber(LIMITS.r2ClassB)}/tháng) và tổng D1 rows/ngày cần Cloudflare Analytics. App không còn bịa số từ số lượng file; hãy đối chiếu các metric vận hành này trong Dashboard.</p>
          </div>
          <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer">Mở Cloudflare Dashboard ↗</a>
        </section>

        <p className="usage-footnote">Giới hạn theo tài liệu Cloudflare Free cập nhật tháng 08/2026. R2 là số byte thực tế; D1 lấy từ metadata của chính database. Dự báo là ngoại suy, không phải số liệu billing.</p>
      </main>
      <UsageStyles />
    </div>
  );
}

function Header({ loading, onRefresh, generatedAt }: { loading: boolean; onRefresh: () => void; generatedAt?: number }) {
  return (
    <header className="usage-header">
      <div>
        <h1>Mức sử dụng Cloudflare</h1>
        <p>{generatedAt ? `Toàn hệ thống · cập nhật ${new Date(generatedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}` : "Quét toàn bộ R2 và D1"}</p>
      </div>
      <button onClick={onRefresh} disabled={loading}>
        <span className={loading ? "usage-spin" : ""}>↻</span>{loading ? "Đang quét…" : "Làm mới"}
      </button>
    </header>
  );
}

function HistoryPeriod({ label, period }: { label: string; period: UsageStats["growth"]["last7Days"] }) {
  return (
    <div className="usage-history-period">
      <span>{label}</span>
      <strong>+{formatNumber(period.items)} mục</strong>
      <small>{formatNumber(period.images)} ảnh · {formatNumber(period.videos)} video</small>
    </div>
  );
}

function UsageStyles() {
  return <style>{`
    .usage-page{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:#f5f6f8;color:#171923}
    .usage-header{height:72px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #e5e7eb;flex-shrink:0}
    .usage-header h1{font-size:21px;line-height:1.1;margin:0;font-weight:800;letter-spacing:-.025em}.usage-header p{margin:5px 0 0;color:#9097a3;font-size:12px}
    .usage-header button,.usage-empty button{border:1px solid #dfe2e7;background:#fff;border-radius:9px;padding:8px 13px;color:#374151;font-weight:650;cursor:pointer;display:flex;gap:7px;align-items:center}.usage-header button:hover,.usage-empty button:hover{background:#f8fafc}.usage-header button:disabled{opacity:.55;cursor:default}
    .usage-scroll{overflow:auto;padding:18px 20px 14px}.usage-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px}
    .usage-stat-card{position:relative;background:#fff;border:1px solid #e4e7eb;border-radius:13px;padding:15px 16px 14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.025)}.usage-stat-accent{position:absolute;left:0;top:0;bottom:0;width:3px}.usage-stat-label{font-size:11.5px;color:#8a919d;font-weight:600}.usage-stat-value{font-size:22px;font-weight:800;letter-spacing:-.025em;margin-top:6px;color:#191b23}.usage-stat-note{font-size:11px;color:#9ca3af;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .usage-forecast{margin-top:11px;border-radius:14px;padding:17px 18px;display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:14px;align-items:stretch;background:linear-gradient(130deg,#eef2ff,#f5f3ff 55%,#eff6ff);border:1px solid #dfe4ff}.usage-forecast-intro span,.usage-eyebrow{font-size:9.5px;letter-spacing:.13em;color:#6366f1;font-weight:800}.usage-forecast h2,.usage-service-card h2,.usage-history-card h2{font-size:15px;margin:4px 0 0;letter-spacing:-.015em}.usage-forecast-intro p{font-size:11px;color:#747b89;line-height:1.45;margin:5px 0 0;max-width:310px}.usage-forecast-item{background:rgba(255,255,255,.8);border:1px solid rgba(199,210,254,.75);border-radius:10px;padding:12px 13px;display:flex;flex-direction:column;justify-content:center;gap:9px}.usage-forecast-item>div{display:flex;justify-content:space-between;gap:8px;font-size:11.5px}.usage-forecast-item span{color:#8b92a0}.usage-forecast-item>strong{font-size:12px}
    .usage-services-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px;margin-top:11px}.usage-service-card,.usage-history-card{background:#fff;border:1px solid #e4e7eb;border-radius:14px;padding:17px 18px;box-shadow:0 1px 3px rgba(15,23,42,.03)}.usage-card-head{display:flex;align-items:flex-start;justify-content:space-between}.usage-live{font-size:10px;color:#16803d;background:#edfdf3;border:1px solid #c8f2d5;padding:3px 7px;border-radius:99px;font-weight:700}.usage-live i{display:inline-block;width:5px;height:5px;border-radius:50%;background:#22c55e;margin-right:4px}.usage-limit-head{display:flex;align-items:baseline;justify-content:space-between;margin-top:18px;font-size:12px}.usage-limit-head strong{font-size:18px;letter-spacing:-.02em}.usage-limit-head span{color:#9aa1ac;margin-left:3px}.usage-limit-head>b{font-size:12px}.usage-progress{height:7px;border-radius:99px;background:#eef0f3;overflow:hidden;margin-top:8px}.usage-progress>div{height:100%;border-radius:99px;min-width:2px;transition:width .45s ease}.usage-data-list{margin-top:14px;border-top:1px solid #f0f1f3}.usage-data-row{min-height:43px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #f0f1f3;font-size:11.5px}.usage-data-row>div{display:flex;flex-direction:column;gap:2px;color:#555e6d}.usage-data-row small{font-size:9.5px;color:#a1a7b1}.usage-data-row strong{font-size:11.5px;color:#252a34;white-space:nowrap;font-variant-numeric:tabular-nums}
    .usage-history-card{margin-top:11px;display:grid;grid-template-columns:180px 1fr;align-items:center}.usage-history-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.usage-history-period{background:#f8f9fb;border:1px solid #eceef1;border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:3px}.usage-history-period span{font-size:10px;color:#8d95a1}.usage-history-period strong{font-size:14px}.usage-history-period small{font-size:9.5px;color:#9ca3af}
    .usage-analytics-note{margin-top:11px;background:#fffaf0;border:1px solid #fde5ad;border-radius:12px;padding:13px 15px;display:grid;grid-template-columns:25px 1fr auto;gap:11px;align-items:center}.usage-note-icon{width:21px;height:21px;border-radius:50%;display:grid;place-items:center;background:#f59e0b;color:#fff;font-weight:800;font-size:12px}.usage-analytics-note h3{font-size:12px;margin:0;color:#7c4a03}.usage-analytics-note p{font-size:10.5px;line-height:1.45;color:#9a6817;margin:3px 0 0}.usage-analytics-note a{font-size:10.5px;color:#7c4a03;font-weight:700;text-decoration:none;white-space:nowrap;border:1px solid #f5cf78;border-radius:8px;padding:7px 9px;background:#fff}.usage-footnote{text-align:center;color:#a4aab3;font-size:9.5px;margin:10px 0 0}.usage-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#737b88}.usage-empty-icon{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;background:#eef2ff;color:#4f46e5;font-size:20px}.usage-empty h2{font-size:16px;margin:12px 0 4px;color:#333944}.usage-empty p{font-size:11.5px;margin:0 0 14px}.usage-spin{display:inline-block;animation:usage-spin .8s linear infinite}@keyframes usage-spin{to{transform:rotate(360deg)}}
    @media(max-width:950px){.usage-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.usage-forecast{grid-template-columns:1fr 1fr}.usage-forecast-intro{grid-column:1/-1}.usage-services-grid{grid-template-columns:1fr}.usage-history-card{grid-template-columns:1fr;gap:12px}}
  `}</style>;
}
