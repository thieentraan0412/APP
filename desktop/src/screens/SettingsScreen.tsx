import { useEffect, useState } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

interface Props {
  capture: string;
  record: string;
  region: string;
  pause: string;
  regionRecord: string;
  /** Lưu ngay khi đổi. Trả về false nếu không lưu được → ô phím quay lại giá trị cũ. */
  onSave: (capture: string, record: string, region: string, pause: string, regionRecord: string) => Promise<boolean>;
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
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const [listening, setListening] = useState(false);
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <button
        className={"shortcut-key" + (listening ? " active" : "")}
        disabled={disabled}
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

interface Keys {
  capture: string;
  record: string;
  region: string;
  pause: string;
  regionRecord: string;
}

const KEY_LABELS: Record<keyof Keys, string> = {
  capture: "Chụp ảnh",
  region: "Chụp vùng màn hình",
  record: "Quay / dừng video",
  regionRecord: "Quay vùng màn hình",
  pause: "Tạm dừng / quay tiếp",
};

const DEFAULT_KEYS: Keys = {
  capture: "Control+Shift+1",
  region: "Control+Shift+3",
  record: "Control+Shift+2",
  pause: "Control+Shift+H",
  regionRecord: "Control+Shift+4",
};

export function SettingsScreen({ capture, record, region, pause, regionRecord, onSave, onBack, onCheckUpdate, updateChecking, userEmail, onLogout }: Props) {
  const [keys, setKeys] = useState<Keys>({ capture, record, region, pause, regionRecord });
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // Lưu ngay, không đợi bấm nút. Hiện giá trị mới trước cho khỏi khựng, nhưng nếu lưu hỏng
  // thì trả ô về giá trị cũ — ô phím không được hiển thị thứ chưa thực sự có hiệu lực.
  async function apply(next: Keys) {
    const prev = keys;
    setKeys(next);
    setSaving(true);
    try {
      const ok = await onSave(next.capture, next.record, next.region, next.pause, next.regionRecord);
      if (!ok) setKeys(prev);
    } finally {
      setSaving(false);
    }
  }

  function change(field: keyof Keys, value: string) {
    if (keys[field] === value) return; // nhấn lại đúng phím cũ → khỏi lưu
    const next = { ...keys, [field]: value };
    // Phím vừa nhấn đang thuộc hành động khác → HOÁN ĐỔI hai bên. Nếu chỉ báo trùng rồi
    // từ chối, người dùng không thể tráo phím giữa hai hành động: bước nào cũng vướng
    // trùng, muốn tráo phải mượn tạm một phím thứ ba.
    const clash = (Object.keys(keys) as (keyof Keys)[]).find((k) => k !== field && keys[k] === value);
    if (clash) {
      next[clash] = keys[field];
      setHint(`Đã hoán đổi với “${KEY_LABELS[clash]}”`);
    } else {
      setHint(null);
    }
    apply(next);
  }

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
                Đổi xong là lưu ngay, không cần bấm nút nào.
              </p>
            </div>
          </div>
          <div className="settings-card-body">
            <ShortcutCapture label={KEY_LABELS.capture} value={keys.capture} disabled={saving} onChange={(v) => change("capture", v)} />
            <ShortcutCapture label={KEY_LABELS.region} value={keys.region} disabled={saving} onChange={(v) => change("region", v)} />
            <ShortcutCapture label={KEY_LABELS.record} value={keys.record} disabled={saving} onChange={(v) => change("record", v)} />
            <ShortcutCapture label={KEY_LABELS.regionRecord} value={keys.regionRecord} disabled={saving} onChange={(v) => change("regionRecord", v)} />
            <ShortcutCapture label={KEY_LABELS.pause} value={keys.pause} disabled={saving} onChange={(v) => change("pause", v)} />
          </div>
          <div className="settings-card-footer">
            <button disabled={saving} onClick={() => { setHint(null); apply(DEFAULT_KEYS); }}>
              Khôi phục mặc định
            </button>
            {hint && <span className="settings-hint">{hint}</span>}
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
