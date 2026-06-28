import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readFile } from "@tauri-apps/plugin-fs";
import { EditorScreen } from "./screens/EditorScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import {
  uploadImage,
  uploadVideo,
  listItems,
  deleteItem,
  getItem,
  updateItem,
  updateTitle,
  fetchAsDataUrl,
  type LibraryItem,
} from "./lib/api";
import type { Annotations } from "./types";
import "./App.css";

type Screen = "home" | "editor" | "result" | "library" | "settings";

const DEFAULT_SHORTCUTS = { capture: "Control+Shift+1", record: "Control+Shift+2" };
const VIDEO_WARN_SECONDS = 120; // cảnh báo khi quay quá 2 phút

function prettyKey(s: string): string {
  return s.replace("Control", "Ctrl").replace("Super", "Win").split("+").join("+");
}
function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState(DEFAULT_SHORTCUTS);

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

  useEffect(() => {
    const subs = [
      listen<string>("image-captured", (e) => {
        setError(null);
        setEditId(null);
        setInitialAnnotations(null);
        setEditTitle("");
        setImage(e.payload);
        setScreen("editor");
      }),
      listen<string>("capture-error", (e) => setError(e.payload)),
      listen("recording-started", () => setRecording(true)),
      listen("recording-stopped", () => setRecording(false)),
      listen<string>("video-ready", (e) => handleVideoReady(e.payload)),
      listen<string>("video-error", (e) => {
        setRecording(false);
        setScreen("result");
        setUploading(false);
        setUploadError(e.payload);
      }),
    ];
    return () => subs.forEach((p) => p.then((f) => f()));
  }, []);

  // Tải phím tắt đã lưu và áp dụng khi mở app
  useEffect(() => {
    try {
      const saved = localStorage.getItem("shortcuts");
      const cfg = saved ? JSON.parse(saved) : DEFAULT_SHORTCUTS;
      setShortcuts(cfg);
      invoke("set_shortcuts", { capture: cfg.capture, record: cfg.record }).catch(() => {});
    } catch {}
  }, []);

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

  function resetResult() {
    setLink(null);
    setUploadError(null);
    setCopied(false);
    setPreview(null);
    setResultId(null);
    setVideoTitle("");
    setTitleSaved(false);
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
    setScreen("result");
    resetResult();
    setPreviewType("video");
    setUploading(true);
    try {
      const bytes = await readFile(path);
      const blob = new Blob([bytes], { type: "video/mp4" });
      setPreview(URL.createObjectURL(blob));
      const { id, url } = await uploadVideo(blob);
      setResultId(id);
      setLink(url);
      try {
        await writeText(url);
        setCopied(true);
      } catch {}
      // Dọn file video tạm sau khi upload xong
      invoke("remove_temp", { path }).catch(() => {});
    } catch (err) {
      setUploadError(String(err));
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
    if (!window.confirm("Xoá nội dung này? Không thể hoàn tác.")) return;
    try {
      await deleteItem(id);
      setLibItems((prev) => prev.filter((x) => x.id !== id));
      showToast("Đã xoá");
    } catch (err) {
      showToast("Xoá lỗi: " + String(err));
    }
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

  async function onSaveShortcuts(capture: string, record: string) {
    try {
      await invoke("set_shortcuts", { capture, record });
      const cfg = { capture, record };
      setShortcuts(cfg);
      localStorage.setItem("shortcuts", JSON.stringify(cfg));
      showToast("Đã lưu phím tắt");
      setScreen("home");
    } catch (err) {
      showToast("Lưu phím tắt lỗi: " + String(err));
    }
  }

  function backHome() {
    setScreen("home");
    setImage(null);
    setEditId(null);
    setInitialAnnotations(null);
  }

  if (screen === "editor" && image) {
    return (
      <EditorScreen
        imageDataUrl={image}
        initialAnnotations={initialAnnotations}
        initialTitle={editTitle}
        onBack={editId ? openLibrary : backHome}
        onSaved={handleSaved}
      />
    );
  }

  if (screen === "library") {
    return (
      <>
        {toast && <div className="toast">{toast}</div>}
        <LibraryScreen
          items={libItems}
          loading={libLoading}
          error={libError}
          onRefresh={openLibrary}
          onBack={backHome}
          onCopy={copyUrl}
          onOpen={(u) => openUrl(u)}
          onDelete={onDeleteItem}
          onEdit={onEditItem}
          onSaveTitle={onSaveTitle}
        />
      </>
    );
  }

  if (screen === "settings") {
    return (
      <>
        {toast && <div className="toast">{toast}</div>}
        <SettingsScreen
          capture={shortcuts.capture}
          record={shortcuts.record}
          onSave={onSaveShortcuts}
          onBack={() => setScreen("home")}
        />
      </>
    );
  }

  if (screen === "result") {
    return (
      <main className="container">
        {toast && <div className="toast">{toast}</div>}
        <div className="topbar">
          <span className="badge">
            {uploading ? "Đang tải lên…" : uploadError ? "Lỗi" : "Đã lưu ✓"}
          </span>
          <button onClick={backHome}>← Về trang chính</button>
        </div>

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

  // Home
  return (
    <main className="container home">
      {toast && <div className="toast">{toast}</div>}
      {recording && (
        <div className={"rec-banner" + (recordSeconds >= VIDEO_WARN_SECONDS ? " warn" : "")}>
          ● Đang quay {fmtTime(recordSeconds)} — nhấn <kbd>{prettyKey(shortcuts.record)}</kbd> để dừng
          {recordSeconds >= VIDEO_WARN_SECONDS && " ⚠️ video đã khá dài, cân nhắc dừng"}
        </div>
      )}
      <h1>Chụp & chia sẻ</h1>
      <p>Phím tắt toàn cục:</p>
      <p className="keys">
        <kbd>{prettyKey(shortcuts.capture)}</kbd> chụp ảnh &nbsp;•&nbsp;
        <kbd>{prettyKey(shortcuts.record)}</kbd> quay video
      </p>
      <div className="row">
        <button className="primary" onClick={manualCapture}>
          Chụp thử ngay
        </button>
        <button onClick={openLibrary}>Thư viện nội dung</button>
        <button onClick={() => setScreen("settings")}>⚙ Cài đặt</button>
      </div>
      {error && <p className="error">Lỗi: {error}</p>}
      <p className="hint">Đóng cửa sổ này app vẫn chạy nền (xem ở khay hệ thống).</p>
    </main>
  );
}

export default App;
