export function RecNotify() {
  return (
    <div style={{
      position: "fixed", inset: 0, margin: 0, padding: 0,
      display: "flex", alignItems: "center",
      background: "transparent",
      userSelect: "none",
    }}>
      <div style={{
        width: "100%",
        background: "rgba(15,15,15,0.92)",
        color: "#fff",
        borderRadius: 10,
        padding: "0 16px",
        height: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        boxSizing: "border-box",
      }}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%",
          background: "#ef4444",
          flexShrink: 0,
          animation: "recpulse 1s ease-in-out infinite",
        }}/>
        Đang quay màn hình…
      </div>
      <style>{`
        @keyframes recpulse {
          0%,100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
