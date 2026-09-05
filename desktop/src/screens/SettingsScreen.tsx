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
  /** Chiều cao tối đa (px) của ảnh chụp và của video quay — hai mức tách riêng. */
  imageQuality: number;
  videoQuality: number;
  /** Cũng lưu ngay khi đổi; false = không lưu được → nút quay lại mức cũ. */
  onSaveQuality: (image: number, video: number) => Promise<boolean>;
  /** [rộng, cao] màn hình chính (nguồn ảnh chụp) rồi [rộng, cao] cả virtual desktop
   *  (nguồn video toàn màn hình), px vật lý. null = chưa đọc được. */
  captureSizes: [number, number, number, number] | null;
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
const QualityIcon = (
  <svg {...IconS}><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /><path d="M7 13V9l3 4V9" /></svg>
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

// Bốn mức chất lượng, tính theo CHIỀU CAO tối đa. Chỉ thu nhỏ khi màn hình / ảnh lớn hơn mức
// chọn, không bao giờ phóng to. Ngoài kích thước, mức còn quyết định CÁCH NÉN — và hai loại
// nén khác hẳn nhau nên hint tách riêng: ảnh từ 2K trở lên là lossless (lib/flatten.ts), còn
// video luôn nén mất dữ liệu, chỉ nén nhẹ dần theo mức (crf_for trong record.rs).
type QualityKind = "image" | "video";
const QUALITY_OPTIONS: { value: number; label: string; hint: Record<QualityKind, string> }[] = [
  {
    value: 720, label: "720p",
    hint: { image: "Cao tối đa 720px — file nhẹ nhất, gửi đi nhanh", video: "Cao tối đa 720px, nén mạnh — file nhẹ nhất, gửi đi nhanh" },
  },
  {
    value: 1080, label: "Full HD",
    hint: { image: "Cao tối đa 1080px — cân bằng giữa nét và nhẹ", video: "Cao tối đa 1080px, nén vừa — cân bằng giữa nét và nhẹ" },
  },
  {
    value: 1440, label: "2K",
    hint: { image: "Cao tối đa 1440px — không nén mất dữ liệu, nét tuyệt đối", video: "Cao tối đa 1440px, nén nhẹ nhất — nét nhất, file nặng hơn ~2,5 lần mức 720p" },
  },
  {
    // Cao hơn mọi màn hình phổ thông → thực chất là "giữ nguyên, không thu nhỏ gì cả".
    value: 2160, label: "4K",
    hint: { image: "Giữ nguyên đúng từng pixel của màn hình, không thu nhỏ — nét nhất có thể", video: "Cao tối đa 2160px — chỉ hợp màn 4K, file rất nặng và mã hoá lâu hơn nhiều" },
  },
];

// Kết quả thật của một mức trên nguồn cụ thể. Đây là phần quan trọng nhất của cả thẻ này:
// trên màn 1080p, "Full HD", "2K" và "4K" cho ra ảnh CÙNG CỠ (đều 1920×1080, vì không bao
// giờ phóng to) — thấy mấy con số bằng nhau thì người dùng hiểu ngay là màn hình mình
// không đủ pixel, còn nếu chỉ có nhãn thì họ tưởng chọn 4K sẽ nét hơn. Khác biệt còn lại
// giữa các mức là cách nén: từ 2K trở lên không nén mất dữ liệu (xem webpQuality trong
// lib/flatten.ts), nên cùng cỡ mà vẫn nét hơn.
function outSize(src: [number, number] | null, maxH: number): string | null {
  if (!src) return null;
  const [w, h] = src;
  if (w <= 0 || h <= 0) return null;
  if (h <= maxH) return `${w}×${h}`;
  return `${Math.round((w * maxH) / h)}×${maxH}`;
}

function QualityPicker({
  label,
  value,
  source,
  disabled,
  onChange,
  kind = "image",
}: {
  label: string;
  value: number;
  /** Ảnh hay video — chọn bộ hint cho đúng cách nén của loại đó. */
  kind?: QualityKind;
  /** Nguồn để tính ra kích thước thật hiện dưới mỗi nút; null thì chỉ hiện nhãn. */
  source: [number, number] | null;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {QUALITY_OPTIONS.map((o) => {
          const out = outSize(source, o.value);
          return (
            <button
              key={o.value}
              type="button"
              className={"segmented-btn" + (value === o.value ? " active" : "")}
              disabled={disabled}
              title={o.hint[kind]}
              aria-pressed={value === o.value}
              onClick={() => onChange(o.value)}
            >
              <span className="segmented-main">{o.label}</span>
              {out && <span className="segmented-sub">{out}</span>}
            </button>
          );
        })}
      </div>
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
  regionRecord: "Quay / dừng vùng màn hình",
  pause: "Tạm dừng / quay tiếp",
};

const DEFAULT_KEYS: Keys = {
  capture: "Control+Shift+1",
  region: "Control+Shift+3",
  record: "Control+Shift+2",
  pause: "Control+Shift+H",
  regionRecord: "Control+Shift+4",
};

export function SettingsScreen({ capture, record, region, pause, regionRecord, onSave, imageQuality, videoQuality, onSaveQuality, captureSizes, onBack, onCheckUpdate, updateChecking, userEmail, onLogout }: Props) {
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

  // Chất lượng ảnh / video. Cùng cách làm với phím tắt: hiện mức mới ngay cho khỏi khựng,
  // lưu hỏng thì trả về mức cũ.
  const [qual, setQual] = useState({ image: imageQuality, video: videoQuality });
  const [qualSaving, setQualSaving] = useState(false);

  // Mức thật do Rust trả về đến sau một nhịp IPC. Không đồng bộ lại thì mở Cài đặt sớm sẽ
  // thấy nút sáng ở mức MẶC ĐỊNH chứ không phải mức đang dùng — người dùng bấm đúng mức
  // họ muốn, hàm change() thấy "trùng giá trị cũ" nên bỏ qua, và không có gì được lưu.
  useEffect(() => {
    if (!qualSaving) setQual({ image: imageQuality, video: videoQuality });
  }, [imageQuality, videoQuality]);

  async function changeQuality(field: "image" | "video", value: number) {
    if (qual[field] === value) return;
    const prev = qual;
    const next = { ...qual, [field]: value };
    setQual(next);
    setQualSaving(true);
    try {
      const ok = await onSaveQuality(next.image, next.video);
      if (!ok) setQual(prev);
    } finally {
      setQualSaving(false);
    }
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

        {/* Chất lượng ảnh & video */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div className="settings-card-icon">{QualityIcon}</div>
            <div className="settings-card-heading">
              <h3 className="settings-card-title">Chất lượng ảnh & video</h3>
              <p className="settings-card-desc">
                Giới hạn độ phân giải theo chiều cao. Ảnh hoặc màn hình nhỏ hơn mức chọn thì
                giữ nguyên, không bị phóng to. Mức càng thấp thì file càng nhẹ và gửi càng nhanh.
              </p>
            </div>
          </div>
          <div className="settings-card-body">
            <QualityPicker
              kind="image"
              label="Chất lượng ảnh chụp"
              value={qual.image}
              source={captureSizes ? [captureSizes[0], captureSizes[1]] : null}
              disabled={qualSaving}
              onChange={(v) => changeQuality("image", v)}
            />
            <QualityPicker
              kind="video"
              label="Chất lượng video quay"
              value={qual.video}
              source={captureSizes ? [captureSizes[2], captureSizes[3]] : null}
              disabled={qualSaving}
              onChange={(v) => changeQuality("video", v)}
            />
          </div>
          <div className="settings-card-footer">
            <span className="settings-hint">
              Số dưới mỗi mức là kích thước thật sẽ nhận được. Nhiều mức ra cùng một số nghĩa là
              màn hình của bạn thấp hơn tất cả các mức đó — chọn mức cao hơn KHÔNG thêm được pixel
              nào, vì ảnh không bao giờ bị phóng to. Cùng cỡ thì chỉ còn khác cách nén: ảnh chụp từ
              mức 2K trở lên không nén mất dữ liệu, video ở mức cao hơn nén nhẹ hơn.
              Mức mới áp dụng cho lần chụp / quay tiếp theo; phiên quay đang chạy vẫn giữ mức cũ.
            </span>
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
