import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Lớp phủ chọn vùng, dùng chung cho HAI việc:
// - "capture": kéo xong là cắt ảnh ngay (hành vi cũ).
// - "record":  kéo xong hiện thanh xác nhận → đếm ngược → Rust ẩn lớp phủ rồi quay video.
// Chế độ do Rust quyết định (RegionState.record); overlay hỏi lại mỗi lần được mở.

type Rect = { x: number; y: number; w: number; h: number };
type Mode = "capture" | "record";

const MIN_CAPTURE_PX = 10; // px vật lý
// Vùng quay quá nhỏ cho ra video vô dụng và dễ làm libx264 chết → chặn từ đầu.
const MIN_RECORD_PX = 64;
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 800;

// libx264 + yuv420p bắt buộc cạnh chẵn; ffmpeg cũng làm tròn xuống chẵn khi cắt,
// nên nhãn kích thước phải hiện đúng con số cuối cùng người dùng sẽ nhận được.
function evenDown(v: number): number {
  return Math.max(0, Math.floor(v / 2) * 2);
}

export function RegionSelector() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x0: number; y0: number } | null>(null);
  // Đã gửi lệnh quay chưa — chặn hẹn giờ còn sót gửi lệnh lần hai.
  const fired = useRef(false);
  const [mode, setMode] = useState<Mode>("capture");
  // Vùng đã chốt, đang chờ xác nhận (chỉ dùng ở chế độ quay).
  const [rect, setRect] = useState<Rect | null>(null);
  const [count, setCount] = useState<number | null>(null);

  // Gắn MỘT LẦN: cửa sổ overlay được dùng lại (ẩn/hiện) chứ không tạo mới, nên canvas
  // vẫn giữ vùng kéo của lần trước — mỗi lần overlay được focus lại phải xoá sạch.
  useEffect(() => {
    if (!canvasRef.current) return;
    resetAll();
    const unlistenP = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) resetAll();
    });
    return () => {
      unlistenP.then((un) => un());
    };
  }, []);

  // Gắn lại khi mode/rect/count đổi vì phím tắt cần đọc giá trị mới nhất của chúng.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      // Enter = xác nhận nhanh vùng vừa chọn.
      if (e.key === "Enter" && mode === "record" && rect && count === null) beginCountdown();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, rect, count]);

  // Vẽ lại mỗi khi vùng đã chốt hoặc số đếm ngược thay đổi.
  useEffect(() => {
    drawDim(rect ?? undefined, count ?? undefined);
  }, [rect, count]);

  // Đếm ngược 3 → 2 → 1 rồi mới gửi lệnh quay.
  useEffect(() => {
    if (count === null) return;
    if (count > 0) {
      const t = setTimeout(() => setCount(count - 1), COUNTDOWN_STEP_MS);
      return () => clearTimeout(t);
    }
    if (fired.current || !rect) return;
    fired.current = true;
    // Gửi theo TỈ LỆ so với màn hình chứa overlay (không phải pixel): Rust quy đổi tiếp
    // sang tỉ lệ trên toàn bộ virtual desktop, và ffmpeg cắt theo tỉ lệ đó. Nhờ vậy
    // không phụ thuộc mức phóng to (DPI) của Windows.
    invoke("confirm_region_record", {
      fx: rect.x / window.innerWidth,
      fy: rect.y / window.innerHeight,
      fw: rect.w / window.innerWidth,
      fh: rect.h / window.innerHeight,
    }).catch(() => {});
  }, [count, rect]);

  function resetAll() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drag.current = null;
    fired.current = false;
    setRect(null);
    setCount(null);
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawDim(); // canvas trống → không còn viền/nhãn cũ
    invoke<string>("region_mode")
      .then((m) => setMode(m === "record" ? "record" : "capture"))
      .catch(() => {});
  }

  function cancel() {
    fired.current = true; // chặn hẹn giờ đếm ngược còn sót vẫn gửi lệnh quay
    setRect(null);
    setCount(null);
    invoke("cancel_region_capture").catch(() => {});
  }

  function beginCountdown() {
    if (!rect) return;
    fired.current = false;
    setCount(COUNTDOWN_FROM);
  }

  function drawDim(rect?: Rect, countdown?: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const cw = canvas.width;
    const ch = canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    // Chỉ dim khi đã có vùng chọn
    if (!rect || rect.w < 1 || rect.h < 1) return;

    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, cw, ch);

    // Vùng chọn sáng lên
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);

    // Viền: xanh khi chọn ảnh, đỏ khi chọn vùng quay (báo rõ đây là vùng sẽ vào video).
    const accent = mode === "record" ? "#ef4444" : "#3b82f6";
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

    // Tooltip kích thước
    const dpr = window.devicePixelRatio ?? 1;
    const label =
      mode === "record"
        ? `${evenDown(rect.w * dpr)} × ${evenDown(rect.h * dpr)}`
        : `${Math.round(rect.w * dpr)} × ${Math.round(rect.h * dpr)}`;
    const tipX = rect.x + 4;
    const tipY = rect.y > 24 ? rect.y - 8 : rect.y + rect.h + 18;
    ctx.font = "bold 12px system-ui";
    ctx.fillStyle = accent;
    ctx.fillText(label, tipX, tipY);

    // Số đếm ngược, vẽ to giữa vùng chọn.
    if (countdown && countdown > 0) {
      const size = Math.max(48, Math.min(rect.w, rect.h) * 0.6);
      ctx.font = `bold ${size}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      ctx.lineWidth = Math.max(3, size / 16);
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeText(String(countdown), cx, cy);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(countdown), cx, cy);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
  }

  function onMouseDown(e: React.MouseEvent) {
    if (count !== null) return; // đang đếm ngược → khoá thao tác
    setRect(null);
    drag.current = { x0: e.clientX, y0: e.clientY };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!drag.current) return;
    const { x0, y0 } = drag.current;
    // Vẽ thẳng lên canvas khi đang kéo (không qua state) để không giật.
    drawDim({
      x: Math.min(x0, e.clientX),
      y: Math.min(y0, e.clientY),
      w: Math.abs(e.clientX - x0),
      h: Math.abs(e.clientY - y0),
    });
  }

  async function onMouseUp(e: React.MouseEvent) {
    if (!drag.current) return;
    const { x0, y0 } = drag.current;
    drag.current = null;

    const dpr = window.devicePixelRatio ?? 1;
    const cssRect: Rect = {
      x: Math.min(x0, e.clientX),
      y: Math.min(y0, e.clientY),
      w: Math.abs(e.clientX - x0),
      h: Math.abs(e.clientY - y0),
    };

    if (mode === "record") {
      // Quá nhỏ → coi như kéo nhầm, xoá vùng và cho chọn lại (KHÔNG đóng overlay,
      // vì đóng luôn sẽ bắt người dùng mở lại từ đầu chỉ vì lỡ tay click).
      if (evenDown(cssRect.w * dpr) < MIN_RECORD_PX || evenDown(cssRect.h * dpr) < MIN_RECORD_PX) {
        setRect(null);
        drawDim();
        return;
      }
      setRect(cssRect);
      return;
    }

    const x = Math.round(cssRect.x * dpr);
    const y = Math.round(cssRect.y * dpr);
    const w = Math.round(cssRect.w * dpr);
    const h = Math.round(cssRect.h * dpr);

    if (w < MIN_CAPTURE_PX || h < MIN_CAPTURE_PX) {
      await invoke("cancel_region_capture").catch(() => {});
      return;
    }
    // Lỗi crop được Rust báo về main qua "capture-error" (H3) → chỉ cần nuốt rejection ở đây.
    await invoke("confirm_region_capture", { x, y, w, h }).catch(() => {});
  }

  // Thanh xác nhận đặt NGOÀI vùng chọn (dưới, hoặc trên nếu hết chỗ) để không che nội dung.
  const showBar = mode === "record" && rect !== null && count === null;
  const BAR_H = 44;
  let barTop = 0;
  if (rect) {
    barTop =
      rect.y + rect.h + 10 + BAR_H <= window.innerHeight
        ? rect.y + rect.h + 10
        : Math.max(10, rect.y - BAR_H - 10);
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          cursor: count === null ? "crosshair" : "default",
          userSelect: "none",
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />

      {mode === "record" && rect === null && count === null && (
        <div style={hintStyle}>Kéo chuột để chọn vùng quay · <b>Esc</b> để huỷ</div>
      )}

      {showBar && rect && (
        <div
          style={{
            position: "fixed",
            top: barTop,
            left: Math.max(10, Math.min(rect.x, window.innerWidth - 330)),
            display: "flex",
            gap: 8,
            padding: 6,
            borderRadius: 10,
            background: "rgba(24,24,27,0.95)",
            boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
            userSelect: "none",
          }}
        >
          <button style={{ ...btnStyle, background: "#ef4444", color: "#fff" }} onClick={beginCountdown}>
            ● Bắt đầu quay
          </button>
          <button style={btnStyle} onClick={() => setRect(null)}>
            ↺ Chọn lại
          </button>
          <button style={btnStyle} onClick={cancel}>
            ✕ Huỷ (Esc)
          </button>
        </div>
      )}
    </>
  );
}

const btnStyle: React.CSSProperties = {
  border: "none",
  borderRadius: 7,
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  background: "rgba(255,255,255,0.12)",
  color: "#f4f4f5",
  whiteSpace: "nowrap",
};

const hintStyle: React.CSSProperties = {
  position: "fixed",
  top: 24,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "8px 16px",
  borderRadius: 999,
  background: "rgba(24,24,27,0.9)",
  color: "#f4f4f5",
  fontSize: 13,
  fontFamily: "system-ui",
  pointerEvents: "none",
  userSelect: "none",
};
