import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { Tool } from "../types";
import {
  IconArrow, IconBlur, IconBox, IconCaret, IconEllipse, IconEyedrop, IconHighlight,
  IconLine, IconMeasure, IconMore, IconNote, IconPen, IconQr, IconRedo, IconSelect,
  IconStep, IconTrash, IconUndo,
} from "./icons";

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
// Bán kính làm mờ. Dưới 6 vẫn đọc mò được chữ (che mà không che), trên 40 thì cả vùng
// thành một mảng xám vô nghĩa.
export const BLUR_MIN = 6;
export const BLUR_MAX = 40;

// Các công cụ hình vẽ nằm chung trong nút "Khung ▾" — cùng một việc (vẽ hình lên ảnh) nên
// gom lại, thay vì xếp bốn nút cạnh nhau làm hàng công cụ dài ra.
const SHAPE_TOOLS: { tool: Tool; Icon: ComponentType; label: string }[] = [
  { tool: "box", Icon: IconBox, label: "Khung" },
  { tool: "ellipse", Icon: IconEllipse, label: "Hình tròn" },
  { tool: "line", Icon: IconLine, label: "Đường thẳng" },
  { tool: "pen", Icon: IconPen, label: "Bút" },
];

// Dưới ngưỡng này App.css đã ẩn nhãn chữ của nút — cũng là lúc hàng công cụ hết rộng rãi,
// nên Che mờ và QR (không dùng liên tục như bút vẽ) rút xuống menu ⋮ thay vì chen tiếp.
// Phải làm bằng JS chứ không phải CSS: hai nút đổi CHỖ trong cây DOM chứ không chỉ đổi
// cách hiện, mà CSS thì không di chuyển được phần tử sang menu khác.
const COMPACT_QUERY = "(max-width: 1180px)";

function useCompact() {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact;
}

interface Props {
  tool: Tool;
  setTool: (t: Tool) => void;
  onDelete: () => void;
  canDelete: boolean;
  /** Số phần tử đang chọn — hiện lên nút Xoá để biết sắp xoá mấy cái */
  deleteCount: number;
  onBack: () => void;
  onSave: () => void;
  saving: boolean;
  title: string;
  setTitle: (t: string) => void;
  onScanQr: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
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
  /** Số sẽ đóng cho mốc Bước kế tiếp */
  stepNext: number;
  setStepNext: (n: number) => void;
  stepWithText: boolean;
  setStepWithText: (v: boolean) => void;
  blurStrength: number;
  setBlurStrength: (n: number) => void;
  /** Mã hex vừa hút được (null = chưa hút lần nào) */
  pickedColor: string | null;
  /** Số đo của thước đang chọn (null = chưa đo/chưa chọn cái nào) */
  measureReadout: {
    w: number;
    h: number;
    dist: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null;
}

// ①②③… tới ⑳; quá 20 thì hiện số thường.
function circled(n: number): string {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : String(n);
}

/** Đóng menu khi bấm ra ngoài hoặc nhấn Esc — thiếu cái này menu treo lại rất khó chịu. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // đừng để Esc thoát luôn trình sửa
        close();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);
  return ref;
}

export function Toolbar(props: Props) {
  const {
    tool, setTool, onDelete, canDelete, deleteCount, onBack, onSave, saving, title, setTitle, onScanQr,
    onUndo, onRedo, canUndo, canRedo,
    highlightColor, setHighlightColor, highlightThickness, setHighlightThickness,
    highlightOpacity, setHighlightOpacity, showHighlightOptions, editingSelected,
    stepNext, setStepNext, stepWithText, setStepWithText, measureReadout,
    blurStrength, setBlurStrength, pickedColor,
  } = props;

  const compact = useCompact();
  const [shapesOpen, setShapesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Hình vẽ dùng gần nhất — bấm vào phần thân nút là dùng lại ngay, không phải mở menu.
  const [lastShape, setLastShape] = useState<Tool>("box");

  const shapesRef = useDismiss(shapesOpen, () => setShapesOpen(false));
  const moreRef = useDismiss(moreOpen, () => setMoreOpen(false));

  const shapeActive = SHAPE_TOOLS.some((s) => s.tool === tool);
  const current = SHAPE_TOOLS.find((s) => s.tool === (shapeActive ? tool : lastShape)) ?? SHAPE_TOOLS[0];
  const opacityPct = Math.round(highlightOpacity * 100);
  const hiddenToolActive =
    tool === "measure" || tool === "eyedrop" || (compact && tool === "blur");

  // Bấm lại vào công cụ ĐANG bật = tắt nó, trở về Chọn. Trước đây bấm lại không có tác dụng
  // gì: muốn thôi vẽ phải nhớ bấm sang nút Chọn, không thì lỡ tay bấm lên ảnh là ra thêm
  // một mốc/vệt nữa.
  function toggleTool(t: Tool) {
    setTool(tool === t ? "select" : t);
  }

  // Chọn hình từ menu ▾ thì LUÔN bật hình đó — đây là lựa chọn có chủ đích ("tôi muốn hình
  // tròn"), không phải cú bấm lặp lại. Muốn tắt thì bấm vào thân nút, chỗ có toggle.
  function pickShape(t: Tool) {
    setLastShape(t);
    setTool(t);
    setShapesOpen(false);
  }

  function runMore(fn: () => void) {
    setMoreOpen(false);
    fn();
  }

  return (
    <>
      <div className="toolbar">
        <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="Chọn / di chuyển phần tử">
          <IconSelect />
          <span className="tb-txt">Chọn</span>
        </button>

        {/* Nút ghép: thân = dùng lại hình vừa chọn, mũi ▾ = mở danh sách hình */}
        <div className="tb-split" ref={shapesRef}>
          <button
            className={"tb-split-main" + (shapeActive ? " active" : "")}
            onClick={() => toggleTool(current.tool)}
            title={`${current.label} — bấm lại để tắt, bấm ▾ để đổi hình`}
          >
            <current.Icon />
            <span className="tb-txt">{current.label}</span>
          </button>
          <button
            className={"tb-split-caret" + (shapeActive ? " active" : "")}
            onClick={() => setShapesOpen((v) => !v)}
            aria-label="Chọn hình khác"
          >
            <IconCaret />
          </button>
          {shapesOpen && (
            <div className="tb-menu">
              {SHAPE_TOOLS.map((s) => (
                <button
                  key={s.tool}
                  className={tool === s.tool ? "active" : ""}
                  onClick={() => pickShape(s.tool)}
                >
                  <s.Icon />
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button className={tool === "arrow" ? "active" : ""} onClick={() => toggleTool("arrow")} title="Mũi tên — kéo để vẽ, bấm lại để tắt">
          <IconArrow />
          <span className="tb-txt">Mũi tên</span>
        </button>
        <button className={tool === "step" ? "active" : ""} onClick={() => toggleTool("step")} title="Bước — bấm liên tiếp để đặt ①②③…, bấm lại để tắt">
          <IconStep n={stepNext} />
          <span className="tb-txt">Bước</span>
        </button>
        <button className={tool === "note" ? "active" : ""} onClick={() => toggleTool("note")} title="Ghi chú — bấm để thêm chữ, bấm lại để tắt">
          <IconNote />
          <span className="tb-txt">Ghi chú</span>
        </button>
        <button className={tool === "highlight" ? "active" : ""} onClick={() => toggleTool("highlight")} title="Tô sáng — kéo ngang qua dòng chữ, bấm lại để tắt">
          <IconHighlight color={highlightColor} />
          <span className="tb-txt">Tô sáng</span>
        </button>

        {/* Cửa sổ hẹp: Che mờ và QR chuyển xuống menu ⋮ bên dưới, không mất đi đâu cả */}
        {!compact && (
          <button
            className={tool === "blur" ? "active" : ""}
            onClick={() => toggleTool("blur")}
            title="Che mờ vùng chứa thông tin riêng (email, số điện thoại, số tài khoản…) — bấm lại để tắt"
          >
            <IconBlur />
            <span className="tb-txt">Che mờ</span>
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={!canDelete}
          title="Xoá phần tử đang chọn (Delete) — kéo tô một vùng trống để chọn nhiều cái"
        >
          <IconTrash />
          <span className="tb-txt">{deleteCount > 1 ? `Xoá (${deleteCount})` : "Xoá"}</span>
        </button>
        {!compact && (
          <button onClick={onScanQr} title="Quét mã QR trong ảnh">
            <IconQr />
            <span className="tb-txt">QR</span>
          </button>
        )}

        {/* Menu việc lẻ: không phải công cụ vẽ nên không cần chỗ cố định trên hàng chính */}
        <div className="tb-split" ref={moreRef}>
          <button
            className={"tb-more" + (moreOpen || hiddenToolActive ? " active" : "")}
            onClick={() => setMoreOpen((v) => !v)}
            title="Thêm"
          >
            <IconMore />
            <span className="tb-txt">Thêm</span>
          </button>
          {moreOpen && (
            <div className="tb-menu tb-menu--wide">
              <button onClick={() => runMore(onUndo)} disabled={!canUndo}>
                <IconUndo />
                Hoàn tác
                <span className="tb-menu-key">Ctrl+Z</span>
              </button>
              <button onClick={() => runMore(onRedo)} disabled={!canRedo}>
                <IconRedo />
                Làm lại
                <span className="tb-menu-key">Ctrl+Y</span>
              </button>
              <div className="tb-menu-sep" />
              {compact && (
                <>
                  <button
                    className={tool === "blur" ? "active" : ""}
                    onClick={() => runMore(() => toggleTool("blur"))}
                  >
                    <IconBlur />
                    Che mờ
                  </button>
                  <button onClick={() => runMore(onScanQr)}>
                    <IconQr />
                    Quét mã QR
                  </button>
                </>
              )}
              <button
                className={tool === "measure" ? "active" : ""}
                onClick={() => runMore(() => toggleTool("measure"))}
              >
                <IconMeasure />
                Đo kích thước
              </button>
              <button
                className={tool === "eyedrop" ? "active" : ""}
                onClick={() => runMore(() => toggleTool("eyedrop"))}
              >
                <IconEyedrop />
                Hút màu
              </button>
            </div>
          )}
        </div>

        <span style={{ flex: 1 }} />
        <input
          className="title-input"
          type="text"
          placeholder="Tiêu đề (không bắt buộc)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button onClick={onBack} title="Quay lại (Esc)">← <span className="tb-txt">Quay lại</span></button>
        <button className="primary" onClick={onSave} disabled={saving}>
          {saving ? "Đang lưu…" : "💾 Lưu"}
        </button>
      </div>

      {/* Hiện cả khi đang ở công cụ Chọn mà bấm vào một thước — để xem lại số đã đo */}
      {(tool === "measure" || measureReadout) && (
        <div className="toolbar toolbar--sub">
          {measureReadout ? (
            <>
              <span className="tb-label">Rộng</span>
              <span className="tb-num">{measureReadout.w} px</span>
              <span className="tb-sep" />
              <span className="tb-label">Cao</span>
              <span className="tb-num">{measureReadout.h} px</span>
              <span className="tb-sep" />
              <span className="tb-label">Khoảng cách</span>
              <span className="tb-num">{measureReadout.dist} px</span>
              <span className="tb-sep" />
              <span className="tb-label">Toạ độ</span>
              <span className="tb-num">
                ({measureReadout.from.x}, {measureReadout.from.y}) → ({measureReadout.to.x}, {measureReadout.to.y})
              </span>
            </>
          ) : (
            <span className="tb-hint">Kéo từ A sang B để đo. Giữ <b>Shift</b> để khoá ngang/dọc. Số tính theo pixel ảnh gốc.</span>
          )}
        </div>
      )}

      {tool === "step" && (
        <div className="toolbar toolbar--sub">
          <span className="tb-label">Số tiếp theo</span>
          <span className="step-preview">{circled(stepNext)}</span>
          <input
            type="number"
            className="step-input"
            min={1}
            max={99}
            value={stepNext}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1 && n <= 99) setStepNext(n);
            }}
          />
          <button className="tb-mini" onClick={() => setStepNext(1)} disabled={stepNext === 1}>
            Đánh lại từ ①
          </button>
          <span className="tb-sep" />
          <label className="tb-check">
            <input
              type="checkbox"
              checked={stepWithText}
              onChange={(e) => setStepWithText(e.target.checked)}
            />
            Nhập chữ ngay khi đặt
          </label>
          <span className="tb-sep" />
          <span className="tb-hint">
            {stepWithText
              ? "Bấm lên ảnh → gõ nội dung → Ctrl+Enter, rồi bấm chỗ tiếp theo"
              : "Bấm liên tiếp để đặt ①②③… · bấm đúp vào mốc để thêm chữ"}
          </span>
        </div>
      )}

      {(tool === "pen" || tool === "ellipse" || tool === "line") && (
        <div className="toolbar toolbar--sub">
          <span className="tb-hint">
            {tool === "pen"
              ? "Kéo để vẽ tay, vẽ được nhiều nét liền nhau"
              : tool === "ellipse"
                ? "Kéo để vẽ hình tròn. Giữ Shift để tròn đều"
                : "Kéo để vẽ đường thẳng. Giữ Shift để khoá ngang/dọc"}
          </span>
        </div>
      )}

      {tool === "blur" && (
        <div className="toolbar toolbar--sub">
          <span className="tb-label">Độ mờ</span>
          <input
            type="range"
            className="hl-range"
            min={BLUR_MIN}
            max={BLUR_MAX}
            step={2}
            value={blurStrength}
            onChange={(e) => setBlurStrength(Number(e.target.value))}
          />
          <span className="tb-value">{blurStrength}</span>
          <span className="tb-sep" />
          <span className="tb-hint">
            Kéo một vùng để che. Che nhiều chỗ liên tiếp được — ảnh chia sẻ sẽ mất hẳn pixel gốc ở vùng này.
          </span>
        </div>
      )}

      {tool === "eyedrop" && (
        <div className="toolbar toolbar--sub">
          {pickedColor ? (
            <>
              <span className="tb-label">Màu vừa hút</span>
              <span className="hl-swatch hl-swatch--lg" style={{ background: pickedColor }} />
              <span className="tb-num">{pickedColor.toUpperCase()}</span>
              <span className="tb-sep" />
              <span className="tb-hint">Đã copy vào clipboard · bấm chỗ khác để hút tiếp</span>
            </>
          ) : (
            <span className="tb-hint">Bấm vào ảnh để lấy mã màu của pixel đó (đọc từ ảnh gốc, không tính chú thích vẽ đè)</span>
          )}
        </div>
      )}

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
