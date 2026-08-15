// Kho lưu trữ dưới máy: tải nội dung từ cloud về một thư mục người dùng chọn, kèm file
// manifest mô tả từng mục, để sau này khôi phục lại được.
//
// Nguyên tắc an toàn xuyên suốt: CHỈ những mục đã ghi xong xuôi xuống đĩa mới được đưa vào
// danh sách xoá trên cloud. Mục nào tải lỗi thì giữ nguyên trên cloud — thà tốn dung lượng
// còn hơn mất hẳn nội dung.
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getItem, restoreUpload, type StorageItem } from "./api";
import type { Annotations } from "../types";

const MANIFEST = "captureshare-archive.json";

export interface ArchiveEntry {
  /** id cũ trên cloud — chỉ để đối chiếu; khôi phục luôn tạo id mới. */
  id: string;
  type: "image" | "video";
  title: string;
  createdAt: number;
  bytes: number;
  /** Tên file trong thư mục kho (không kèm đường dẫn → di chuyển cả thư mục vẫn dùng được). */
  file: string;
  /** Ảnh gốc chưa gộp annotate, có thì khôi phục mới sửa lại khung/ghi chú được. */
  originalFile?: string;
  annotations?: Annotations | null;
  archivedAt: number;
}

export interface ArchiveFailure {
  id: string;
  title: string;
  error: string;
}

/** Một thư mục kho từng dùng để lưu về máy — app nhớ lại để khỏi phải mò đường dẫn. */
export interface ArchiveDir {
  dir: string;
  /** Lần lưu gần nhất vào thư mục này (epoch ms). */
  savedAt: number;
  /** Số mục trong manifest sau lần lưu đó. */
  items: number;
}

/**
 * Báo tiến độ. Có cả số mục lẫn số byte vì hai thứ này lệch nhau rất xa: một video 16 MB
 * tốn thời gian bằng cả tám chục tấm ảnh. Tính phần trăm theo byte thì thanh tiến độ mới
 * phản ánh đúng thời gian còn lại; số mục chỉ để hiện cho dễ hiểu.
 */
export type ProgressFn = (p: {
  done: number;
  total: number;
  label: string;
  bytesDone: number;
  bytesTotal: number;
}) => void;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Windows cấm \ / : * ? " < > | trong tên file; ký tự điều khiển cũng không hợp lệ.
// Cắt 60 ký tự để đường dẫn tổng không chạm giới hạn 260 ký tự khi thư mục kho nằm sâu.
const FORBIDDEN = '\\/:*?"<>|';
function safeSegment(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch.charCodeAt(0) < 32) continue; // ký tự điều khiển
    if (FORBIDDEN.includes(ch)) continue; // ký tự Windows cấm trong tên file
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Tên file: có ngày giờ để người dùng tự tìm được, có id để không bao giờ trùng nhau. */
function baseName(item: { id: string; title: string | null; createdAt: number }): string {
  const d = new Date(item.createdAt);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const title = safeSegment(item.title || "");
  return title ? `${stamp}_${title}_${item.id}` : `${stamp}_${item.id}`;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Mở hộp thoại chọn thư mục. null = người dùng bấm huỷ. */
export async function pickFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

/** Tên thư mục cuối trong đường dẫn, để hiện cho gọn thay vì cả đường dẫn dài. */
export function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || dir;
}

/**
 * Thư mục kho còn tồn tại không và đang giữ bao nhiêu mục. Chỉ đọc manifest chứ không
 * quét từng file — danh sách kho phải hiện ra tức thì, kiểm tra kỹ để lúc khôi phục.
 */
export async function archiveDirState(dir: string): Promise<{ exists: boolean; items: number }> {
  try {
    const [exists, items] = await invoke<[boolean, number]>("archive_dir_state", { path: dir });
    return { exists, items };
  } catch {
    return { exists: false, items: 0 };
  }
}

/** Mở thư mục kho bằng File Explorer. */
export async function openArchiveDir(dir: string): Promise<void> {
  await invoke("archive_open_dir", { path: dir });
}

/** Tên máy hiện tại — sổ kho trên cloud dùng nó để phân biệt kho của máy nào. */
export async function deviceName(): Promise<string> {
  try {
    return await invoke<string>("device_name");
  } catch {
    return "Máy không rõ tên";
  }
}

/** Toàn bộ manifest của một thư mục kho, để đẩy lên sổ trên cloud. */
export async function readArchiveManifest(dir: string): Promise<ArchiveEntry[]> {
  return readManifest(dir);
}

async function readManifest(dir: string): Promise<ArchiveEntry[]> {
  try {
    const text = await invoke<string>("archive_read_text", { path: joinPath(dir, MANIFEST) });
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.items) ? (parsed.items as ArchiveEntry[]) : [];
  } catch {
    return []; // chưa có manifest (thư mục mới) — không phải lỗi
  }
}

// Gộp vào manifest sẵn có thay vì ghi đè: người dùng có thể lưu nhiều đợt vào cùng một
// thư mục, ghi đè sẽ làm các đợt trước thành file mồ côi không khôi phục được.
async function writeManifest(dir: string, added: ArchiveEntry[]): Promise<number> {
  const byId = new Map<string, ArchiveEntry>();
  for (const e of await readManifest(dir)) byId.set(e.id, e);
  for (const e of added) byId.set(e.id, e);
  const body = { app: "CaptureShare", version: 1, items: [...byId.values()] };
  await invoke("archive_write_text", {
    path: joinPath(dir, MANIFEST),
    text: JSON.stringify(body, null, 2),
  });
  return byId.size;
}

/**
 * Tải các mục về thư mục kho. KHÔNG xoá gì trên cloud — bên gọi tự quyết định xoá,
 * và chỉ được xoá đúng những id nằm trong `saved`.
 */
export async function archiveItems(
  dir: string,
  items: StorageItem[],
  onProgress: ProgressFn
): Promise<{ saved: ArchiveEntry[]; failed: ArchiveFailure[]; folderTotal: number }> {
  const saved: ArchiveEntry[] = [];
  const failed: ArchiveFailure[] = [];
  let folderTotal = 0;

  // Mục chưa rõ dung lượng vẫn phải chiếm một phần thanh tiến độ, không thì thanh nhảy
  // giật cục mỗi lần gặp chúng. 1 MB là ước lượng thô nhưng đủ dùng.
  const guess = (b: number | null | undefined) => b ?? 1_000_000;
  const bytesTotal = items.reduce((s, it) => s + guess(it.bytes), 0);
  let bytesDone = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const label = it.title || "(không tiêu đề)";
    onProgress({ done: i, total: items.length, label, bytesDone, bytesTotal });
    try {
      const base = baseName(it);
      const file = `${base}.${it.type === "video" ? "mp4" : "webp"}`;
      const bytes = await invoke<number>("archive_save", {
        url: it.fileUrl,
        dest: joinPath(dir, file),
      });

      // Ảnh còn có bản gốc + dữ liệu annotate nằm trong database, không nằm trong file.
      // Không lấy về thì khôi phục xong sẽ mất khả năng sửa lại khung/ghi chú.
      let originalFile: string | undefined;
      let annotations: Annotations | null = null;
      if (it.type === "image") {
        const detail = await getItem(it.id);
        annotations = detail.annotations;
        if (detail.hasOriginal && detail.originalUrl) {
          originalFile = `${base}_goc.webp`;
          await invoke("archive_save", { url: detail.originalUrl, dest: joinPath(dir, originalFile) });
        }
      }

      saved.push({
        id: it.id,
        type: it.type,
        title: it.title || "",
        createdAt: it.createdAt,
        bytes: bytes || it.bytes || 0,
        file,
        originalFile,
        annotations,
        archivedAt: Date.now(),
      });
    } catch (err) {
      failed.push({ id: it.id, title: label, error: String(err) });
    }
    // Cộng cả khi mục lỗi: nó đã tiêu tốn thời gian rồi, và thanh tiến độ phải chạy tới
    // cùng chứ không được đứng lại ở 87% vì vài mục hỏng.
    bytesDone += guess(it.bytes);
  }
  onProgress({ done: items.length, total: items.length, label: "", bytesDone: bytesTotal, bytesTotal });

  // Ghi manifest kể cả khi có mục lỗi — phần đã tải về vẫn phải khôi phục được.
  if (saved.length > 0) folderTotal = await writeManifest(dir, saved);
  return { saved, failed, folderTotal };
}

export interface ArchiveScan {
  entries: ArchiveEntry[];
  /** Mục có trong manifest nhưng file đã bị xoá/đổi tên → không khôi phục được. */
  missing: ArchiveEntry[];
}

/** Đọc kho trong thư mục và đối chiếu xem file còn đủ không. */
export async function scanArchive(dir: string): Promise<ArchiveScan> {
  const all = await readManifest(dir);
  const entries: ArchiveEntry[] = [];
  const missing: ArchiveEntry[] = [];
  for (const e of all) {
    const size = await invoke<number | null>("archive_file_size", { path: joinPath(dir, e.file) });
    if (size && size > 0) entries.push(e);
    else missing.push(e);
  }
  return { entries, missing };
}

async function readBlob(dir: string, name: string, mime: string): Promise<Blob> {
  const buf = await invoke<ArrayBuffer>("archive_read_file", { path: joinPath(dir, name) });
  return new Blob([buf], { type: mime });
}

/**
 * Tải các mục trong kho trở lại cloud, xin lại đúng id cũ để link chia sẻ cũ sống lại.
 * `keptLinks` là số mục giữ được link cũ; phần còn lại mang link mới vì id đã có chủ
 * (hay gặp nhất: khôi phục cùng một thư mục kho lần thứ hai).
 */
export async function restoreEntries(
  dir: string,
  entries: ArchiveEntry[],
  onProgress: ProgressFn
): Promise<{ restored: number; keptLinks: number; failed: ArchiveFailure[] }> {
  let restored = 0;
  let keptLinks = 0;
  const failed: ArchiveFailure[] = [];

  const bytesTotal = entries.reduce((s, e) => s + (e.bytes || 1_000_000), 0);
  let bytesDone = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const label = e.title || "(không tiêu đề)";
    onProgress({ done: i, total: entries.length, label, bytesDone, bytesTotal });
    try {
      const mime = e.type === "video" ? "video/mp4" : "image/webp";
      const file = await readBlob(dir, e.file, mime);
      const original = e.originalFile ? await readBlob(dir, e.originalFile, "image/webp") : null;
      const r = await restoreUpload({
        id: e.id,
        file,
        original,
        type: e.type,
        title: e.title,
        annotations: e.annotations ?? null,
        createdAt: e.createdAt,
      });
      restored += 1;
      if (r.keptId) keptLinks += 1;
    } catch (err) {
      failed.push({ id: e.id, title: label, error: String(err) });
    }
    bytesDone += e.bytes || 1_000_000;
  }
  onProgress({ done: entries.length, total: entries.length, label: "", bytesDone: bytesTotal, bytesTotal });
  return { restored, keptLinks, failed };
}
