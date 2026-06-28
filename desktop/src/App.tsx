import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readFile } from "@tauri-apps/plugin-fs";
import { EditorScreen } from "./screens/EditorScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import {
  uploadImage,
  uploadVideo,
  listItems,
  deleteItem,
  getItem,
  updateItem,
  fetchAsDataUrl,
  type LibraryItem,
} from "./lib/api";
import type { Annotations } from "./types";
import "./App.css";

type Screen = "home" | "editor" | "result" | "library";

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Sửa annotate
  const [editId, setEditId] = useState<string | null>(null);
  const [initialAnnotations, setInitialAnnotations] = useState<Annotations | null>(null);

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

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }

  function resetResult() {
    setLink(null);
    setUploadError(null);
    setCopied(false);
    setPreview(null);
  }

  async function manualCapture() {
    try {
      const dataUrl = await invoke<string>("capture_screen");
      setError(null);
      setEditId(null);
      setInitialAnnotations(null);
      setImage(dataUrl);
      setScreen("editor");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaved(flattened: Blob, original: Blob, annotations: Annotations) {
    // Đang sửa một mục đã có → cập nhật (PATCH)
    if (editId) {
      try {
        await updateItem(editId, flattened, annotations);
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
      const { url } = await uploadImage(flattened, original, annotations);
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
      const { url } = await uploadVideo(blob);
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

  async function copyUrl(url: string) {
    await writeText(url);
    showToast("Đã copy link");
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
        <div className="rec-banner">● Đang quay màn hình… nhấn <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>2</kbd> để dừng</div>
      )}
      <h1>Chụp & chia sẻ</h1>
      <p>Phím tắt toàn cục:</p>
      <p className="keys">
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd> chụp ảnh &nbsp;•&nbsp;
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>2</kbd> quay video
      </p>
      <div className="row">
        <button className="primary" onClick={manualCapture}>
          Chụp thử ngay
        </button>
        <button onClick={openLibrary}>Thư viện nội dung</button>
      </div>
      {error && <p className="error">Lỗi: {error}</p>}
      <p className="hint">Đóng cửa sổ này app vẫn chạy nền (xem ở khay hệ thống).</p>
    </main>
  );
}

export default App;
