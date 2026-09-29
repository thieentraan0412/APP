import { useEffect, useState } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { webpQuality } from "../lib/flatten";

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
  /** Phiên bản app đang chạy; null = chưa đọc được (khi đó không hiện gì). */
  appVersion: string | null;
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
// Bốn mức = CHIỀU CAO ĐÍCH của file, theo quy ước 16:9: 720p = 1280×720, Full HD = 1920×1080,
// 2K/QHD = 2560×1440, 4K/UHD = 3840×2160. Thấp hơn màn hình → thu nhỏ; bằng → Native; cao hơn
// → UPSCALE thật. Trước đây mức chỉ là TRẦN chiều cao, nên trên màn 1080p nút "2K"/"4K" vẫn ghi
// 1920×1080 — nhãn nói một đằng, file ra một nẻo.
const QUALITY_OPTIONS: { value: number; label: string; std: string }[] = [
  { value: 720, label: "720p", std: "720p (HD) 1280×720" },
  { value: 1080, label: "Full HD", std: "Full HD 1920×1080" },
  { value: 1440, label: "2K", std: "2K / QHD 2560×1440" },
  { value: 2160, label: "4K", std: "4K / UHD 3840×2160" },
];

// Chiều ngang tối đa khi upscale video — khớp VIDEO_UPSCALE_MAX_W ở record.rs.
const VIDEO_MAX_W = 4096;

type TierMode = "down" | "native" | "up" | "blocked";
type TierOut = { w: number; h: number; mode: TierMode };
const TIER_TAG: Record<Exclude<TierMode, "down">, string> = { native: "Native", up: "Upscale", blocked: "Không hỗ trợ" };

// Kích thước file THẬT của một mức trên nguồn cụ thể — tính y hệt phía Rust (tier_size ở
// capture.rs cho ảnh, bộ lọc scale trong spawn_segment ở record.rs cho video; sửa thì sửa cả
// hai) để con số trên nút đúng là file sẽ nhận. Video upscale ra rộng quá VIDEO_MAX_W thì
// "blocked": Rust không upscale mà quay native, nên nút phải khoá chứ không được hứa suông.
function tierOutput(src: [number, number] | null, tier: number, kind: QualityKind): TierOut | null {
  if (!src) return null;
  const [sw, sh] = src;
  if (sw <= 0 || sh <= 0) return null;
  const even = (v: number) => Math.trunc(v / 2) * 2;
  if (tier > sh) {
    if (kind === "video") {
      const w = even((sw * tier) / sh);
      const h = even((sh * tier) / sh);
      return { w, h, mode: w > VIDEO_MAX_W ? "blocked" : "up" };
    }
    const up = (v: number) => Math.max(1, Math.floor((v * tier + Math.floor(sh / 2)) / sh));
    return { w: up(sw), h: up(sh), mode: "up" };
  }
  if (tier === sh) {
    return kind === "video" ? { w: even(sw), h: even(sh), mode: "native" } : { w: sw, h: sh, mode: "native" };
  }
  // Thu nhỏ: cao đúng `tier`, rộng theo tỉ lệ (video: ffmpeg "-2" làm tròn về số chẵn).
  const w = (sw * tier) / sh;
  return { w: kind === "video" ? 2 * Math.round(w / 2) : Math.round(w), h: tier, mode: "down" };
}

// Cách nén của mức đó — lấy thẳng từ nơi quyết định thật (webpQuality cho ảnh, crf_for ở
// record.rs cho video) để tooltip không nói khác file.
function compressionNote(tier: number, screenH: number | null, kind: QualityKind): string {
  if (kind === "video") {
    return tier <= 720 ? "nén mạnh (crf 28), file nhẹ nhất" : tier <= 1080 ? "nén vừa (crf 24)" : "nén nhẹ (crf 20)";
  }
  const q = webpQuality(tier, screenH);
  return q >= 1 ? "ảnh lưu không nén mất dữ liệu" : `nén WebP ${q}${tier <= 720 ? ", file nhẹ nhất" : " cho nhẹ"}`;
}

function tierTitle(std: string, out: TierOut | null, src: [number, number] | null, tier: number, kind: QualityKind): string {
  if (!out || !src) return `${std} — ${compressionNote(tier, null, kind)}`;
  const [sw, sh] = src;
  if (out.mode === "blocked") {
    return `${std} — KHÔNG HỖ TRỢ: phóng to lên ${out.w}×${out.h} vượt giới hạn ${VIDEO_MAX_W}px chiều ngang của video H.264 (đang quay cả vùng ${sw}×${sh} của nhiều màn hình ghép lại)`;
  }
  const what =
    out.mode === "native" ? "đúng độ phân giải màn hình (Native)"
    : out.mode === "down" ? `thu nhỏ từ màn hình ${sw}×${sh}, ra ${out.w}×${out.h}`
    : `UPSCALE từ màn hình ${sw}×${sh}: file ra đúng ${out.w}×${out.h} nhưng chỉ là phóng to — không thêm chi tiết nào, nặng hơn nhiều${kind === "video" ? ", mã hoá tốn CPU hơn" : ""}`;
  return `${std} — ${what} — ${compressionNote(tier, sh, kind)}`;
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
  /** Ảnh hay video — cách tính kích thước (video làm tròn số chẵn) và cách nén khác nhau. */
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
          const out = tierOutput(source, o.value, kind);
          return (
            <button
              key={o.value}
              type="button"
              className={"segmented-btn" + (value === o.value ? " active" : "")}
              disabled={disabled || out?.mode === "blocked"}
              title={tierTitle(o.std, out, source, o.value, kind)}
              aria-pressed={value === o.value}
              onClick={() => onChange(o.value)}
            >
              <span className="segmented-main">{o.label}</span>
              {out && <span className="segmented-sub">{out.w}×{out.h}</span>}
              {out && out.mode !== "down" && (
                <span className={`segmented-tag segmented-tag--${out.mode}`}>{TIER_TAG[out.mode]}</span>
              )}
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

export function SettingsScreen({ capture, record, region, pause, regionRecord, onSave, imageQuality, videoQuality, onSaveQuality, captureSizes, onBack, onCheckUpdate, updateChecking, appVersion, userEmail, onLogout }: Props) {
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

  // Màn chiều cao lẻ (768, 900, 1200, 1600…) không có mức nào là Native — nói thẳng ra, kẻo
  // người dùng đi tìm một nút "đúng màn hình" không tồn tại.
  const oddScreen =
    captureSizes && ![720, 1080, 1440, 2160].includes(captureSizes[1])
      ? `${captureSizes[0]}×${captureSizes[1]}`
      : null;

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
                Độ phân giải của file: 720p = 1280×720 · Full HD = 1920×1080 · 2K = 2560×1440 ·
                4K = 3840×2160. Thấp hơn màn hình thì thu nhỏ cho file nhẹ; cao hơn màn hình là
                Upscale — đủ số pixel nhưng chỉ là phóng to, không nét hơn.
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
              Số dưới mỗi mức là kích thước thật của file — ảnh tính theo màn hình chính, video theo
              cả vùng màn hình (nhiều màn hình thì tính cả hộp bao). <b>Native</b> = đúng độ phân giải
              màn hình. <b>Upscale</b> = phóng to từ màn hình thấp hơn: không thêm chi tiết, file nặng
              hơn nhiều (video 4K từ màn 1080p nặng ~3 lần Full HD).
              {oddScreen && ` Màn hình chính ${oddScreen} không trùng mức nào nên không có lựa chọn Native.`}
              {" "}Mức mới áp dụng cho lần chụp / quay tiếp theo; phiên quay đang chạy vẫn giữ mức cũ.
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
            {appVersion && (
              <span className="settings-version">
                Phiên bản hiện tại <b>v{appVersion}</b>
              </span>
            )}
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
