import { useEffect, useState } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

interface Props {
  capture: string;
  record: string;
  region: string;
  pause: string;
  regionRecord: string;
  onSave: (capture: string, record: string, region: string, pause: string, regionRecord: string) => void;
  onBack: () => void;
  onCheckUpdate: () => void;
  updateChecking: boolean;
  userEmail: string;
  onLogout: () => void;
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

// Icon props chung (nét mảnh, dùng currentColor như sidebar)
const IconS = {
  width: 20, height: 20, viewBox: "0 0 24 24", fill: "none" as const,
  stroke: "currentColor", strokeWidth: 2,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};
const KeyboardIcon = (
  <svg {...IconS}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>
);
const UpdateIcon = (
  <svg {...IconS}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v5h-5" /></svg>
);
const UserIcon = (
  <svg {...IconS}><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 4-6.5 8-6.5s8 2.5 8 6.5" /></svg>
);
const PowerIcon = (
  <svg {...IconS}><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" /></svg>
);

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

export function SettingsScreen({ capture, record, region, pause, regionRecord, onSave, onBack, onCheckUpdate, updateChecking, userEmail, onLogout }: Props) {
  const [cap, setCap] = useState(capture);
  const [rec, setRec] = useState(record);
  const [reg, setReg] = useState(region);
  const [pau, setPau] = useState(pause);
  const [recReg, setRecReg] = useState(regionRecord);

  // Tự khởi động cùng máy — đọc trạng thái thật từ hệ điều hành khi mở Cài đặt.
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(true);

  useEffect(() => {
    isEnabled()
      .then(setAutostart)
      .catch(() => {})
      .finally(() => setAutostartBusy(false));
  }, []);

  async function toggleAutostart(next: boolean) {
    setAutostartBusy(true);
    try {
      if (next) await enable();
      else await disable();
      // Đọc lại từ OS để chắc chắn khớp trạng thái thực tế
      setAutostart(await isEnabled());
    } catch {
      // Lỗi (hiếm) → giữ nguyên trạng thái cũ
    } finally {
      setAutostartBusy(false);
    }
  }

  const initial = userEmail.trim().charAt(0) || "?";

  return (
    <main className="container settings-page">
      <div className="settings-shell">
        <header className="settings-header">
          <div>
            <h2>Cài đặt</h2>
            <p className="settings-subtitle">Tuỳ chỉnh phím tắt, cập nhật và tài khoản</p>
          </div>
          <button className="settings-back" onClick={onBack}>← Trang chính</button>
        </header>

        {/* Phím tắt toàn cục */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div className="settings-card-icon">{KeyboardIcon}</div>
            <div className="settings-card-heading">
              <h3 className="settings-card-title">Phím tắt toàn cục</h3>
              <p className="settings-card-desc">
                Bấm vào ô bên phải rồi nhấn tổ hợp phím mới (cần ít nhất một phím Ctrl / Shift / Alt).
              </p>
            </div>
          </div>
          <div className="settings-card-body">
            <ShortcutCapture label="Chụp ảnh" value={cap} onChange={setCap} />
            <ShortcutCapture label="Chụp vùng màn hình" value={reg} onChange={setReg} />
            <ShortcutCapture label="Quay / dừng video" value={rec} onChange={setRec} />
            <ShortcutCapture label="Quay vùng màn hình" value={recReg} onChange={setRecReg} />
            <ShortcutCapture label="Tạm dừng / quay tiếp" value={pau} onChange={setPau} />
          </div>
          <div className="settings-card-footer">
            <button className="primary" onClick={() => onSave(cap, rec, reg, pau, recReg)}>
              Lưu phím tắt
            </button>
            <button
              onClick={() => {
                setCap("Control+Shift+1");
                setReg("Control+Shift+3");
                setRec("Control+Shift+2");
                setPau("Control+Shift+H");
                setRecReg("Control+Shift+4");
              }}
            >
              Khôi phục mặc định
            </button>
          </div>
        </section>

        {/* Khởi động cùng máy */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div className="settings-card-icon">{PowerIcon}</div>
            <div className="settings-card-heading">
              <h3 className="settings-card-title">Khởi động cùng máy</h3>
              <p className="settings-card-desc">
                Tự động mở app (ẩn sẵn dưới khay hệ thống) mỗi khi bật Windows.
              </p>
            </div>
          </div>
          <div className="settings-card-body">
            <div className="setting-row">
              <span className="setting-label">Bật tự khởi động</span>
              <label className="switch" title={autostart ? "Đang bật" : "Đang tắt"}>
                <input
                  type="checkbox"
                  checked={autostart}
                  disabled={autostartBusy}
                  onChange={(e) => toggleAutostart(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>
          </div>
        </section>

        {/* Cập nhật ứng dụng */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div className="settings-card-icon">{UpdateIcon}</div>
            <div className="settings-card-heading">
              <h3 className="settings-card-title">Cập nhật ứng dụng</h3>
              <p className="settings-card-desc">Kiểm tra và cài phiên bản mới nhất.</p>
            </div>
          </div>
          <div className="settings-card-actions">
            <button onClick={onCheckUpdate} disabled={updateChecking}>
              {updateChecking ? "Đang kiểm tra…" : "Kiểm tra cập nhật"}
            </button>
          </div>
        </section>

        {/* Tài khoản */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div className="settings-card-icon">{UserIcon}</div>
            <div className="settings-card-heading">
              <h3 className="settings-card-title">Tài khoản</h3>
              <p className="settings-card-desc">Quản lý phiên đăng nhập trên thiết bị này.</p>
            </div>
          </div>
          <div className="account-row">
            <div className="account-avatar">{initial}</div>
            <div className="account-info">
              <span className="account-email">{userEmail}</span>
              <span className="account-status"><span className="dot" /> Đang đăng nhập</span>
            </div>
            <button className="btn-danger" onClick={onLogout}>Đăng xuất</button>
          </div>
        </section>
      </div>
    </main>
  );
}
