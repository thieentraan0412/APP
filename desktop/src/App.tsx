import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { writeText, readImage } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import jsQR from "jsqr";
import { readFile } from "@tauri-apps/plugin-fs";
import { EditorScreen } from "./screens/EditorScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ConfirmModal } from "./components/ConfirmModal";
import { ProgressModal } from "./components/ProgressModal";
import { UsageScreen } from "./screens/UsageScreen";
import { DataScreen } from "./screens/DataScreen";
import { AuthScreen } from "./screens/AuthScreen";
import { fetchMe, logout, getStoredUser, type AuthUser } from "./lib/auth";
import {
  uploadImage,
  uploadVideo,
  listItems,
  deleteItem,
  getItem,
  updateItem,
  updateTitle,
  fetchAsDataUrl,
  getUsageStats,
  getStorageOverview,
  syncStorage,
  purgeRange,
  purgeIds,
  purgeOrphans,
  getArchiveStores,
  putArchiveStore,
  deleteArchiveStore,
  getDailyUsage,
  type DailyUsageReport,
  type LibraryItem,
  type UsageStats,
  type StorageOverview,
  type StorageItem,
  type ArchiveStore,
} from "./lib/api";
import {
  pickFolder,
  pickFolders,
  resolveArchiveRoot,
  archiveItems,
  archiveFolderName,
  scanArchive,
  restoreEntries,
  archiveDirState,
  openArchiveDir,
  deviceName,
  readArchiveManifest,
  type ArchiveEntry,
  type ArchiveFailure,
} from "./lib/archive";
import type { Annotations } from "./types";
import { checkForUpdate, applyUpdate, type Update } from "./lib/updater";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import "./App.css";

type Screen = "home" | "editor" | "result" | "library" | "settings" | "usage" | "data";

const DEFAULT_SHORTCUTS = { capture: "Control+Shift+1", record: "Control+Shift+2", region: "Control+Shift+3", pause: "Control+Shift+H", regionRecord: "Control+Shift+4" };
// Chất lượng = chiều CAO tối đa (px). Mặc định 2K để máy 1080p/1440p không bị đổi gì so
// với trước khi có setting này (chỉ thu nhỏ, không bao giờ phóng to — xem fit_height ở Rust).
const DEFAULT_QUALITY = { image: 1440, video: 1440 };
const VIDEO_WARN_SECONDS = 120; // cảnh báo khi quay quá 2 phút
// Trần độ dài một phiên quay. Rust mới là bên thực thi (MAX_RECORD_MS trong record.rs) —
// hằng số này chỉ để hiển thị; sửa thì phải sửa cả hai cho khớp.
const MAX_RECORD_SECONDS = 300;

const SidebarS = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none" as const, stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const USAGE_LIMITS = {
  r2StorageBytes: 10 * 1024 ** 3,
  d1DatabaseBytes: 500 * 1000 ** 2,
};

function checkUsageWarnings(stats: UsageStats): string[] {
  const warns: string[] = [];
  const r2Pct = stats.r2.bytes / USAGE_LIMITS.r2StorageBytes;
  const d1Pct = stats.d1.bytes / USAGE_LIMITS.d1DatabaseBytes;
  if (r2Pct >= 0.9) warns.push(`R2 Storage đạt ${(r2Pct * 100).toFixed(0)}% (giới hạn 10 GB)`);
  if (d1Pct >= 0.9) warns.push(`D1 Database đạt ${(d1Pct * 100).toFixed(0)}% (giới hạn 500 MB)`);
  return warns;
}

function GlobalSidebar({ screen, onHome, onCapture, onRegionCapture, onQrScan, onRecord, onRegionRecord, onData, onUsage, onSettings, recording, usageWarnings }: {
  screen: Screen; onHome: () => void; onCapture: () => void; onRegionCapture: () => void; onQrScan: () => void; onRecord: () => void;
  onRegionRecord: () => void;
  onData: () => void; onUsage: () => void; onSettings: () => void; recording: boolean; usageWarnings: string[];
}) {
  const hasWarn = usageWarnings.length > 0;
  return (
    <nav className="lib-sidebar">
      <button className={`lib-tool${screen === "library" ? " lib-tool--active" : ""}`} onClick={onHome} title="Trang chủ">
        <svg {...SidebarS}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5Z"/><polyline points="9 21 9 12 15 12 15 21"/></svg>
      </button>
      <button className="lib-tool" onClick={onCapture} title="Chụp ảnh">
        <svg {...SidebarS}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3.5"/></svg>
      </button>
      <button className="lib-tool" onClick={onRegionCapture} title="Chụp vùng màn hình (Ctrl+Shift+3)">
        <svg {...SidebarS}><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
      </button>
      <button className="lib-tool" onClick={onQrScan} title="Quét mã QR từ màn hình">
        <svg {...SidebarS}>
          <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="5" y="5" width="3" height="3" fill="currentColor" stroke="none"/>
          <rect x="14" y="3" width="7" height="7" rx="1"/><rect x="16" y="5" width="3" height="3" fill="currentColor" stroke="none"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="5" y="16" width="3" height="3" fill="currentColor" stroke="none"/>
          <rect x="14" y="14" width="3" height="3"/><rect x="18" y="14" width="3" height="3"/><rect x="14" y="18" width="3" height="3"/><rect x="18" y="18" width="3" height="3"/>
        </svg>
      </button>
      <button className={`lib-tool${recording ? " lib-tool--recording" : ""}`} onClick={onRecord} title="Quay / dừng video">
        <svg {...SidebarS}><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8Z"/></svg>
      </button>
      {/* Vô hiệu khi đang quay: một phiên quay chỉ có một vùng, chọn vùng mới lúc này vô nghĩa. */}
      <button className="lib-tool" onClick={onRegionRecord} disabled={recording} title="Quay video theo vùng chọn">
        <svg {...SidebarS}>
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
          <path d="M10 9.2v5.6l5-2.8-5-2.8Z" fill="currentColor" stroke="none"/>
        </svg>
      </button>
      <div className="lib-spacer"/>
      <button className={`lib-tool${screen === "data" ? " lib-tool--active" : ""}`} onClick={onData} title="Quản lý dữ liệu">
        <svg {...SidebarS}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
      </button>
      <button
        className={`lib-tool${screen === "usage" ? " lib-tool--active" : ""}`}
        onClick={onUsage}
        title={hasWarn ? `⚠️ Sắp đạt giới hạn Cloudflare` : "Mức sử dụng"}
        style={{ position: "relative" }}
      >
        <svg {...SidebarS}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        {hasWarn && (
          <span style={{
            position: "absolute", top: 6, right: 6, width: 8, height: 8,
            borderRadius: "50%", background: "#ef4444",
            border: "1.5px solid #1c1c1e",
            animation: "warn-pulse 1.8s ease-in-out infinite",
          }}/>
        )}
      </button>
      <button className={`lib-tool${screen === "settings" ? " lib-tool--active" : ""}`} onClick={onSettings} title="Cài đặt">
        <svg {...SidebarS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 5a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 15 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
      </button>
    </nav>
  );
}

function prettyKey(s: string): string {
  return s.replace("Control", "Ctrl").replace("Super", "Win").split("+").join("+");
}
function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Cache-bust ảnh đã sửa ──────────────────────────────────
// Worker ghi đè ảnh lên cùng URL (/file/:id) và đặt cache 1 năm, nên sau khi sửa
// thumbnail vẫn hiện ảnh cũ trong cache. Ta lưu "phiên bản" mỗi ảnh đã sửa vào
// localStorage và gắn ?cb=<phiên bản> vào URL để buộc tải lại đúng ảnh mới.
// (Chỉ ảnh từng sửa mới tải lại; ảnh khác vẫn dùng cache → không tốn thêm ops.)
const IMG_VER_KEY = "img-versions";
const LIB_CACHE_KEY = "lib-cache"; // danh sách thư viện gần nhất, để hiện khi mạng chập chờn
// Sổ kho lưu trữ nằm trên D1 chứ không phải localStorage: người dùng đứng ở máy B vẫn phải
// tra được nội dung đã xoá đang nằm ở máy A, thư mục nào.
// Bump khi cần buộc nạp lại TẤT CẢ thumbnail ảnh (vd worker đổi Content-Type png→webp).
const IMG_FMT = 2;
function loadImgVersions(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(IMG_VER_KEY) || "{}"); } catch { return {}; }
}
function busted(url: string, v?: number): string {
  if (!v) return url;
  return `${url}${url.includes("?") ? "&" : "?"}cb=${v}`;
}

function App() {
  // Đăng nhập: null = chưa đăng nhập. authChecked = đã kiểm tra phiên lưu sẵn xong.
  const [user, setUser] = useState<AuthUser | null>(getStoredUser);
  const [authChecked, setAuthChecked] = useState(false);

  const [screen, setScreen] = useState<Screen>("library");
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordPaused, setRecordPaused] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [ffmpegDl, setFfmpegDl] = useState<number | null>(null); // null=không tải, -1=không rõ %, 0..100=phần trăm
  // recPopup đã bỏ — thông báo quay được chuyển sang toast hệ thống (Rust)
  const [confirm, setConfirm] = useState<{ message: string; confirmLabel?: string; icon?: string; danger?: boolean; onConfirm: () => void; onCancel?: () => void } | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [dailyUsage, setDailyUsage] = useState<DailyUsageReport | null>(null);
  const [usageWarnings, setUsageWarnings] = useState<string[]>([]);
  const [warnDismissed, setWarnDismissed] = useState(false);

  // Quản lý dữ liệu (dung lượng theo thời gian)
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [orphan, setOrphan] = useState<{ count: number; bytes: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Tiến độ lưu về máy / khôi phục (null = không chạy)
  const [archiveProgress, setArchiveProgress] = useState<{ title: string; done: number; total: number; label: string; bytesDone?: number; bytesTotal?: number } | null>(null);
  const [archiveStores, setArchiveStores] = useState<ArchiveStore[]>([]);
  const [device, setDevice] = useState("");
  // Thư mục có thể bị đổi tên / xoá / tháo ổ ngoài sau khi lưu. Chỉ dò được kho nằm trên
  // CHÍNH máy này; kho của máy khác thì đành tin số liệu trong sổ.
  const [dirStates, setDirStates] = useState<Record<string, { exists: boolean; items: number }>>({});

  useEffect(() => { deviceName().then(setDevice).catch(() => {}); }, []);

  async function loadArchiveStores() {
    try {
      setArchiveStores(await getArchiveStores());
    } catch {
      // Mất mạng thì thôi, phần còn lại của trang vẫn dùng được — không dựng cờ lỗi đỏ.
    }
  }

  useEffect(() => { loadArchiveStores(); }, []);

  useEffect(() => {
    if (!device) return;
    let alive = true;
    (async () => {
      const next: Record<string, { exists: boolean; items: number }> = {};
      for (const s of archiveStores) {
        if (s.device === device) next[s.dir] = await archiveDirState(s.dir);
      }
      if (alive) setDirStates(next);
    })();
    return () => { alive = false; };
  }, [archiveStores, device]);

  const [shortcuts, setShortcuts] = useState(DEFAULT_SHORTCUTS);
  const [quality, setQuality] = useState(DEFAULT_QUALITY);
  // Kích thước nguồn thật (px vật lý): [rộng, cao] màn chính cho ảnh chụp, rồi [rộng, cao]
  // cả virtual desktop cho video toàn màn hình. null = chưa đọc được.
  const [captureSizes, setCaptureSizes] = useState<[number, number, number, number] | null>(null);

  // Video chờ lưu (chưa upload)
  const [videoPendingReady, setVideoPendingReady] = useState(false);
  const videoPendingRef = useRef<{ blob: Blob; path: string } | null>(null);
  // Ref luôn trỏ đến handleVideoReady mới nhất — tránh stale closure trong useEffect
  const videoReadyHandlerRef = useRef<(path: string) => Promise<void>>(async () => {});
  const saveVideoRef = useRef<() => Promise<void>>(async () => {});
  const videoTitleInputRef = useRef<HTMLInputElement>(null);

  // QR scan
  const qrModeRef = useRef(false);
  type QrState = { found: true; text: string; isUrl: boolean } | { found: false } | null;
  const [qrResult, setQrResult] = useState<QrState>(null);

  // Tự động cập nhật
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null); // null = chưa tải
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Sửa annotate
  const [editId, setEditId] = useState<string | null>(null);
  const [initialAnnotations, setInitialAnnotations] = useState<Annotations | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // id của mục vừa lưu + tiêu đề cho video (video không qua editor)
  const [resultId, setResultId] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [titleSaved, setTitleSaved] = useState(false);

  // Màn hình kết quả
  const [preview, setPreview] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "video">("image");
  // Xem ảnh kết quả ở kích thước thật (1:1). Mặc định thu vừa khung nên ảnh 1080p bị
  // trình duyệt co lại ~0,65× → chữ nhỏ bết; bấm vào ảnh để xem đúng từng pixel.
  const [previewFull, setPreviewFull] = useState(false);
  useEffect(() => setPreviewFull(false), [preview]);
  const [uploading, setUploading] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Cắt video (trim) trước khi lưu
  const [videoDuration, setVideoDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimming, setTrimming] = useState(false);
  const videoElRef = useRef<HTMLVideoElement>(null);

  // Thư viện
  const [libItems, setLibItems] = useState<LibraryItem[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);
  const [imgVersions, setImgVersions] = useState<Record<string, number>>(loadImgVersions);

  const screenRef = useRef<Screen>("library");
  useEffect(() => { screenRef.current = screen; }, [screen]);
  const libRetry = useRef(0); // đếm lần tự thử lại khi tải thư viện thất bại (mạng chập chờn)

  // Luôn giữ refs trỏ đến handler hiện tại — tránh stale closure trong useEffect
  useEffect(() => {
    videoReadyHandlerRef.current = handleVideoReady;
    saveVideoRef.current = saveVideo;
  });

  useEffect(() => {
    async function handlePaste(e: ClipboardEvent) {
      if (screenRef.current === "editor") return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            setError(null);
            setEditId(null);
            setInitialAnnotations(null);
            setEditTitle("");
            setImage(dataUrl);
            setScreen("editor");
          };
          reader.readAsDataURL(file);
          return;
        }
      }
      // Fallback: đọc ảnh từ clipboard qua Tauri plugin (dán từ app khác)
      try {
        const img = await readImage();
        const [rgba, size] = await Promise.all([img.rgba(), img.size()]);
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        setError(null);
        setEditId(null);
        setInitialAnnotations(null);
        setEditTitle("");
        setImage(dataUrl);
        setScreen("editor");
      } catch {}
    }
    window.addEventListener("paste", handlePaste);

    const subs = [
      listen<{ dataUrl: string; region: boolean }>("image-captured", (e) => {
        const { dataUrl, region } = e.payload;
        if (qrModeRef.current) {
          qrModeRef.current = false;
          decodeQr(dataUrl);
          return;
        }
        setError(null);
        setEditId(null);
        setInitialAnnotations(null);
        setEditTitle("");
        setImage(dataUrl);
        setScreen("editor");
        // Ảnh CẮT VÙNG (phím tắt chụp vùng / nút chụp vùng): tự dò QR im lặng — có mã thì
        // hiện luôn modal link, không có thì không báo gì. Ảnh chụp full KHÔNG tự dò, tránh
        // popup QR bất ngờ khi trên màn hình tình cờ có mã.
        if (region) decodeQr(dataUrl, true);
      }),
      listen("region-cancelled", () => { qrModeRef.current = false; }),
      // Chụp lỗi (kể cả khi đang ở chế độ Quét QR) → reset qrModeRef, nếu không lần
      // chụp/phím tắt kế tiếp sẽ bị "nuốt" thành dò QR (H1).
      listen<string>("capture-error", (e) => { qrModeRef.current = false; setError(e.payload); }),
      listen("recording-started", () => { setRecording(true); setRecordPaused(false); }),
      listen("recording-stopped", () => { setRecording(false); setRecordPaused(false); }),
      listen("recording-paused", () => { setRecordPaused(true); }),
      listen("recording-resumed", () => { setRecordPaused(false); }),
      // Rust vừa tự dừng vì chạm trần 5 phút — nói rõ để người dùng không tưởng app lỗi.
      listen("recording-limit", () => showToast(`Đã quay đủ ${fmtTime(MAX_RECORD_SECONDS)} — tự động dừng`)),
      listen<string>("video-ready", (e) => videoReadyHandlerRef.current(e.payload)),
      listen<string>("video-error", (e) => {
        setRecording(false);
        setRecordPaused(false);
        setFfmpegDl(null);
        setScreen("result");
        setUploading(false);
        setUploadError(e.payload);
      }),
      listen("ffmpeg-downloading", () => setFfmpegDl(0)),
      listen<number>("ffmpeg-progress", (e) => setFfmpegDl(e.payload)),
      listen("ffmpeg-ready", () => { setFfmpegDl(null); showToast("Đã sẵn sàng quay video"); }),
      listen("ffmpeg-preparing", () => showToast("Đang chuẩn bị bộ quay (đợi hệ thống quét xong)…")),
    ];
    return () => {
      window.removeEventListener("paste", handlePaste);
      subs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  // Tải phím tắt đã lưu và áp dụng khi mở app (không cần đăng nhập).
  // Rust đã tự đăng ký phím đã lưu ngay lúc khởi động; đây là lớp dự phòng + để đồng bộ
  // cho người dùng cũ (localStorage có nhưng file cấu hình Rust chưa có). WebView2 hay
  // treo/rớt lời gọi IPC ĐẦU TIÊN → thử lại vài lần thay vì nuốt lỗi im lặng.
  useEffect(() => {
    let cancelled = false;
    let cfg = DEFAULT_SHORTCUTS;
    try {
      const saved = localStorage.getItem("shortcuts");
      cfg = { ...DEFAULT_SHORTCUTS, ...(saved ? JSON.parse(saved) : {}) };
    } catch {}
    setShortcuts(cfg);
    (async () => {
      for (let i = 0; i < 5 && !cancelled; i++) {
        try {
          await invoke("set_shortcuts", { capture: cfg.capture, record: cfg.record, region: cfg.region, pause: cfg.pause, regionRecord: cfg.regionRecord });
          return; // đăng ký xong (Rust cũng đã ghi file cho lần mở sau)
        } catch {
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ĐỌC mức chất lượng từ Rust — file cấu hình bên đó mới là bản chính, vì phím tắt toàn
  // cục chụp/quay đọc thẳng từ nó và chạy được cả khi frontend chưa kịp lên. Đẩy ngược
  // giá trị của webview lên như phần phím tắt sẽ đạp mức đã chọn về mặc định mỗi lần
  // localStorage trống. Thử lại vài lần vì lời gọi IPC đầu tiên của WebView2 hay rớt.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 5 && !cancelled; i++) {
        try {
          const [image, video] = await invoke<[number, number]>("get_quality");
          if (!cancelled) setQuality({ image, video });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    invoke<[number, number, number, number]>("capture_sizes")
      .then(setCaptureSizes)
      .catch(() => {}); // không đọc được thì Cài đặt chỉ bớt phần gợi ý px
  }, []);

  // Kiểm tra phiên đăng nhập đã lưu khi mở app (token còn hạn?)
  useEffect(() => {
    fetchMe()
      .then((u) => setUser(u))
      .finally(() => setAuthChecked(true));
  }, []);

  // Sau khi đăng nhập: load thư viện + thống kê mức dùng
  useEffect(() => {
    if (!user) return;
    openLibrary();
    loadUsageStats(true); // load thầm lặng để hiện badge cảnh báo ngay từ đầu
  }, [user]);

  // Kiểm tra cập nhật khi mở app (im lặng — chỉ hiện thông báo nếu có bản mới)
  useEffect(() => {
    checkForUpdate().then((u) => { if (u) setUpdate(u); });
  }, []);

  // Auto-focus ô tiêu đề khi video vừa quay xong
  useEffect(() => {
    if (videoPendingReady) {
      window.setTimeout(() => videoTitleInputRef.current?.focus(), 100);
    }
  }, [videoPendingReady]);

  // Ctrl+S trên màn hình result khi video chưa lưu → lưu lên server
  useEffect(() => {
    if (screen !== "result" || !videoPendingReady) return;
    const handler = (e: KeyboardEvent) => {
      // e.code="KeyS" không lệ thuộc layout; capture phase để tới trước mọi element con
      if ((e.ctrlKey || e.metaKey) && (e.code === "KeyS" || e.key.toLowerCase() === "s")) {
        e.preventDefault();
        saveVideoRef.current();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [screen, videoPendingReady]);

  // ESC trên màn hình result → quay về trang chủ
  useEffect(() => {
    if (screen !== "result") return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") backHome(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [screen]);

  // Đếm thời gian khi đang quay video
  useEffect(() => {
    if (!recording) {
      setRecordSeconds(0);
      return;
    }
    if (recordPaused) return; // đang tạm dừng: giữ nguyên số giây, ngừng đếm
    // Chặn ở trần: Rust dừng đúng mốc 5:00 nhưng sự kiện "recording-stopped" về sau đó vài
    // nhịp — không kẹp thì banner kịp nhảy 5:01 rồi mới tắt.
    const t = window.setInterval(() => setRecordSeconds((s) => Math.min(s + 1, MAX_RECORD_SECONDS)), 1000);
    return () => window.clearInterval(t);
  }, [recording, recordPaused]);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }

  // Đánh dấu ảnh vừa sửa với phiên bản mới (timestamp) → ép tải lại ảnh mới, kể cả sau khi mở lại app
  function bumpImgVersion(id: string) {
    setImgVersions((prev) => {
      const next = { ...prev, [id]: Date.now() };
      try { localStorage.setItem(IMG_VER_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }
  function pruneImgVersion(id: string) {
    setImgVersions((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      try { localStorage.setItem(IMG_VER_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }
  // Gắn tham số cho URL ảnh (video không cần):
  // - ?cb : bust cache khi sửa lại ảnh (per-item).
  // - ?fmt: bust MỘT LẦN cho mọi ảnh khi worker đổi Content-Type png→webp. Trước đây
  //   webview cache phản hồi cũ (image/png nhưng byte WebP, Cache-Control 1 năm) nên
  //   thumbnail vỡ; đổi URL → nạp lại → nhận image/webp đúng → hiện được. Tăng IMG_FMT
  //   nếu sau này cần buộc nạp lại toàn bộ ảnh.
  const displayItems = libItems.map((it) => {
    if (it.type !== "image") return it;
    let url = busted(it.fileUrl, imgVersions[it.id]);
    url += `${url.includes("?") ? "&" : "?"}fmt=${IMG_FMT}`;
    return { ...it, fileUrl: url };
  });

  // Tải & cài bản cập nhật (app sẽ tự khởi động lại khi xong)
  async function runUpdate() {
    if (!update) return;
    try {
      setUpdateProgress(0);
      await applyUpdate(update, (pct) => setUpdateProgress(pct));
    } catch (err) {
      setUpdateProgress(null);
      showToast("Cập nhật lỗi: " + String(err));
    }
  }

  // Kiểm tra cập nhật thủ công (từ màn Cài đặt)
  async function manualCheckUpdate() {
    setUpdateChecking(true);
    try {
      const u = await checkForUpdate();
      if (u) {
        setUpdate(u);
        setUpdateDismissed(false);
      } else {
        showToast("Bạn đang dùng bản mới nhất");
      }
    } finally {
      setUpdateChecking(false);
    }
  }

  function resetResult() {
    setLink(null);
    setUploadError(null);
    setCopied(false);
    setPreview(null);
    setResultId(null);
    setVideoTitle("");
    setTitleSaved(false);
    setVideoPendingReady(false);
    setVideoDuration(0);
    setTrimStart(0);
    setTrimEnd(0);
    setTrimming(false);
  }

  function manualRegionCapture() {
    invoke("start_region_capture").catch(() => {});
  }

  function manualRegionRecord() {
    invoke("start_region_record").catch(() => {});
  }

  async function manualCapture() {
    try {
      const dataUrl = await invoke<string>("capture_screen");
      setError(null);
      setEditId(null);
      setInitialAnnotations(null);
      setEditTitle("");
      setImage(dataUrl);
      setScreen("editor");
    } catch (err) {
      setError(String(err));
    }
  }

  function isHttpUrl(s: string): boolean {
    try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
  }

  // silent = true: chỉ hiện modal khi TÌM THẤY mã (dùng cho tự dò trên ảnh cắt vùng).
  function decodeQr(dataUrl: string, silent = false) {
    // Xoá kết quả QR cũ trước: tránh modal của lần quét trước còn sót lại khi ảnh mới không có QR.
    setQrResult(null);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const code = jsQR(imageData.data, img.width, img.height);
        if (code) {
          setQrResult({ found: true, text: code.data, isUrl: isHttpUrl(code.data) });
        } else if (!silent) {
          // Người dùng chủ động Quét QR → báo rõ là không tìm thấy.
          setQrResult({ found: false });
        }
      } catch {}
    };
    img.onerror = () => {};
    img.src = dataUrl;
  }

  function triggerQrScan() {
    qrModeRef.current = true;
    invoke("start_region_capture").catch(() => { qrModeRef.current = false; });
  }

  async function handleSaved(
    flattened: Blob,
    original: Blob,
    annotations: Annotations,
    title: string
  ) {
    // Đang sửa một mục đã có → cập nhật (PATCH)
    if (editId) {
      try {
        await updateItem(editId, flattened, annotations, title);
        bumpImgVersion(editId); // ép thumbnail tải lại ảnh mới (qua cache)
        showToast("Đã cập nhật");
        setEditId(null);
        setInitialAnnotations(null);
        await openLibrary();
      } catch (err) {
        setScreen("result");
        resetResult();
        setUploadError(String(err));
      }
      return;
    }

    // Tạo mới (POST)
    setScreen("result");
    resetResult();
    setPreviewType("image");
    setPreview(URL.createObjectURL(flattened));
    setUploading(true);
    try {
      const { id, url } = await uploadImage(flattened, original, annotations, title);
      setResultId(id);
      setLink(url);
      try {
        await writeText(url);
        setCopied(true);
      } catch {}
    } catch (err) {
      setUploadError(String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleVideoReady(path: string) {
    // Dọn video pending cũ nếu có
    if (videoPendingRef.current) {
      invoke("remove_temp", { path: videoPendingRef.current.path }).catch(() => {});
    }
    setScreen("result");
    resetResult();
    setPreviewType("video");
    try {
      const bytes = await readFile(path);
      const blob = new Blob([bytes], { type: "video/mp4" });
      setPreview(URL.createObjectURL(blob));
      videoPendingRef.current = { blob, path };
      setVideoPendingReady(true);
    } catch (err) {
      setUploadError(String(err));
    }
  }

  async function saveVideoLocal() {
    if (!videoPendingRef.current) return;
    const { path } = videoPendingRef.current;
    const defaultName = (videoTitle.trim() || "video") + ".mp4";
    try {
      const dst = await saveDialog({ defaultPath: defaultName, filters: [{ name: "Video MP4", extensions: ["mp4"] }] });
      if (!dst) return;
      await invoke("save_video_to_path", { src: path, dst });
      showToast("Đã lưu vào máy tính");
    } catch (err) {
      showToast("Lưu thất bại: " + String(err));
    }
  }

  // Cắt video theo đoạn đã chọn: gọi ffmpeg ở Rust → thay preview + blob pending bằng bản đã cắt.
  async function trimVideo() {
    if (!videoPendingRef.current) return;
    const src = videoPendingRef.current.path;
    const start = Math.max(0, trimStart);
    const end = Math.min(videoDuration, trimEnd);
    if (end - start < 0.2) { showToast("Đoạn chọn quá ngắn"); return; }
    setTrimming(true);
    try {
      const newPath = await invoke<string>("trim_video", { src, start, end });
      const bytes = await readFile(newPath);
      const blob = new Blob([bytes], { type: "video/mp4" });
      invoke("remove_temp", { path: src }).catch(() => {}); // xoá file gốc chưa cắt
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(blob));
      videoPendingRef.current = { blob, path: newPath };
      // videoDuration + trimStart/End sẽ tự đặt lại qua onLoadedMetadata của <video>
      showToast("Đã cắt video");
    } catch (err) {
      showToast("Cắt video lỗi: " + String(err));
    } finally {
      setTrimming(false);
    }
  }

  async function saveVideo() {
    if (!videoPendingRef.current) return;
    const { blob, path } = videoPendingRef.current;
    const titleToSave = videoTitle.trim();
    setVideoPendingReady(false);
    setUploading(true);
    try {
      const { id, url } = await uploadVideo(blob);
      setResultId(id);
      setLink(url);
      videoPendingRef.current = null;
      invoke("remove_temp", { path }).catch(() => {});
      if (titleToSave) {
        try { await updateTitle(id, titleToSave); setTitleSaved(true); } catch {}
      }
      try {
        await writeText(url);
        setCopied(true);
      } catch {}
    } catch (err) {
      setUploadError(String(err));
      // Khôi phục trạng thái pending nếu upload lỗi
      videoPendingRef.current = { blob, path };
      setVideoPendingReady(true);
    } finally {
      setUploading(false);
    }
  }

  async function openLibrary() {
    setScreen("library");
    await reloadLibrary();
  }

  // Tải lại thư viện mà KHÔNG chuyển màn hình (dùng sau khi xoá từ trang Quản lý dữ liệu)
  async function reloadLibrary() {
    setLibLoading(true);
    setLibError(null);
    try {
      const items = await listItems();
      setLibItems(items);
      libRetry.current = 0;
      try { localStorage.setItem(LIB_CACHE_KEY, JSON.stringify(items)); } catch {}
    } catch (err) {
      // Không tải được (mạng/webview chập chờn lúc khởi động): hiện danh sách đã lưu gần
      // nhất để vẫn dùng được, thay vì trắng trơn.
      let cached: LibraryItem[] | null = null;
      try { cached = JSON.parse(localStorage.getItem(LIB_CACHE_KEY) || "null"); } catch {}
      if (cached && cached.length) {
        setLibItems(cached);
        setLibError('Đang hiện danh sách đã lưu (chưa kết nối được máy chủ). Đang thử lại…');
      } else {
        setLibError(String(err));
      }
      // Tự động thử lại (backoff tăng dần) — không bắt người dùng phải bấm Làm mới liên tục.
      if (libRetry.current < 5 && screenRef.current === "library") {
        libRetry.current += 1;
        window.setTimeout(() => { if (screenRef.current === "library") reloadLibrary(); }, 2500 * libRetry.current);
      }
    } finally {
      setLibLoading(false);
    }
  }

  // ── Quản lý dữ liệu ────────────────────────────────────────
  function fmtBytes(bytes: number): string {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
    return `${Math.round(bytes)} B`;
  }

  /** `opts` bỏ trống = hộp thoại xoá (đỏ, nhãn "Xoá") như mọi chỗ đang gọi. */
  function askConfirm(
    message: string,
    opts?: { confirmLabel?: string; icon?: string; danger?: boolean }
  ): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirm({
        message,
        ...opts,
        onCancel: () => resolve(false),
        onConfirm: () => { setConfirm(null); resolve(true); },
      });
    });
  }

  async function loadStorage() {
    setStorageLoading(true);
    setStorageError(null);
    try {
      setStorage(await getStorageOverview());
    } catch (err) {
      setStorageError(String(err));
    } finally {
      setStorageLoading(false);
    }
  }

  async function openData() {
    setScreen("data");
    await loadStorage();
  }

  // Sau khi xoá: thư viện, dung lượng và thống kê đều đã cũ → nạp lại (không đổi màn hình)
  async function afterPurge() {
    await Promise.all([loadStorage(), reloadLibrary(), loadUsageStats(true)]);
  }

  /**
   * Làm mới trang Quản lý dữ liệu. Gộp hai việc trước đây tách làm hai nút:
   *   1. Quét R2 đối chiếu dung lượng thật + tìm file rác  (POST /api/storage/sync)
   *   2. Đọc lại thống kê theo ngày từ D1                   (GET  /api/storage)
   *
   * Tách hai nút chỉ gây rối vì người dùng không thể biết khi nào cần bấm cái nào, trong
   * khi bước quét chỉ tốn thêm 1 Class A cho mỗi 1.000 object và chỉ ghi D1 khi thật sự
   * có sai lệch. Quét hỏng (mạng chập chờn) vẫn đọc tiếp thống kê — thà số hơi cũ còn hơn
   * trang trắng.
   */
  async function handleRefreshStorage() {
    setSyncing(true);
    let note = "";
    try {
      const r = await syncStorage();
      setOrphan(r.orphan);
      const parts: string[] = [];
      if (r.updated > 0) parts.push(`cập nhật ${r.updated} mục`);
      if (r.orphan.count > 0) parts.push(`${r.orphan.count} file rác (${fmtBytes(r.orphan.bytes)})`);
      if (r.missingFiles > 0) parts.push(`${r.missingFiles} mục thiếu file`);
      note = parts.length > 0 ? " · " + parts.join(" · ") : "";
    } catch {
      note = " · chưa đối chiếu được R2";
    }
    try {
      await loadStorage();
      showToast("Đã làm mới" + note);
    } catch (err) {
      showToast("Làm mới lỗi: " + String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handlePurgeRange(from: number, to: number, label: string, items: number, bytes: number): Promise<boolean> {
    const ok = await askConfirm(
      `Xoá ${items} mục ${label}? Giải phóng khoảng ${fmtBytes(bytes)}. Link chia sẻ của các mục này sẽ hỏng vĩnh viễn.`
    );
    if (!ok) return false;
    try {
      const r = await purgeRange(from, to);
      showToast(`Đã xoá ${r.deleted} mục · giải phóng ${fmtBytes(r.bytesFreed)}`);
      await afterPurge();
      return true;
    } catch (err) {
      showToast("Xoá lỗi: " + String(err));
      return false;
    }
  }

  async function handlePurgeIds(ids: string[], bytes: number): Promise<boolean> {
    const ok = await askConfirm(
      `Xoá ${ids.length} mục đã chọn? Giải phóng khoảng ${fmtBytes(bytes)}. Không thể hoàn tác.`
    );
    if (!ok) return false;
    try {
      const r = await purgeIds(ids);
      setImgVersions((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of ids) if (id in next) { delete next[id]; changed = true; }
        if (changed) { try { localStorage.setItem(IMG_VER_KEY, JSON.stringify(next)); } catch {} }
        return changed ? next : prev;
      });
      showToast(`Đã xoá ${r.deleted} mục · giải phóng ${fmtBytes(r.bytesFreed)}`);
      await afterPurge();
      return true;
    } catch (err) {
      showToast("Xoá lỗi: " + String(err));
      return false;
    }
  }

  // Lưu về máy rồi xoá trên cloud. Điểm mấu chốt: chỉ xoá đúng những mục đã tải xong
  // (r.saved), mục nào lỗi vẫn nằm nguyên trên cloud — không bao giờ xoá thứ chưa có bản sao.
  async function handleArchiveItems(items: StorageItem[], folder: string): Promise<boolean> {
    const bytes = items.reduce((s, it) => s + (it.bytes ?? 0), 0);
    const dir = await pickFolder("Chọn thư mục lưu bản sao trước khi xoá");
    if (!dir) return false;

    const sub = archiveFolderName(folder);
    const ok = await askConfirm(
      `Tải ${items.length} mục (${fmtBytes(bytes)}) vào thư mục "${sub}" trong "${dir}" rồi xoá trên cloud? ` +
        `Khôi phục lại được từ thư mục này, và mỗi mục sẽ xin lại đúng link chia sẻ cũ.`,
      // Vẫn là hành động phá huỷ (xoá trên cloud) nên giữ nút đỏ, chỉ đổi nhãn cho đúng việc.
      { confirmLabel: "Lưu về máy & xoá", icon: "💾" }
    );
    if (!ok) return false;

    setArchiveProgress({ title: "Đang tải về máy…", done: 0, total: items.length, label: "" });
    try {
      const r = await archiveItems(
        dir,
        items,
        (p) => setArchiveProgress({ title: "Đang tải về máy…", ...p }),
        folder
      );

      if (r.saved.length === 0) {
        showToast(`Không tải được mục nào — chưa xoá gì. ${r.failed[0]?.error ?? ""}`);
        return false;
      }

      // Nhớ thư mục ngay khi có file nằm trong đó, kể cả nếu bước xoá dưới đây hỏng —
      // đã có bản sao trên máy thì phải tìm lại được.
      await syncArchiveDir(dir);

      setArchiveProgress({ title: "Đang xoá trên cloud…", done: r.saved.length, total: items.length, label: "" });
      const del = await purgeIds(r.saved.map((e) => e.id));

      const parts = [`Đã lưu ${r.saved.length} mục vào máy · giải phóng ${fmtBytes(del.bytesFreed)}`];
      // Nói rõ số mục lỗi: chúng vẫn còn trên cloud, người dùng cần biết để làm lại.
      if (r.failed.length > 0) parts.push(`${r.failed.length} mục lỗi (giữ nguyên trên cloud)`);
      showToast(parts.join(" · "));
      await afterPurge();
      return true;
    } catch (err) {
      showToast("Lưu về máy lỗi: " + String(err));
      return false;
    } finally {
      setArchiveProgress(null);
    }
  }

  // Đẩy cả manifest lên sổ trên cloud. Gửi manifest chứ không gửi riêng phần vừa lưu, để
  // sổ luôn phản ánh đúng nội dung thật của thư mục — kể cả khi người dùng tự xoá bớt file.
  async function syncArchiveDir(dir: string) {
    try {
      const entries = await readArchiveManifest(dir);
      await putArchiveStore({
        device: device || (await deviceName()),
        dir,
        items: entries.map((e) => ({
          id: e.id,
          type: e.type,
          title: e.title,
          bytes: e.bytes,
          createdAt: e.createdAt,
          archivedAt: e.archivedAt,
          file: e.file,
        })),
      });
      await loadArchiveStores();
    } catch (err) {
      // Ghi sổ hỏng không được làm hỏng việc lưu — file dưới máy vẫn còn, khôi phục vẫn được.
      showToast("Lưu xong nhưng chưa ghi được vào sổ kho: " + String(err));
    }
  }

  async function forgetArchiveStore(id: string) {
    try {
      await deleteArchiveStore(id);
      await loadArchiveStores();
    } catch (err) {
      showToast("Không bỏ được khỏi sổ: " + String(err));
    }
  }

  async function handleOpenArchiveDir(dir: string) {
    try {
      await openArchiveDir(dir);
    } catch (err) {
      showToast("Không mở được thư mục: " + String(err));
    }
  }

  /**
   * `preset` = khôi phục thẳng từ thư mục đã nhớ, bỏ qua bước chọn thư mục.
   * `onlyIds` = chỉ khôi phục đúng mấy mục đó (nút trên từng dòng trong kho); bỏ trống thì
   * khôi phục cả kho.
   *
   * Không có `preset` thì cho chọn NHIỀU thư mục một lượt. Mỗi thư mục được quy về cặp
   * (gốc kho, phần bên trong): chọn gốc kho thì lấy tất, chọn một thư mục mốc thì chỉ lấy
   * phần nằm trong nó. Nhờ vậy chọn lẫn lộn gốc kho và thư mục mốc vẫn chạy đúng.
   */
  async function handleRestore(preset?: string, onlyIds?: string[]) {
    const picked = preset ? [preset] : await pickFolders("Chọn một hay nhiều thư mục kho / thư mục mốc");
    if (picked.length === 0) return;

    setArchiveProgress({ title: "Đang đọc thư mục…", done: 0, total: 0, label: "" });
    try {
      // Gộp các thư mục cùng gốc kho lại: chọn cả hai thư mục mốc trong một kho thì chỉ đọc
      // manifest một lần, và quan trọng hơn là chỉ ghi sổ một lần cho kho đó.
      const groups = new Map<string, { root: string; entries: ArchiveEntry[]; missing: number }>();
      const seen = new Set<string>(); // chọn trùng (gốc kho + thư mục con trong nó) → khỏi tải hai lần
      const notArchive: string[] = [];

      for (const dir of picked) {
        const found = await resolveArchiveRoot(dir);
        if (!found) { notArchive.push(dir); continue; }
        const scan = await scanArchive(found.root, found.prefix);
        let g = groups.get(found.root);
        if (!g) { g = { root: found.root, entries: [], missing: 0 }; groups.set(found.root, g); }
        g.missing += scan.missing.length;
        for (const e of scan.entries) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          g.entries.push(e);
        }
      }

      // Thư mục tự chọn mà đúng là kho thì nhớ luôn — lần sau bấm một phát là xong.
      for (const root of groups.keys()) await syncArchiveDir(root);

      // Lọc theo id khi bấm khôi phục một dòng. Id có trong sổ nhưng thiếu trong manifest
      // (hoặc file đã bị xoá khỏi thư mục) thì báo rõ, đừng im lặng khôi phục cả kho.
      let entries: ArchiveEntry[] = [];
      let missingTotal = 0;
      const plan: { root: string; entries: ArchiveEntry[] }[] = [];
      for (const g of groups.values()) {
        const pick = onlyIds ? g.entries.filter((e) => onlyIds.includes(e.id)) : g.entries;
        missingTotal += g.missing;
        if (pick.length > 0) plan.push({ root: g.root, entries: pick });
        entries = entries.concat(pick);
      }

      if (entries.length === 0) {
        showToast(
          onlyIds
            ? (missingTotal > 0
                ? "File của mục này không còn trong thư mục kho — không khôi phục được"
                : "Không tìm thấy mục này trong sổ của thư mục kho")
            : missingTotal > 0
              ? `Thư mục có danh sách nhưng thiếu file (${missingTotal} mục) — không khôi phục được`
              : notArchive.length === picked.length
                ? "Thư mục này không phải kho lưu trữ của app (thiếu captureshare-archive.json)"
                : "Không có mục nào để khôi phục trong thư mục đã chọn"
        );
        return;
      }

      const bytes = entries.reduce((s, e) => s + (e.bytes || 0), 0);
      const warn = !onlyIds && missingTotal > 0 ? ` (${missingTotal} mục thiếu file sẽ bỏ qua)` : "";
      // Chọn nhầm vài thư mục không phải kho thì nói luôn trong hộp thoại, đừng lặng lẽ bỏ qua
      // rồi để người dùng thắc mắc sao số mục ít hơn mình tưởng.
      const skip = notArchive.length > 0 ? ` Bỏ qua ${notArchive.length} thư mục không phải kho.` : "";
      const spread = plan.length > 1 ? ` từ ${plan.length} kho` : "";
      // Khôi phục KHÔNG xoá gì cả — dùng nút xanh "Khôi phục", đừng để nút đỏ ghi "Xoá"
      // làm người dùng tưởng bấm vào là mất dữ liệu rồi không dám bấm.
      const ok = await askConfirm(
        (entries.length === 1
          ? `Khôi phục “${entries[0].title || "(không tiêu đề)"}” (${fmtBytes(bytes)}) lên cloud? `
          : `Khôi phục ${entries.length} mục${spread} (${fmtBytes(bytes)}) lên cloud?${warn}${skip} `) +
          `Mỗi mục xin lại link chia sẻ cũ; mục nào có id đã bị dùng lại thì nhận link mới. ` +
          `File dưới máy vẫn giữ nguyên.`,
        { confirmLabel: "Khôi phục", icon: "☁️", danger: false }
      );
      if (!ok) return;

      // Chạy lần lượt từng kho nhưng thanh tiến độ tính trên TỔNG: chia theo từng kho thì
      // thanh sẽ tụt về 0 mỗi lần sang kho mới, nhìn như bị treo giữa chừng.
      const totalItems = entries.length;
      const totalBytes = entries.reduce((s, e) => s + (e.bytes || 1_000_000), 0);
      let doneItems = 0;
      let doneBytes = 0;
      const r = { restored: 0, keptLinks: 0, failed: [] as ArchiveFailure[] };

      setArchiveProgress({ title: "Đang khôi phục…", done: 0, total: totalItems, label: "" });
      for (const g of plan) {
        const part = await restoreEntries(g.root, g.entries, (p) =>
          setArchiveProgress({
            title: "Đang khôi phục…",
            label: p.label,
            done: doneItems + p.done,
            total: totalItems,
            bytesDone: doneBytes + p.bytesDone,
            bytesTotal: totalBytes,
          })
        );
        r.restored += part.restored;
        r.keptLinks += part.keptLinks;
        r.failed.push(...part.failed);
        doneItems += g.entries.length;
        doneBytes += g.entries.reduce((s, e) => s + (e.bytes || 1_000_000), 0);
      }

      const parts = [`Đã khôi phục ${r.restored} mục`];
      // Nói rõ bao nhiêu mục giữ được link cũ: người dùng cần biết link nào còn gửi đi được.
      if (r.restored > 0) {
        const renewed = r.restored - r.keptLinks;
        parts.push(
          renewed === 0
            ? "giữ nguyên link cũ"
            : `${r.keptLinks} giữ link cũ · ${renewed} nhận link mới (id đã bị dùng)`
        );
      }
      // Kèm luôn lý do của mục lỗi đầu tiên — chỉ báo "N mục lỗi" thì không ai biết đường sửa.
      if (r.failed.length > 0) parts.push(`${r.failed.length} mục lỗi: ${r.failed[0].error}`);
      showToast(parts.join(" · "));
      // File dưới máy giữ nguyên: khôi phục xong vẫn còn bản sao, người dùng tự xoá khi muốn.
      await afterPurge();
    } catch (err) {
      showToast("Khôi phục lỗi: " + String(err));
    } finally {
      setArchiveProgress(null);
    }
  }

  async function handlePurgeOrphans() {
    if (!orphan || orphan.count === 0) return;
    const ok = await askConfirm(
      `Dọn ${orphan.count} file rác (${fmtBytes(orphan.bytes)})? Đây là file không còn nội dung nào dùng tới.`
    );
    if (!ok) return;
    try {
      const r = await purgeOrphans();
      setOrphan({ count: 0, bytes: 0 });
      showToast(`Đã dọn ${r.orphansDeleted ?? 0} file · giải phóng ${fmtBytes(r.bytesFreed)}`);
      await loadUsageStats(true);
    } catch (err) {
      showToast("Dọn rác lỗi: " + String(err));
    }
  }

  async function loadUsageStats(silent = false) {
    if (!silent) setUsageLoading(true);
    try {
      // Hai nguồn độc lập: getUsageStats quét dung lượng thật, getDailyUsage đọc sổ đếm
      // request/thao tác. Chạy song song để bấm "Làm mới" một phát là cả trang tươi lại.
      const [stats, daily] = await Promise.all([
        getUsageStats(),
        getDailyUsage(30).catch(() => null), // sổ đếm hỏng không được làm chết cả trang
      ]);
      setUsageStats(stats);
      setDailyUsage(daily);
      const warns = checkUsageWarnings(stats);
      setUsageWarnings(warns);
      if (warns.length > 0) setWarnDismissed(false);
    } catch {
      if (!silent) setUsageStats(null);
    } finally {
      if (!silent) setUsageLoading(false);
    }
  }

  async function openUsage() {
    setScreen("usage");
    await loadUsageStats();
  }

  async function onEditItem(item: LibraryItem) {
    try {
      const detail = await getItem(item.id);
      if (!detail.originalUrl) {
        showToast("Mục này không có ảnh gốc để sửa");
        return;
      }
      const dataUrl = await fetchAsDataUrl(detail.originalUrl);
      setEditId(item.id);
      setInitialAnnotations(detail.annotations);
      setEditTitle(detail.title ?? "");
      setImage(dataUrl);
      setScreen("editor");
    } catch (err) {
      showToast("Không mở được để sửa: " + String(err));
    }
  }

  async function onDeleteItem(id: string) {
    return new Promise<void>((resolve) => {
      setConfirm({
        message: "Xoá nội dung này? Không thể hoàn tác.",
        onConfirm: async () => {
          setConfirm(null);
          try {
            await deleteItem(id);
            setLibItems((prev) => prev.filter((x) => x.id !== id));
            pruneImgVersion(id);
            showToast("Đã xoá");
          } catch (err) {
            showToast("Xoá lỗi: " + String(err));
          }
          resolve();
        },
      });
    });
  }

  // Xoá nhiều mục cùng lúc. Trả về true nếu đã xoá (xác nhận), false nếu huỷ.
  async function onBulkDelete(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return false;
    return new Promise<boolean>((resolve) => {
      setConfirm({
        message: `Xoá ${ids.length} nội dung đã chọn? Không thể hoàn tác.`,
        onCancel: () => resolve(false),
        onConfirm: async () => {
          setConfirm(null);
          const results = await Promise.allSettled(ids.map((id) => deleteItem(id)));
          const okIds = ids.filter((_, i) => results[i].status === "fulfilled");
          const failed = ids.length - okIds.length;
          if (okIds.length) {
            const okSet = new Set(okIds);
            setLibItems((prev) => prev.filter((x) => !okSet.has(x.id)));
            setImgVersions((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const id of okIds) if (id in next) { delete next[id]; changed = true; }
              if (changed) { try { localStorage.setItem(IMG_VER_KEY, JSON.stringify(next)); } catch {} }
              return changed ? next : prev;
            });
          }
          showToast(failed > 0 ? `Đã xoá ${okIds.length}, lỗi ${failed}` : `Đã xoá ${okIds.length} mục`);
          resolve(true);
        },
      });
    });
  }

  async function onSaveTitle(id: string, title: string) {
    // Cập nhật ngay trên giao diện (optimistic)
    setLibItems((prev) => prev.map((x) => (x.id === id ? { ...x, title: title || null } : x)));
    try {
      await updateTitle(id, title);
      showToast("Đã đổi tiêu đề");
    } catch (err) {
      showToast("Đổi tiêu đề lỗi: " + String(err));
      await openLibrary(); // tải lại nếu lỗi để đồng bộ
    }
  }

  async function copyUrl(url: string) {
    await writeText(url);
    showToast("Đã copy link");
  }

  async function saveVideoTitle() {
    if (!resultId) return;
    try {
      await updateTitle(resultId, videoTitle.trim());
      setTitleSaved(true);
      showToast("Đã lưu tiêu đề");
    } catch (err) {
      showToast("Lưu tiêu đề lỗi: " + String(err));
    }
  }

  // Lưu ngay mỗi lần đổi một phím (màn Cài đặt không còn nút Lưu). Trả về false khi không
  // lưu được để ô phím bên đó tự trả về giá trị cũ, và KHÔNG rời màn hình — người dùng
  // đang đổi dở các phím khác.
  async function onSaveShortcuts(capture: string, record: string, region: string, pause: string, regionRecord: string): Promise<boolean> {
    // H8: các phím tắt phải KHÁC nhau. Nếu trùng, khi Rust đăng ký sẽ lỗi giữa chừng
    // (sau khi đã gỡ hết phím cũ) → mọi phím tắt toàn cục chết tới khi khởi động lại.
    // Màn Cài đặt đã tự hoán đổi khi trùng, đây là lớp chặn cuối trước khi gọi Rust.
    const entries: [string, string][] = [["Chụp", capture], ["Quay", record], ["Chụp vùng", region], ["Tạm dừng", pause], ["Quay vùng", regionRecord]];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[i][1] === entries[j][1]) {
          showToast(`Phím tắt trùng: "${entries[i][0]}" và "${entries[j][0]}" cùng là ${prettyKey(entries[i][1])}`);
          return false;
        }
      }
    }
    try {
      await invoke("set_shortcuts", { capture, record, region, pause, regionRecord });
      const cfg = { capture, record, region, pause, regionRecord };
      setShortcuts(cfg);
      localStorage.setItem("shortcuts", JSON.stringify(cfg));
      showToast("Đã lưu phím tắt");
      return true;
    } catch (err) {
      showToast("Lưu phím tắt lỗi: " + String(err));
      return false;
    }
  }

  // Lưu mức chất lượng. Trả về false để màn Cài đặt trả ô về giá trị cũ khi lưu hỏng —
  // không được hiện mức mà thực tế chưa có hiệu lực.
  async function onSaveQuality(image: number, video: number): Promise<boolean> {
    try {
      await invoke("set_quality", { image, video });
      setQuality({ image, video });
      showToast("Đã lưu chất lượng");
      return true;
    } catch (err) {
      showToast("Lưu chất lượng lỗi: " + String(err));
      return false;
    }
  }

  function backHome() {
    // Xoá file video tạm nếu user bỏ qua không lưu
    if (videoPendingRef.current) {
      invoke("remove_temp", { path: videoPendingRef.current.path }).catch(() => {});
      videoPendingRef.current = null;
    }
    setVideoPendingReady(false);
    setImage(null);
    setEditId(null);
    setInitialAnnotations(null);
    openLibrary();
  }

  async function handleLogout() {
    await logout();
    setUser(null);
    // Dọn dữ liệu phiên cũ khỏi giao diện
    setLibItems([]);
    setUsageStats(null);
    setUsageWarnings([]);
    setStorage(null);
    setOrphan(null);
    setScreen("library");
  }

  const QrModal = qrResult !== null ? (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
    }}>
      <div style={{
        background: "#1c1c1e", color: "#fff", borderRadius: 14, padding: "22px 24px",
        width: 400, maxWidth: "90vw", boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}>
        {!qrResult.found ? (
          <>
            <h3 style={{ margin: "0 0 12px" }}>Không phát hiện mã QR</h3>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button onClick={() => setQrResult(null)}>Đóng</button>
            </div>
          </>
        ) : (
          <>
            <h3 style={{ margin: "0 0 10px" }}>Mã QR</h3>
            <div style={{
              background: "#000", borderRadius: 8, padding: "10px 12px",
              marginBottom: 14, wordBreak: "break-all", fontSize: 13,
              maxHeight: 150, overflow: "auto", lineHeight: 1.5,
            }}>
              {qrResult.text}
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              {qrResult.isUrl && (
                <>
                  <button className="primary" onClick={() => openUrl(qrResult.text)}>
                    Mở trên trình duyệt
                  </button>
                  <button onClick={() => { writeText(qrResult.text); showToast("Đã copy link"); setQrResult(null); }}>
                    Copy link
                  </button>
                </>
              )}
              {!qrResult.isUrl && (
                <button onClick={() => { writeText(qrResult.text); showToast("Đã copy"); setQrResult(null); }}>
                  Copy
                </button>
              )}
              <button onClick={() => setQrResult(null)}>Đóng</button>
            </div>
          </>
        )}
      </div>
    </div>
  ) : null;


  // Thanh tiến độ tải bộ quay video (ffmpeg) — chỉ hiện khi đang tải lần đầu.
  const DownloadOverlay = ffmpegDl !== null ? (
    <div className="dl-banner">
      <div className="dl-banner-head">
        <span>⬇️ Đang tải bộ quay video (chỉ lần đầu)</span>
        <span className="dl-banner-pct">{ffmpegDl >= 0 ? `${ffmpegDl}%` : "…"}</span>
      </div>
      <div className="dl-bar">
        <div
          className={`dl-bar-fill${ffmpegDl < 0 ? " dl-bar-fill--indeterminate" : ""}`}
          style={ffmpegDl >= 0 ? { width: `${ffmpegDl}%` } : undefined}
        />
      </div>
    </div>
  ) : null;

  const ConfirmOverlay = confirm ? (
    <ConfirmModal
      message={confirm.message}
      confirmLabel={confirm.confirmLabel}
      icon={confirm.icon}
      danger={confirm.danger}
      onConfirm={confirm.onConfirm}
      onCancel={() => { confirm.onCancel?.(); setConfirm(null); }}
    />
  ) : null;

  // Đặt cùng cấp với ConfirmOverlay để nổi trên mọi màn hình, không bị trôi theo vùng cuộn.
  const ProgressOverlay = archiveProgress ? (
    <ProgressModal
      title={archiveProgress.title}
      done={archiveProgress.done}
      total={archiveProgress.total}
      label={archiveProgress.label}
      bytesDone={archiveProgress.bytesDone}
      bytesTotal={archiveProgress.bytesTotal}
    />
  ) : null;

  const UpdateOverlay = update && !updateDismissed ? (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
    }}>
      <div style={{
        background: "#1c1c1e", color: "#fff", borderRadius: 14, padding: "22px 24px",
        width: 380, maxWidth: "90vw", boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}>
        <h3 style={{ margin: "0 0 8px" }}>🔔 Có bản cập nhật mới</h3>
        <p style={{ margin: "0 0 10px", fontSize: 14, opacity: 0.85 }}>
          Phiên bản <b>{update.version}</b> đã sẵn sàng.
        </p>
        {update.body && (
          <pre style={{
            whiteSpace: "pre-wrap", fontSize: 12.5, background: "#000", borderRadius: 8,
            padding: "10px 12px", maxHeight: 140, overflow: "auto", margin: "0 0 14px",
          }}>{update.body}</pre>
        )}
        {updateProgress === null ? (
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => setUpdateDismissed(true)}>Để sau</button>
            <button className="primary" onClick={runUpdate}>Cập nhật ngay</button>
          </div>
        ) : (
          <div>
            <div style={{ height: 8, background: "#333", borderRadius: 4, overflow: "hidden" }}>
              <div style={{
                width: `${Math.round(updateProgress * 100)}%`, height: "100%",
                background: "#3b82f6", transition: "width 0.2s",
              }}/>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 13, opacity: 0.8 }}>
              Đang tải bản cập nhật… {Math.round(updateProgress * 100)}%
            </p>
          </div>
        )}
      </div>
    </div>
  ) : null;

  // Chưa kiểm tra xong phiên đăng nhập → chưa vẽ gì (tránh nháy màn hình đăng nhập)
  if (!authChecked) return null;

  // Chưa đăng nhập → hiện màn hình đăng nhập / đăng ký
  if (!user) {
    return <AuthScreen onAuthed={(u) => setUser(u)} />;
  }

  if (screen === "editor" && image) {
    return (
      <>
        <EditorScreen
          key={editId ?? image ?? "editor"}
          imageDataUrl={image}
          initialAnnotations={initialAnnotations}
          initialTitle={editTitle}
          onBack={editId ? openLibrary : backHome}
          onSaved={handleSaved}
          imageQuality={quality.image}
        />

        {DownloadOverlay}
        {ProgressOverlay}
        {ConfirmOverlay}
        {UpdateOverlay}
        {QrModal}
      </>
    );
  }

  const toggleRecord = () => invoke("toggle_recording_cmd").catch(() => {});

  if (screen === "library" || screen === "usage" || screen === "settings" || screen === "data") {
    return (
      <div className="lib-layout">
        {toast && <div className="toast">{toast}</div>}

        {DownloadOverlay}
        {ProgressOverlay}
        {ConfirmOverlay}
        {UpdateOverlay}
        {QrModal}
        <GlobalSidebar
          screen={screen}
          onHome={backHome}
          onCapture={manualCapture}
          onRegionCapture={manualRegionCapture}
          onQrScan={triggerQrScan}
          onRecord={toggleRecord}
          onRegionRecord={manualRegionRecord}
          onData={openData}
          onUsage={openUsage}
          onSettings={() => setScreen("settings")}
          recording={recording}
          usageWarnings={usageWarnings}
        />
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {/* Banner cảnh báo giới hạn Cloudflare */}
          {usageWarnings.length > 0 && !warnDismissed && screen !== "usage" && (
            <div style={{
              background: "#fff7ed", borderBottom: "1px solid #fed7aa",
              padding: "10px 20px", display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0,
            }}>
              <span style={{ fontSize: 16, lineHeight: 1.4 }}>⚠️</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#c2410c" }}>Sắp đạt giới hạn Cloudflare miễn phí — </span>
                <span style={{ fontSize: 12.5, color: "#9a3412" }}>{usageWarnings.join(" · ")}</span>
              </div>
              <button
                onClick={() => setWarnDismissed(true)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#c2410c", fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                title="Đóng"
              >✕</button>
            </div>
          )}
          {screen === "library" && (
            <>
              {recording && (
                <div className={"rec-banner" + (recordPaused ? " paused" : "") + (recordSeconds >= VIDEO_WARN_SECONDS ? " warn" : "")}>
                  {recordPaused ? (
                    <>⏸ Đã tạm dừng {fmtTime(recordSeconds)}/{fmtTime(MAX_RECORD_SECONDS)} — nhấn <kbd>{prettyKey(shortcuts.pause)}</kbd> để quay tiếp · <kbd>{prettyKey(shortcuts.record)}</kbd> để dừng</>
                  ) : (
                    <>● Đang quay {fmtTime(recordSeconds)}/{fmtTime(MAX_RECORD_SECONDS)} — nhấn <kbd>{prettyKey(shortcuts.pause)}</kbd> để tạm dừng · <kbd>{prettyKey(shortcuts.record)}</kbd> để dừng</>
                  )}
                  {!recordPaused && recordSeconds >= VIDEO_WARN_SECONDS && ` ⚠️ tự động dừng ở ${fmtTime(MAX_RECORD_SECONDS)}`}
                </div>
              )}
              {error && <p className="error" style={{ margin: "0.5rem 1.5rem 0" }}>Lỗi: {error}</p>}
              <LibraryScreen
                items={displayItems}
                loading={libLoading}
                error={libError}
                onRefresh={openLibrary}
                onCopy={copyUrl}
                onOpen={(u) => openUrl(u)}
                onDelete={onDeleteItem}
                onBulkDelete={onBulkDelete}
                onEdit={onEditItem}
                onSaveTitle={onSaveTitle}
              />
            </>
          )}
          {screen === "usage" && (
            <UsageScreen
              stats={usageStats}
              daily={dailyUsage}
              loading={usageLoading}
              onRefresh={openUsage}
            />
          )}
          {screen === "data" && (
            <DataScreen
              overview={storage}
              loading={storageLoading}
              error={storageError}
              orphan={orphan}
              syncing={syncing}
              onRefresh={handleRefreshStorage}
              onPurgeOrphans={handlePurgeOrphans}
              onPurgeRange={handlePurgeRange}
              onPurgeIds={handlePurgeIds}
              onArchiveItems={handleArchiveItems}
              onRestore={handleRestore}
              progress={archiveProgress}
              archiveStores={archiveStores}
              device={device}
              dirStates={dirStates}
              onOpenArchiveDir={handleOpenArchiveDir}
              onForgetArchiveStore={forgetArchiveStore}
              onRefreshArchives={loadArchiveStores}
            />
          )}
          {screen === "settings" && (
            <SettingsScreen
              capture={shortcuts.capture}
              record={shortcuts.record}
              region={shortcuts.region}
              pause={shortcuts.pause}
              regionRecord={shortcuts.regionRecord}
              onSave={onSaveShortcuts}
              imageQuality={quality.image}
              videoQuality={quality.video}
              captureSizes={captureSizes}
              onSaveQuality={onSaveQuality}
              onBack={backHome}
              onCheckUpdate={manualCheckUpdate}
              updateChecking={updateChecking}
              userEmail={user.email}
              onLogout={handleLogout}
            />
          )}
        </div>
      </div>
    );
  }

  if (screen === "result") {
    return (
      <main className="container">
        {toast && <div className="toast">{toast}</div>}

        {DownloadOverlay}
        {ProgressOverlay}
        {ConfirmOverlay}
        {UpdateOverlay}
        {QrModal}
        <div className="topbar">
          <span className="badge">
            {uploading ? "Đang tải lên…" : uploadError ? "Lỗi" : videoPendingReady ? "Chưa lưu" : "Đã lưu ✓"}
          </span>
          <button onClick={backHome}>← Về trang chính</button>
        </div>

        {videoPendingReady && !uploading && (
          <div className="linkbar">
            <input
              ref={videoTitleInputRef}
              className="link-input"
              type="text"
              placeholder="Tiêu đề video (không bắt buộc)"
              value={videoTitle}
              onChange={(e) => setVideoTitle(e.target.value)}
            />
            <button className="primary" onClick={saveVideo}>💾 Lưu lên server</button>
            <button onClick={saveVideoLocal}>💻 Lưu vào máy</button>
            <button style={{ color: "#dc2626", borderColor: "#fca5a5" }} onClick={backHome}>🗑 Huỷ</button>
          </div>
        )}

        {videoPendingReady && !uploading && videoDuration > 0 && (() => {
          const dur = videoDuration || 1;
          const startPct = Math.max(0, Math.min(100, (trimStart / dur) * 100));
          const endPct = Math.max(0, Math.min(100, (trimEnd / dur) * 100));
          const isFull = trimStart <= 0.05 && trimEnd >= videoDuration - 0.05;
          return (
            <div className="trimmer">
              <div className="trimmer-head">
                <span className="trim-chip">▶ {fmtTime(Math.floor(trimStart))}</span>
                <span className="trim-chip end">⏹ {fmtTime(Math.floor(trimEnd))}</span>
                <span className="trim-keep">✂ Giữ {fmtTime(Math.floor(trimEnd - trimStart))} / {fmtTime(Math.floor(videoDuration))}</span>
                <span className="trim-spacer" />
                <button
                  className="primary trim-cut"
                  onClick={trimVideo}
                  disabled={trimming || isFull}
                  title={isFull ? "Kéo hai đầu để chọn đoạn cần giữ" : "Cắt video giữ đúng đoạn đã chọn"}
                >
                  {trimming ? "Đang cắt…" : "✂ Cắt video"}
                </button>
              </div>
              <div className="trim-track-wrap">
                <div className="trim-rail" />
                <div className="trim-sel" style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
                <input
                  type="range" min={0} max={videoDuration} step={0.05} value={trimStart}
                  aria-label="Điểm bắt đầu"
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(parseFloat(e.target.value), trimEnd - 0.2));
                    setTrimStart(v);
                    if (videoElRef.current) videoElRef.current.currentTime = v;
                  }}
                />
                <input
                  type="range" min={0} max={videoDuration} step={0.05} value={trimEnd}
                  aria-label="Điểm kết thúc"
                  onChange={(e) => {
                    const v = Math.min(videoDuration, Math.max(parseFloat(e.target.value), trimStart + 0.2));
                    setTrimEnd(v);
                    if (videoElRef.current) videoElRef.current.currentTime = v;
                  }}
                />
              </div>
            </div>
          );
        })()}

        {link && (
          <div className="linkbar">
            <input
              className="link-input"
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="primary" onClick={() => copyUrl(link)}>
              {copied ? "Đã copy ✓" : "Copy link"}
            </button>
            <button onClick={() => openUrl(link)}>Mở link</button>
            {resultId && !uploading && (
              <button
                style={{ color: "#dc2626", borderColor: "#fca5a5" }}
                onClick={() => setConfirm({
                  message: "Xoá nội dung này? Không thể hoàn tác.",
                  onConfirm: async () => {
                    setConfirm(null);
                    await onDeleteItem(resultId);
                    backHome();
                  },
                })}
              >
                🗑 Xoá
              </button>
            )}
          </div>
        )}
        {/* Video không qua editor → cho đặt tiêu đề ở đây (không bắt buộc) */}
        {link && previewType === "video" && (
          <div className="linkbar">
            <input
              className="link-input"
              type="text"
              placeholder="Tiêu đề video (không bắt buộc)"
              value={videoTitle}
              onChange={(e) => {
                setVideoTitle(e.target.value);
                setTitleSaved(false);
              }}
            />
            <button onClick={saveVideoTitle}>{titleSaved ? "Đã lưu ✓" : "Lưu tiêu đề"}</button>
          </div>
        )}
        {uploading && <p className="hint">Đang tải {previewType === "video" ? "video" : "ảnh"} lên Cloudflare R2…</p>}
        {uploadError && <p className="error">Lỗi: {uploadError}</p>}

        {preview && (
          <div className={previewFull ? "preview preview--full" : "preview"}>
            {previewType === "video" ? (
              <video
                ref={videoElRef}
                src={preview}
                controls
                autoPlay
                muted
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (isFinite(d) && d > 0) { setVideoDuration(d); setTrimStart(0); setTrimEnd(d); }
                }}
              />
            ) : (
              <img
                src={preview}
                alt="Ảnh đã gộp khung + note"
                title={previewFull ? "Bấm để thu vừa khung" : "Bấm để xem kích thước thật"}
                onClick={() => setPreviewFull((v) => !v)}
              />
            )}
          </div>
        )}
      </main>
    );
  }

  return null;
}

export default App;
