import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export function RegionSelector() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x0: number; y0: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawDim();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") invoke("cancel_region_capture").catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function drawDim(rect?: { x: number; y: number; w: number; h: number }) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const cw = canvas.width;
    const ch = canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    // Chỉ dim khi đang kéo chọn vùng
    if (!rect || rect.w < 1 || rect.h < 1) return;

    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, cw, ch);

    // Vùng chọn sáng lên
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);

    // Viền xanh
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

    // Tooltip kích thước
    const dpr = window.devicePixelRatio ?? 1;
    const label = `${Math.round(rect.w * dpr)} × ${Math.round(rect.h * dpr)}`;
    const tipX = rect.x + 4;
    const tipY = rect.y > 24 ? rect.y - 8 : rect.y + rect.h + 18;
    ctx.font = "bold 12px system-ui";
    ctx.fillStyle = "#3b82f6";
    ctx.fillText(label, tipX, tipY);
  }

  function onMouseDown(e: React.MouseEvent) {
    drag.current = { x0: e.clientX, y0: e.clientY };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!drag.current) return;
    const { x0, y0 } = drag.current;
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
    const x = Math.round(Math.min(x0, e.clientX) * dpr);
    const y = Math.round(Math.min(y0, e.clientY) * dpr);
    const w = Math.round(Math.abs(e.clientX - x0) * dpr);
    const h = Math.round(Math.abs(e.clientY - y0) * dpr);

    if (w < 10 || h < 10) {
      await invoke("cancel_region_capture");
      return;
    }
    await invoke("confirm_region_capture", { x, y, w, h });
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: "block",
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        cursor: "crosshair",
        userSelect: "none",
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    />
  );
}
