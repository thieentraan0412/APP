import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

// Khung viền báo "đang quay vùng này". Cửa sổ được Rust đặt to hơn vùng quay vài pixel ở
// mọi phía, nên nét viền nằm NGOÀI vùng ffmpeg cắt → không lọt vào video. Ruột cửa sổ để
// trong suốt hoàn toàn và click xuyên qua (Rust bật ignore_cursor_events).
export function RecBorder() {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const subs = [
      listen("recording-started", () => setPaused(false)),
      listen("recording-resumed", () => setPaused(false)),
      listen("recording-paused", () => setPaused(true)),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Viền vẽ sát mép NGOÀI cửa sổ (border-box) — chỗ xa vùng quay nhất.
        border: `2px solid ${paused ? "#f59e0b" : "#ef4444"}`,
        boxSizing: "border-box",
        background: "transparent",
        pointerEvents: "none",
        userSelect: "none",
      }}
    />
  );
}
