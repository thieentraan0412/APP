import type { ReactNode } from "react";
import type { UsageStats } from "../lib/api";

interface Props {
  stats: UsageStats | null;
  loading: boolean;
  onRefresh: () => void;
}

const LIMITS = {
  r2StorageMB:         10 * 1024,
  r2ClassAPerMonth:    1_000_000,
  r2ClassBPerMonth:    10_000_000,
  d1StorageMB:         500,
  d1RowsReadPerDay:    5_000_000,
  d1RowsWritePerDay:   100_000,
  workersReqPerDay:    100_000,
};

function Ring({ value, max, size = 72 }: { value: number; max: number; size?: number }) {
  const pct = Math.min(value / max, 1);
  const sw = 6;
  const r = (size - sw * 2) / 2;
  const circ = 2 * Math.PI * r;
  const color = pct >= 0.9 ? "#ef4444" : pct >= 0.7 ? "#f59e0b" : "#22c55e";
  const label = pct < 0.001 ? "<1%" : `${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}%`;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", position: "absolute", inset: 0 }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#e5e7eb" strokeWidth={sw}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={sw}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: pct < 0.1 ? 10 : 11, fontWeight: 800, color, letterSpacing: "-0.02em" }}>
        {label}
      </div>
    </div>
  );
}

function MetricRow({ label, value, max, display }: { label: string; value: number; max: number; display: string }) {
  const pct = Math.min(value / max, 1);
  const color = pct >= 0.9 ? "#ef4444" : pct >= 0.7 ? "#f59e0b" : "#22c55e";
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
        <span style={{ color: "#6b7280", fontWeight: 500 }}>{label}</span>
        <span style={{ color: "#374151", fontVariantNumeric: "tabular-nums", fontSize: 11.5 }}>{display}</span>
      </div>
      <div style={{ background: "#f3f4f6", borderRadius: 999, height: 5, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 999, transition: "width 1s ease" }}/>
      </div>
    </div>
  );
}

function fmt(mb: number) { return mb >= 1024 ? `${(mb/1024).toFixed(2)} GB` : `${mb.toFixed(mb < 1 ? 2 : 0)} MB`; }
function fmtN(n: number) {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n/1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

export function UsageScreen({ stats, loading, onRefresh }: Props) {
  const s = stats;
  const estR2MB   = s ? s.estimatedMB : 0;
  const estOpsA   = s ? s.totalItems * 2   : 0;
  const estOpsB   = s ? s.totalItems * 10  : 0;
  const estD1MB   = s ? s.totalItems * 0.002 : 0;
  const estD1R    = s ? s.totalItems * 5   : 0;
  const estD1W    = s ? s.totalItems * 1   : 0;
  const estWrkDay = s ? Math.round(s.totalItems * 12 / 30) : 0;

  const warns: string[] = [];
  if (s) {
    if (estR2MB / LIMITS.r2StorageMB    > 0.7) warns.push("R2 Storage vượt 70% giới hạn miễn phí (10 GB)");
    if (estOpsA / LIMITS.r2ClassAPerMonth > 0.7) warns.push("R2 Write ops vượt 70% (1M/tháng)");
    if (estD1MB / LIMITS.d1StorageMB    > 0.7) warns.push("D1 Storage vượt 70% giới hạn miễn phí (500 MB)");
    if (estWrkDay / LIMITS.workersReqPerDay > 0.7) warns.push("Workers Requests vượt 70% (100K/ngày)");
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#f4f5f7" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 28px 14px", borderBottom: "1px solid #e6e8ec", background: "#fff", flexShrink: 0 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#15161d", letterSpacing: "-0.03em" }}>Mức sử dụng</h1>
            <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "#9aa1ad" }}>
              Ước tính · Gói Cloudflare miễn phí
            </p>
          </div>
          <button
            onClick={onRefresh} disabled={loading}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8,
              background: "#f3f4f6", border: "1px solid #e5e7eb",
              color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer",
              opacity: loading ? 0.5 : 1, transition: "background .15s" }}
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: loading ? "spin 1s linear infinite" : "none" }}>
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>
            </svg>
            {loading ? "Đang tải…" : "Làm mới"}
          </button>
        </div>

        {/* Warning banner */}
        {warns.length > 0 && (
          <div style={{ margin: "12px 20px 0", padding: "10px 16px", borderRadius: 10,
            background: "#fef3c7", border: "1px solid #fcd34d",
            display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 12.5, color: "#92400e", marginBottom: 3 }}>Sắp đạt giới hạn miễn phí</div>
              <div style={{ fontSize: 12, color: "#b45309", lineHeight: 1.6 }}>{warns.join(" · ")}</div>
            </div>
          </div>
        )}

        {/* Summary pills */}
        <div style={{ display: "flex", gap: 10, padding: "14px 20px 0", flexShrink: 0 }}>
          {[
            { label: "Tổng nội dung", value: s ? String(s.totalItems) : "—", color: "#4f46e5" },
            { label: "Ảnh chụp",      value: s ? String(s.imageCount)  : "—", color: "#2563eb" },
            { label: "Video",          value: s ? String(s.videoCount)  : "—", color: "#7c3aed" },
            { label: "Est. Storage",   value: s ? fmt(estR2MB)          : "—", color: "#059669" },
          ].map((c) => (
            <div key={c.label} style={{ flex: 1, background: "#fff", border: "1px solid #e6e8ec",
              borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12,
              boxShadow: "0 1px 3px rgba(16,24,40,.05)" }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: c.color, letterSpacing: "-0.03em" }}>{c.value}</div>
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.3 }}>{c.label}</div>
            </div>
          ))}
        </div>

        {/* Service cards grid */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, padding: "12px 20px 16px", overflow: "hidden" }}>

          {/* R2 */}
          <ServiceCard
            icon="🗄️" name="Cloudflare R2" sub="Object Storage"
            mainValue={estR2MB} mainMax={LIMITS.r2StorageMB}
            metrics={[
              { label: "Storage", value: estR2MB, max: LIMITS.r2StorageMB, display: `${fmt(estR2MB)} / ${fmt(LIMITS.r2StorageMB)}` },
              { label: "Write ops / tháng", value: estOpsA, max: LIMITS.r2ClassAPerMonth, display: `${fmtN(estOpsA)} / ${fmtN(LIMITS.r2ClassAPerMonth)}` },
              { label: "Read ops / tháng",  value: estOpsB, max: LIMITS.r2ClassBPerMonth, display: `${fmtN(estOpsB)} / ${fmtN(LIMITS.r2ClassBPerMonth)}` },
            ]}
            billing={["Vượt 10 GB → $0.015/GB/tháng", "Vượt 1M write → $4.50/triệu", "Vượt 10M read → $0.36/triệu"]}
          />

          {/* D1 */}
          <ServiceCard
            icon="🗃️" name="Cloudflare D1" sub="Database"
            mainValue={estD1MB} mainMax={LIMITS.d1StorageMB}
            metrics={[
              { label: "Storage", value: estD1MB, max: LIMITS.d1StorageMB, display: `${fmt(estD1MB)} / ${fmt(LIMITS.d1StorageMB)}` },
              { label: "Rows read / ngày",  value: estD1R, max: LIMITS.d1RowsReadPerDay,  display: `${fmtN(estD1R)} / ${fmtN(LIMITS.d1RowsReadPerDay)}` },
              { label: "Rows write / ngày", value: estD1W, max: LIMITS.d1RowsWritePerDay, display: `${fmtN(estD1W)} / ${fmtN(LIMITS.d1RowsWritePerDay)}` },
            ]}
            billing={["Vượt 500 MB → $0.75/GB/tháng", "Vượt 25M rows read → $0.001/triệu", "Vượt 50M rows write → $1.00/triệu"]}
          />

          {/* Workers */}
          <ServiceCard
            icon="⚡" name="Cloudflare Workers" sub="Serverless Functions"
            mainValue={estWrkDay} mainMax={LIMITS.workersReqPerDay}
            metrics={[
              { label: "Requests / ngày (ước tính)", value: estWrkDay, max: LIMITS.workersReqPerDay, display: `~${fmtN(estWrkDay)} / ${fmtN(LIMITS.workersReqPerDay)}` },
            ]}
            billing={["Vượt 100K req/ngày → $5/tháng (Workers Paid)", "CPU > 10ms/request → tính thêm phí CPU"]}
            extra={
              <div style={{ marginTop: "auto", padding: "12px 14px",
                background: "#f9fafb", border: "1px solid #e5e7eb",
                borderRadius: 10, fontSize: 11.5, color: "#6b7280", lineHeight: 1.6 }}>
                💡 <strong style={{ color: "#374151" }}>Lưu ý:</strong> Workers miễn phí 100K request/ngày. Mỗi lần tải, upload, xem = ~1–3 requests.
              </div>
            }
          />
        </div>

        {/* Footer */}
        <div style={{ padding: "8px 20px 12px", fontSize: 11, color: "#c0c4cc", textAlign: "center", flexShrink: 0 }}>
          * Số liệu ước tính. Kiểm tra thực tế tại{" "}
          <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>
            dash.cloudflare.com
          </a>
        </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

interface ServiceCardProps {
  icon: string;
  name: string;
  sub: string;
  mainValue: number;
  mainMax: number;
  metrics: { label: string; value: number; max: number; display: string }[];
  billing: string[];
  extra?: ReactNode;
}

function ServiceCard({ icon, name, sub, mainValue, mainMax, metrics, billing, extra }: ServiceCardProps) {
  const worstPct = Math.max(...metrics.map((m) => m.value / m.max));
  const statusColor = worstPct >= 0.9 ? "#ef4444" : worstPct >= 0.7 ? "#f59e0b" : "#22c55e";
  const statusLabel = worstPct >= 0.9 ? "Sắp hết" : worstPct >= 0.7 ? "Chú ý" : "Bình thường";

  return (
    <div style={{ background: "#fff", border: "1px solid #e6e8ec",
      borderRadius: 16, padding: "18px 18px 16px", display: "flex", flexDirection: "column",
      gap: 14, overflow: "hidden", boxShadow: "0 1px 4px rgba(16,24,40,.06)" }}>

      {/* Card header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: "#f3f4f6",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: "#15161d", whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
          <div style={{ fontSize: 11.5, color: "#9aa1ad" }}>{sub}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }}/>
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
        </div>
      </div>

      {/* Ring + primary metric */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Ring value={mainValue} max={mainMax} size={68}/>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#15161d", letterSpacing: "-0.02em", lineHeight: 1 }}>
            {metrics[0]?.display.split(" / ")[0]}
          </div>
          <div style={{ fontSize: 11, color: "#9aa1ad", marginTop: 4 }}>
            giới hạn {metrics[0]?.display.split(" / ")[1]}
          </div>
          <div style={{ marginTop: 8, display: "inline-flex", padding: "2px 8px", borderRadius: 999,
            background: "#dcfce7", border: "1px solid #bbf7d0",
            fontSize: 11, fontWeight: 700, color: "#16a34a" }}>
            ✓ Miễn phí
          </div>
        </div>
      </div>

      {/* All metrics */}
      <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
        {metrics.map((m) => <MetricRow key={m.label} {...m}/>)}
      </div>

      {/* Billing */}
      <div style={{ background: "#fef2f2", border: "1px solid #fecaca",
        borderRadius: 10, padding: "10px 12px", marginTop: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#991b1b", marginBottom: 5 }}>💳 Tính phí khi vượt giới hạn</div>
        {billing.map((b, i) => (
          <div key={i} style={{ fontSize: 11.5, color: "#b91c1c", lineHeight: 1.7 }}>· {b}</div>
        ))}
      </div>

      {extra}
    </div>
  );
}
