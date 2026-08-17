import type { Tool } from "../types";

// Bảng màu bút tô sáng. Vàng đứng đầu vì đó là màu mặc định quen thuộc của bút dạ quang.
export const HIGHLIGHT_COLORS = [
  { value: "#ffe600", label: "Vàng" },
  { value: "#4ade80", label: "Xanh lá" },
  { value: "#38bdf8", label: "Xanh dương" },
  { value: "#fb7185", label: "Hồng" },
  { value: "#c084fc", label: "Tím" },
];

export const HIGHLIGHT_MIN = 8;
export const HIGHLIGHT_MAX = 60;
// Đậm nhạt tính theo %. Dưới 10% gần như không thấy gì, trên 85% thì che mất chữ bên dưới
// — mà tô sáng là để làm nổi chữ chứ không phải bôi đen nó.
export const OPACITY_MIN = 10;
export const OPACITY_MAX = 85;

interface Props {
  tool: Tool;
  setTool: (t: Tool) => void;
  onDelete: () => void;
  canDelete: boolean;
  onBack: () => void;
  onSave: () => void;
  saving: boolean;
  title: string;
  setTitle: (t: string) => void;
  onScanQr: () => void;
  highlightColor: string;
  setHighlightColor: (c: string) => void;
  highlightThickness: number;
  setHighlightThickness: (n: number) => void;
  /** Độ đậm 0..1 */
  highlightOpacity: number;
  setHighlightOpacity: (n: number) => void;
  /** Hiện hàng tuỳ chọn khi đang cầm bút HOẶC đang chọn một vệt đã tô */
  showHighlightOptions: boolean;
  /** Đang chỉnh vệt đã tô (không phải đặt mặc định cho vệt sắp tô) */
  editingSelected: boolean;
}

export function Toolbar(props: Props) {
  const {
    tool, setTool, onDelete, canDelete, onBack, onSave, saving, title, setTitle, onScanQr,
    highlightColor, setHighlightColor, highlightThickness, setHighlightThickness,
    highlightOpacity, setHighlightOpacity, showHighlightOptions, editingSelected,
  } = props;
  const opacityPct = Math.round(highlightOpacity * 100);
  return (
    <>
      <div className="toolbar">
        <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>
          ↖ Chọn
        </button>
        <button className={tool === "box" ? "active" : ""} onClick={() => setTool("box")}>
          ▭ Khung
        </button>
        <button className={tool === "highlight" ? "active" : ""} onClick={() => setTool("highlight")}>
          <span className="hl-swatch" style={{ background: highlightColor }} /> Tô sáng
        </button>
        <button className={tool === "arrow" ? "active" : ""} onClick={() => setTool("arrow")}>
          → Mũi tên
        </button>
        <button className={tool === "step" ? "active" : ""} onClick={() => setTool("step")}>
          ① Bước
        </button>
        <button className={tool === "note" ? "active" : ""} onClick={() => setTool("note")}>
          🏷 Ghi chú
        </button>
        <button onClick={onDelete} disabled={!canDelete}>
          🗑 Xoá
        </button>
        <button onClick={onScanQr} title="Quét mã QR trong ảnh">
          ▦ QR
        </button>
        <span style={{ flex: 1 }} />
        <input
          className="title-input"
          type="text"
          placeholder="Tiêu đề (không bắt buộc)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button onClick={onBack}>← Quay lại</button>
        <button className="primary" onClick={onSave} disabled={saving}>
          {saving ? "Đang lưu…" : "💾 Lưu"}
        </button>
      </div>

      {/* Hàng tuỳ chọn chỉ hiện khi đang cầm bút tô sáng hoặc đang chọn một vệt —
          không chiếm chỗ lúc dùng công cụ khác */}
      {showHighlightOptions && (
        <div className="toolbar toolbar--sub">
          <span className="tb-label">Màu</span>
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.value}
              className={"hl-color" + (highlightColor === c.value ? " active" : "")}
              style={{ background: c.value }}
              title={c.label}
              onClick={() => setHighlightColor(c.value)}
            />
          ))}
          <span className="tb-sep" />
          <span className="tb-label">Độ dày</span>
          <input
            type="range"
            className="hl-range"
            min={HIGHLIGHT_MIN}
            // Vệt tô cả khối có thể cao hơn mức tối đa thường dùng — nới trần theo nó,
            // nếu không vừa chạm vào thanh là vệt bị bóp lại còn 60px.
            max={Math.max(HIGHLIGHT_MAX, highlightThickness)}
            step={2}
            value={highlightThickness}
            onChange={(e) => setHighlightThickness(Number(e.target.value))}
          />
          <span className="tb-value">{highlightThickness}px</span>
          <span className="tb-sep" />
          <span className="tb-label">Đậm nhạt</span>
          <input
            type="range"
            className="hl-range"
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step={5}
            value={opacityPct}
            onChange={(e) => setHighlightOpacity(Number(e.target.value) / 100)}
          />
          <span className="tb-value">{opacityPct}%</span>
          <span className="tb-sep" />
          <span className="tb-hint">
            {editingSelected
              ? "Đang chỉnh vệt đã chọn — kéo thanh để thay đổi độ dày"
              : "Kéo ngang qua dòng chữ; kéo dọc quá độ dày thì tô cả khối"}
          </span>
        </div>
      )}
    </>
  );
}
