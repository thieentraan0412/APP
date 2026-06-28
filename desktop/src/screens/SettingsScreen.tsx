import { useState } from "react";

interface Props {
  capture: string;
  record: string;
  onSave: (capture: string, record: string) => void;
  onBack: () => void;
}

// Lấy tên phím từ event (dùng e.code để không lệ thuộc Shift, vd Shift+1)
function keyName(code: string, key: string): string | null {
  if (code.startsWith("Key")) return code.slice(3); // KeyA -> A
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 -> 1
  if (/^F\d{1,2}$/.test(code)) return code; // F1..F12
  if (code === "Space") return "Space";
  const modifiers = [
    "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
    "AltLeft", "AltRight", "MetaLeft", "MetaRight",
  ];
  if (modifiers.includes(code)) return null;
  return key.length === 1 ? key.toUpperCase() : null;
}

function comboFromEvent(e: React.KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Super");
  const k = keyName(e.code, e.key);
  if (!k || mods.length === 0) return null; // cần ít nhất 1 modifier + 1 phím
  return [...mods, k].join("+");
}

function pretty(s: string): string {
  return s.replace("Control", "Ctrl").replace("Super", "Win").split("+").join(" + ");
}

function ShortcutCapture({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [listening, setListening] = useState(false);
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <button
        className={"shortcut-key" + (listening ? " active" : "")}
        onClick={() => setListening(true)}
        onBlur={() => setListening(false)}
        onKeyDown={(e) => {
          if (!listening) return;
          e.preventDefault();
          const combo = comboFromEvent(e);
          if (combo) {
            onChange(combo);
            setListening(false);
          }
        }}
      >
        {listening ? "Nhấn tổ hợp phím…" : pretty(value)}
      </button>
    </div>
  );
}

export function SettingsScreen({ capture, record, onSave, onBack }: Props) {
  const [cap, setCap] = useState(capture);
  const [rec, setRec] = useState(record);

  return (
    <main className="container">
      <div className="topbar">
        <h2 style={{ margin: 0, flex: 1 }}>Cài đặt</h2>
        <button onClick={onBack}>← Trang chính</button>
      </div>

      <div className="settings">
        <h3>Phím tắt toàn cục</h3>
        <ShortcutCapture label="Chụp ảnh" value={cap} onChange={setCap} />
        <ShortcutCapture label="Quay / dừng video" value={rec} onChange={setRec} />
        <p className="hint">
          Bấm vào ô bên phải rồi nhấn tổ hợp phím mới (cần ít nhất một phím Ctrl / Shift / Alt).
        </p>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="primary" onClick={() => onSave(cap, rec)}>
            Lưu phím tắt
          </button>
          <button
            onClick={() => {
              setCap("Control+Shift+1");
              setRec("Control+Shift+2");
            }}
          >
            Khôi phục mặc định
          </button>
        </div>
      </div>
    </main>
  );
}
