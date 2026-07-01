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
import { UsageScreen } from "./screens/UsageScreen";
import {
  uploadImage,
  uploadVideo,
  listItems,
  deleteItem,
  getItem,
  updateItem,
  updateTitle,
  fetchAsDataUrl,
  calcStats,
  type LibraryItem,
  type UsageStats,
} from "./lib/api";
import type { Annotations } from "./types";
import { checkForUpdate, applyUpdate, type Update } from "./lib/updater";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import "./App.css";

type Screen = "home" | "editor" | "result" | "library" | "settings" | "usage";

const DEFAULT_SHORTCUTS = { capture: "Control+Shift+1", record: "Control+Shift+2", region: "Control+Shift+3" };
const VIDEO_WARN_SECONDS = 120; // cảnh báo khi quay quá 2 phút

const SidebarS = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none" as const, stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const USAGE_LIMITS = {
  r2StorageMB: 10 * 1024, r2ClassAPerMonth: 1_000_000, r2ClassBPerMonth: 10_000_000,
  d1StorageMB: 500, d1RowsReadPerDay: 5_000_000, d1RowsWritePerDay: 100_000, workersReqPerDay: 100_000,
};

function checkUsageWarnings(stats: UsageStats): string[] {
  const s = stats;
  const estR2MB   = s.estimatedMB;
  const estOpsA   = s.totalItems * 2;
  const estOpsB   = s.totalItems * 10;
  const estD1MB   = s.totalItems * 0.002;
  const estD1R    = s.totalItems * 5;
  const estWrkDay = Math.round(s.totalItems * 12 / 30);
  const warns: string[] = [];
  if (estR2MB   / USAGE_LIMITS.r2StorageMB      >= 0.9) warns.push(`R2 Storage đạt ${((estR2MB/USAGE_LIMITS.r2StorageMB)*100).toFixed(0)}% (giới hạn 10 GB)`);
  if (estOpsA   / USAGE_LIMITS.r2ClassAPerMonth  >= 0.9) warns.push(`R2 Write ops đạt ${((estOpsA/USAGE_LIMITS.r2ClassAPerMonth)*100).toFixed(0)}% (giới hạn 1M/tháng)`);
  if (estOpsB   / USAGE_LIMITS.r2ClassBPerMonth  >= 0.9) warns.push(`R2 Read ops đạt ${((estOpsB/USAGE_LIMITS.r2ClassBPerMonth)*100).toFixed(0)}% (giới hạn 10M/tháng)`);
  if (estD1MB   / USAGE_LIMITS.d1StorageMB       >= 0.9) warns.push(`D1 Storage đạt ${((estD1MB/USAGE_LIMITS.d1StorageMB)*100).toFixed(0)}% (giới hạn 500 MB)`);
  if (estD1R    / USAGE_LIMITS.d1RowsReadPerDay  >= 0.9) warns.push(`D1 Rows read đạt ${((estD1R/USAGE_LIMITS.d1RowsReadPerDay)*100).toFixed(0)}% (giới hạn 5M/ngày)`);
  if (estWrkDay / USAGE_LIMITS.workersReqPerDay  >= 0.9) warns.push(`Workers Requests đạt ${((estWrkDay/USAGE_LIMITS.workersReqPerDay)*100).toFixed(0)}% (giới hạn 100K/ngày)`);
  return warns;
}

function GlobalSidebar({ screen, onHome, onCapture, onRegionCapture, onQrScan, onRecord, onUsage, onSettings, recording, usageWarnings }: {
  screen: Screen; onHome: () => void; onCapture: () => void; onRegionCapture: () => void; onQrScan: () => void; onRecord: () => void;
  onUsage: () => void; onSettings: () => void; recording: boolean; usageWarnings: string[];
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
      <div className="lib-spacer"/>
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
function loadImgVersions(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(IMG_VER_KEY) || "{}"); } catch { return {}; }
}
function busted(url: string, v?: number): string {
  if (!v) return url;
  return `${url}${url.includes("?") ? "&" : "?"}cb=${v}`;
}

function App() {
  const [screen, setScreen] = useState<Screen>("library");
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [ffmpegDl, setFfmpegDl] = useState<number | null>(null); // null=không tải, -1=không rõ %, 0..100=phần trăm
  // recPopup đã bỏ — thông báo quay được chuyển sang toast hệ thống (Rust)
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void; onCancel?: () => void } | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageWarnings, setUsageWarnings] = useState<string[]>([]);
  const [warnDismissed, setWarnDismissed] = useState(false);
  const [shortcuts, setShortcuts] = useState(DEFAULT_SHORTCUTS);

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
  const [uploading, setUploading] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Thư viện
  const [libItems, setLibItems] = useState<LibraryItem[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);
  const [imgVersions, setImgVersions] = useState<Record<string, number>>(loadImgVersions);

  const screenRef = useRef<Screen>("library");
  useEffect(() => { screenRef.current = screen; }, [screen]);

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
      listen<string>("image-captured", (e) => {
        if (qrModeRef.current) {
          qrModeRef.current = false;
          decodeQr(e.payload);
          return;
        }
        setError(null);
        setEditId(null);
        setInitialAnnotations(null);
        setEditTitle("");
        setImage(e.payload);
        setScreen("editor");
      }),
      listen("region-cancelled", () => { qrModeRef.current = false; }),
      listen<string>("capture-error", (e) => setError(e.payload)),
      listen("recording-started", () => { setRecording(true); }),
      listen("recording-stopped", () => { setRecording(false); }),
      listen<string>("video-ready", (e) => videoReadyHandlerRef.current(e.payload)),
      listen<string>("video-error", (e) => {
        setRecording(false);
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

  // Tải phím tắt đã lưu và áp dụng khi mở app + load thư viện ngay
  useEffect(() => {
    try {
      const saved = localStorage.getItem("shortcuts");
      const cfg = { ...DEFAULT_SHORTCUTS, ...(saved ? JSON.parse(saved) : {}) };
      setShortcuts(cfg);
      invoke("set_shortcuts", { capture: cfg.capture, record: cfg.record, region: cfg.region }).catch(() => {});
    } catch {}
    openLibrary();
    loadUsageStats(true); // load thầm lặng để hiện badge cảnh báo ngay từ đầu
  }, []);

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
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveVideoRef.current(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
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
    const t = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

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
  // Gắn ?cb cho ảnh từng sửa để hiện đúng ảnh mới (video không cần)
  const displayItems = libItems.map((it) =>
    it.type === "image" && imgVersions[it.id]
      ? { ...it, fileUrl: busted(it.fileUrl, imgVersions[it.id]) }
      : it
  );

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
  }

  function manualRegionCapture() {
    invoke("start_region_capture").catch(() => {});
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

  function decodeQr(dataUrl: string) {
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
    setLibLoading(true);
    setLibError(null);
    try {
      setLibItems(await listItems());
    } catch (err) {
      setLibError(String(err));
    } finally {
      setLibLoading(false);
    }
  }

  async function loadUsageStats(silent = false) {
    if (!silent) setUsageLoading(true);
    try {
      const items = await listItems();
      const stats = calcStats(items);
      setUsageStats(stats);
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

  async function onSaveShortcuts(capture: string, record: string, region: string) {
    try {
      await invoke("set_shortcuts", { capture, record, region });
      const cfg = { capture, record, region };
      setShortcuts(cfg);
      localStorage.setItem("shortcuts", JSON.stringify(cfg));
      showToast("Đã lưu phím tắt");
      backHome();
    } catch (err) {
      showToast("Lưu phím tắt lỗi: " + String(err));
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
      onConfirm={confirm.onConfirm}
      onCancel={() => { confirm.onCancel?.(); setConfirm(null); }}
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

  if (screen === "editor" && image) {
    return (
      <>
        <EditorScreen
          imageDataUrl={image}
          initialAnnotations={initialAnnotations}
          initialTitle={editTitle}
          onBack={editId ? openLibrary : backHome}
          onSaved={handleSaved}
        />

        {DownloadOverlay}
        {ConfirmOverlay}
        {UpdateOverlay}
        {QrModal}
      </>
    );
  }

  const toggleRecord = () => invoke("toggle_recording_cmd").catch(() => {});

  if (screen === "library" || screen === "usage" || screen === "settings") {
    return (
      <div className="lib-layout">
        {toast && <div className="toast">{toast}</div>}

        {DownloadOverlay}
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
                <div className={"rec-banner" + (recordSeconds >= VIDEO_WARN_SECONDS ? " warn" : "")}>
                  ● Đang quay {fmtTime(recordSeconds)} — nhấn <kbd>{prettyKey(shortcuts.record)}</kbd> để dừng
                  {recordSeconds >= VIDEO_WARN_SECONDS && " ⚠️ video đã khá dài, cân nhắc dừng"}
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
              loading={usageLoading}
              onRefresh={openUsage}
            />
          )}
          {screen === "settings" && (
            <SettingsScreen
              capture={shortcuts.capture}
              record={shortcuts.record}
              region={shortcuts.region}
              onSave={onSaveShortcuts}
              onBack={backHome}
              onCheckUpdate={manualCheckUpdate}
              updateChecking={updateChecking}
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
          <div className="preview">
            {previewType === "video" ? (
              <video src={preview} controls autoPlay muted />
            ) : (
              <img src={preview} alt="Ảnh đã gộp khung + note" />
            )}
          </div>
        )}
      </main>
    );
  }

  return null;
}

export default App;
