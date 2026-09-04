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
  /**
   * Đường dẫn tương đối tính từ thư mục kho, luôn ghi bằng `/`:
 * `Tháng 8-2026/2026-08-15/….webp`.
   * Tương đối chứ không tuyệt đối → bê cả thư mục kho đi đâu vẫn khôi phục được.
   * Kho lưu từ bản cũ chỉ có tên file phẳng không kèm thư mục; `joinPath` nuốt được cả hai
   * dạng nên manifest cũ vẫn đọc và khôi phục bình thường.
   */
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
// Cắt 60 ký tự để đường dẫn tổng không chạm giới hạn 260 ký tự khi thư mục kho nằm sâu —
// nhớ là còn thư mục nhãn (tối đa 60) và thư mục ngày (11) ăn thêm ~70 ký tự nữa.
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

/**
 * Tên thư mục bọc cả đợt tải, lấy từ nhãn mốc đang hiện trên màn hình ("Tháng 8/2026",
 * "24/08 – 30/08/2026", "15/08/2026").
 *
 * Không dùng `safeSegment` vì nó XOÁ ký tự cấm: "Tháng 9/2026" sẽ thành "Tháng 92026" —
 * đọc ra một con số khác hẳn. Ở đây `/` và `\` phải đổi thành `-` mới giữ đúng nghĩa ngày
 * tháng. Windows còn cấm tên thư mục kết thúc bằng dấu chấm hoặc dấu cách nên phải cắt nốt,
 * và cắt SAU khi giới hạn 60 ký tự (cắt trước thì lát nữa lại lòi ra dấu chấm ở đuôi).
 */
export function archiveFolderName(label: string): string {
  let out = "";
  for (const ch of label) {
    if (ch.charCodeAt(0) < 32) continue; // ký tự điều khiển
    if (ch === "/" || ch === "\\") out += "-";
    else if (!FORBIDDEN.includes(ch)) out += ch;
  }
  out = out.replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "");
  return out || "Khac"; // nhãn toàn ký tự cấm vẫn phải có chỗ mà đổ file vào
}

/** Thư mục con theo ngày tạo của mục: `2026-08-15`. */
function dayFolder(createdAt: number): string {
  const d = new Date(createdAt);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Tên file: có ngày giờ để người dùng tự tìm được, có id để không bao giờ trùng nhau. */
function baseName(item: { id: string; title: string | null; createdAt: number }): string {
  const d = new Date(item.createdAt);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const title = safeSegment(item.title || "");
  return title ? `${stamp}_${title}_${item.id}` : `${stamp}_${item.id}`;
}

function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  // `rel` có thể là đường dẫn nhiều cấp (Tháng 8-2026/2026-08-15/anh.webp) vì manifest luôn
  // ghi bằng `/`. Đổi hết sang dấu phân cách của thư mục gốc rồi mới nối, để khỏi sinh ra
  // đường dẫn lai kiểu D:\DATA\Tháng 8-2026/2026-08-15/anh.webp.
  const path = rel.replace(/[\\/]+/g, sep);
  return dir.endsWith(sep) ? `${dir}${path}` : `${dir}${sep}${path}`;
}

/** Mở hộp thoại chọn thư mục. null = người dùng bấm huỷ. */
export async function pickFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

/** Chọn nhiều thư mục một lượt. Mảng rỗng = người dùng bấm huỷ. */
export async function pickFolders(title: string): Promise<string[]> {
  const picked = await open({ directory: true, multiple: true, title });
  if (Array.isArray(picked)) return picked.filter((d): d is string => typeof d === "string");
  return typeof picked === "string" ? [picked] : [];
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
 *
 * `folder` là nhãn mốc đang hiện trên màn hình; cả đợt tải sẽ nằm gọn trong một thư mục
 * mang tên đó. Bỏ trống thì file đổ thẳng vào thư mục kho như trước.
 */
export async function archiveItems(
  dir: string,
  items: StorageItem[],
  onProgress: ProgressFn,
  folder?: string
): Promise<{ saved: ArchiveEntry[]; failed: ArchiveFailure[]; folderTotal: number }> {
  const saved: ArchiveEntry[] = [];
  const failed: ArchiveFailure[] = [];
  let folderTotal = 0;

  // Mục chưa rõ dung lượng vẫn phải chiếm một phần thanh tiến độ, không thì thanh nhảy
  // giật cục mỗi lần gặp chúng. 1 MB là ước lượng thô nhưng đủ dùng.
  const guess = (b: number | null | undefined) => b ?? 1_000_000;
  const bytesTotal = items.reduce((s, it) => s + guess(it.bytes), 0);
  let bytesDone = 0;

  const root = folder ? archiveFolderName(folder) : "";
  // Chỉ chẻ thêm cấp ngày khi đợt này trải trên nhiều ngày. Tải nguyên tháng 441 mục thì
  // rất cần; tải đúng một ngày mà vẫn đẻ thêm thư mục ngày trùng tên thư mục ngoài thì
  // chỉ tổ lồng nhau vô ích, bấm thêm một nhịp mới thấy file.
  const spansDays = new Set(items.map((it) => dayFolder(it.createdAt))).size > 1;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const label = it.title || "(không tiêu đề)";
    onProgress({ done: i, total: items.length, label, bytesDone, bytesTotal });
    try {
      // Tiền tố thư mục dính luôn vào `base` → file gộp và ảnh gốc chắc chắn nằm cùng chỗ.
      const base = [root, spansDays ? dayFolder(it.createdAt) : "", baseName(it)]
        .filter(Boolean)
        .join("/");
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

/** Thư mục cha, hoặc null khi đã chạm gốc ổ đĩa (`D:`) hay gốc hệ thống (`/`). */
function parentDir(dir: string): string | null {
  const norm = dir.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  if (cut <= 0) return null;
  const parent = norm.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? null : parent || null;
}

/** Đường đi từ `root` xuống `dir`, viết bằng `/` để so khớp thẳng với `file` trong manifest. */
function relFrom(root: string, dir: string): string {
  const r = root.replace(/[\\/]+$/, "");
  const d = dir.replace(/[\\/]+$/, "");
  return d.slice(r.length).replace(/^[\\/]+/, "").replace(/[\\/]+/g, "/");
}

/** Gốc kho (nơi có manifest) và phần thư mục con mà người dùng thực sự chỉ vào. */
export interface ArchiveRoot {
  root: string;
  /** Rỗng = họ chọn thẳng gốc kho, khôi phục tất cả. */
  prefix: string;
}

// Đi ngược tối đa mấy cấp để tìm manifest. Cấu trúc sâu nhất hiện nay là
// <gốc kho>/<nhãn mốc>/<ngày>/ nên 3 cấp là đủ; để rộng thêm một nhịp cho chắc.
const MAX_WALK_UP = 4;

/**
 * Nhận diện thư mục người dùng chọn. Chọn thẳng gốc kho thì trả về chính nó; chọn một thư
 * mục mốc bên trong (`D:\DATA\27-07 – 02-08-2026`) thì đi ngược lên tìm manifest
 * ở `D:\DATA` rồi nhớ lại phần đường còn thừa, để chỉ khôi phục đúng nội dung
 * nằm trong thư mục họ chỉ vào.
 *
 * Có bước này vì manifest CỐ TÌNH chỉ có một bản ở gốc kho: nhiều đợt lưu gộp chung một sổ
 * thì mới biết được thư mục đang giữ tổng cộng những gì. Không dò ngược thì người dùng chọn
 * đúng thư mục mốc lại bị báo "không phải kho lưu trữ" — đúng thư mục app vừa tự tạo ra.
 */
export async function resolveArchiveRoot(dir: string): Promise<ArchiveRoot | null> {
  let cur: string | null = dir;
  for (let up = 0; cur && up <= MAX_WALK_UP; up++) {
    if ((await readManifest(cur)).length > 0) return { root: cur, prefix: relFrom(cur, dir) };
    cur = parentDir(cur);
  }
  return null;
}

export interface ArchiveScan {
  entries: ArchiveEntry[];
  /** Mục có trong manifest nhưng file đã bị xoá/đổi tên → không khôi phục được. */
  missing: ArchiveEntry[];
}

/**
 * Đọc kho trong thư mục và đối chiếu xem file còn đủ không.
 *
 * `prefix` (vd `Tháng 8-2026`) = chỉ lấy các mục nằm trong thư mục con đó. Dùng khi người
 * dùng chọn thẳng một thư mục mốc: manifest nằm ở gốc kho nên vẫn phải đọc từ gốc, nhưng
 * chỉ được khôi phục đúng phần bên trong thư mục họ chỉ vào.
 */
export async function scanArchive(dir: string, prefix = ""): Promise<ArchiveScan> {
  const all = await readManifest(dir);
  const want = prefix ? `${prefix.replace(/[\/]+$/, "")}/` : "";
  const entries: ArchiveEntry[] = [];
  const missing: ArchiveEntry[] = [];
  for (const e of all) {
    if (want && !e.file.replace(/[\/]+/g, "/").startsWith(want)) continue;
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
