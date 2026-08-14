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

export type ProgressFn = (done: number, total: number, label: string) => void;

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
async function writeManifest(dir: string, added: ArchiveEntry[]): Promise<void> {
  const byId = new Map<string, ArchiveEntry>();
  for (const e of await readManifest(dir)) byId.set(e.id, e);
  for (const e of added) byId.set(e.id, e);
  const body = { app: "CaptureShare", version: 1, items: [...byId.values()] };
  await invoke("archive_write_text", {
    path: joinPath(dir, MANIFEST),
    text: JSON.stringify(body, null, 2),
  });
}

/**
 * Tải các mục về thư mục kho. KHÔNG xoá gì trên cloud — bên gọi tự quyết định xoá,
 * và chỉ được xoá đúng những id nằm trong `saved`.
 */
export async function archiveItems(
  dir: string,
  items: StorageItem[],
  onProgress: ProgressFn
): Promise<{ saved: ArchiveEntry[]; failed: ArchiveFailure[] }> {
  const saved: ArchiveEntry[] = [];
  const failed: ArchiveFailure[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const label = it.title || "(không tiêu đề)";
    onProgress(i, items.length, label);
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
  }
  onProgress(items.length, items.length, "");

  // Ghi manifest kể cả khi có mục lỗi — phần đã tải về vẫn phải khôi phục được.
  if (saved.length > 0) await writeManifest(dir, saved);
  return { saved, failed };
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

/** Tải các mục trong kho trở lại cloud. Mỗi mục thành một nội dung mới (id + link mới). */
export async function restoreEntries(
  dir: string,
  entries: ArchiveEntry[],
  onProgress: ProgressFn
): Promise<{ restored: number; failed: ArchiveFailure[] }> {
  let restored = 0;
  const failed: ArchiveFailure[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const label = e.title || "(không tiêu đề)";
    onProgress(i, entries.length, label);
    try {
      const mime = e.type === "video" ? "video/mp4" : "image/webp";
      const file = await readBlob(dir, e.file, mime);
      const original = e.originalFile ? await readBlob(dir, e.originalFile, "image/webp") : null;
      await restoreUpload({
        file,
        original,
        type: e.type,
        title: e.title,
        annotations: e.annotations ?? null,
        createdAt: e.createdAt,
      });
      restored += 1;
    } catch (err) {
      failed.push({ id: e.id, title: label, error: String(err) });
    }
  }
  onProgress(entries.length, entries.length, "");
  return { restored, failed };
}
