// Gọi API Worker để upload, lấy link, và quản lý nội dung.
import type { Annotations } from "../types";
import { getToken } from "./auth";

// Đọc cấu hình từ .env (xem desktop/.env.example). Vite chỉ expose biến VITE_*.
// Lưu ý: API key vẫn nằm trong bản build app desktop nên không thật sự bí mật —
// chỉ chặn lạm dụng thông thường.
const WORKER_URL = import.meta.env.VITE_WORKER_URL;
const API_KEY = import.meta.env.VITE_API_KEY;

if (!WORKER_URL || !API_KEY) {
  console.error(
    "Thiếu cấu hình: hãy tạo desktop/.env với VITE_WORKER_URL và VITE_API_KEY (xem .env.example)."
  );
}

export interface UploadResult {
  id: string;
  url: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Gọi fetch có tự thử lại khi lỗi mạng/treo. WebView2 lúc mới mở app hay để request đầu
// tiên treo (network stack chưa sẵn sàng, hoặc qua VPN/proxy) → huỷ sau timeoutMs rồi thử
// lại; lần sau (mạng đã sẵn sàng) thường chạy được. Request khoẻ chỉ ~0.2s nên GET treo
// >10s coi như kẹt, huỷ sớm để thử lại nhanh thay vì để người dùng chờ.
async function fetchRetry(
  url: string,
  opts?: RequestInit,
  attempts = 4,
  delayMs = 800
): Promise<Response> {
  // Upload (có body: FormData ảnh/video) có thể lâu → 120s; GET nhẹ → 10s.
  const timeoutMs = opts?.body ? 120000 : 10000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await globalThis.fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(delayMs * (i + 1)); // backoff tăng dần
    } finally {
      clearTimeout(timer);
    }
  }
  // Hết lượt: đổi lỗi kỹ thuật (AbortError/Failed to fetch) thành thông báo rõ, hành động được.
  const e = lastErr as { name?: string };
  if (e?.name === "AbortError" || lastErr instanceof TypeError) {
    throw new Error('Không kết nối được máy chủ (mạng chậm hoặc VPN?). Hãy bấm "Làm mới".');
  }
  throw lastErr;
}

export interface LibraryItem {
  id: string;
  type: "image" | "video";
  title: string | null;
  createdAt: number;
  url: string;
  fileUrl: string;
  hasAnnotations: boolean;
}

export interface ItemDetail {
  id: string;
  type: "image" | "video";
  title: string | null;
  createdAt: number;
  annotations: Annotations | null;
  hasOriginal: boolean;
  originalUrl: string | null;
  url: string;
}

// ---------- Tạo mới ----------
export async function uploadImage(
  flattened: Blob,
  original: Blob,
  annotations: Annotations,
  title = ""
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", flattened, "image.webp");
  form.append("original", original, "original.webp");
  form.append("type", "image");
  form.append("annotations", JSON.stringify(annotations));
  form.append("title", title);
  return postUpload(form);
}

export async function uploadVideo(blob: Blob): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", blob, "video.mp4");
  form.append("type", "video");
  return postUpload(form);
}

async function postUpload(form: FormData): Promise<UploadResult> {
  const res = await fetchRetry(`${WORKER_URL}/api/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Tải lên thất bại (HTTP ${res.status})`);
  return res.json();
}

// ---------- Quản lý ----------
// Gửi kèm cả token phiên đăng nhập (Bearer) và API key (tương thích ngược).
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// Gộp các lời gọi listItems() đồng thời vào CHUNG một request đang bay.
// Lúc khởi động (nhất là dev + React.StrictMode) hàm này bị gọi nhiều lần cùng lúc
// (openLibrary + loadUsageStats × 2). Nếu để chạy song song, một request có thể rớt
// và hiện "Failed to fetch" dù các request khác thành công. Coalescing → 1 fetch thật,
// mọi caller nhận cùng kết quả.
let itemsInFlight: Promise<LibraryItem[]> | null = null;

export function listItems(): Promise<LibraryItem[]> {
  if (itemsInFlight) return itemsInFlight;
  const p = (async () => {
    const res = await fetchRetry(`${WORKER_URL}/api/items`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Không tải được danh sách (HTTP ${res.status})`);
    const data = await res.json();
    return data.items as LibraryItem[];
  })();
  itemsInFlight = p;
  // Xong (thành công hay lỗi) thì xoá cache in-flight để lần sau tải dữ liệu mới.
  p.finally(() => { if (itemsInFlight === p) itemsInFlight = null; });
  return p;
}

export async function getItem(id: string): Promise<ItemDetail> {
  const res = await fetchRetry(`${WORKER_URL}/api/items/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Không tải được chi tiết (HTTP ${res.status})`);
  return res.json();
}

export async function deleteItem(id: string): Promise<void> {
  const res = await fetchRetry(`${WORKER_URL}/api/items/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Xoá thất bại (HTTP ${res.status})`);
}

export async function updateItem(
  id: string,
  flattened: Blob,
  annotations: Annotations,
  title = ""
): Promise<{ url: string }> {
  const form = new FormData();
  form.append("file", flattened, "image.webp");
  form.append("annotations", JSON.stringify(annotations));
  form.append("title", title);
  return patchItem(id, form);
}

// Chỉ cập nhật tiêu đề (dùng cho video — không có editor)
export async function updateTitle(id: string, title: string): Promise<{ url: string }> {
  const form = new FormData();
  form.append("title", title);
  return patchItem(id, form);
}

async function patchItem(id: string, form: FormData): Promise<{ url: string }> {
  const res = await fetchRetry(`${WORKER_URL}/api/items/${id}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Cập nhật thất bại (HTTP ${res.status})`);
  return res.json();
}

export interface UsageStats {
  generatedAt: number;
  r2: {
    bytes: number;
    objectCount: number;
    imageBytes: number;
    videoBytes: number;
    originalBytes: number;
    otherBytes: number;
    listOperations: number;
  };
  d1: {
    bytes: number;
    rowsReadByThisRefresh: number;
    totalItems: number;
    imageCount: number;
    videoCount: number;
    userCount: number;
    sessionCount: number;
    oldestItemAt: number | null;
    newestItemAt: number | null;
  };
  growth: {
    last7Days: UsageGrowthPeriod;
    last30Days: UsageGrowthPeriod;
  };
}

export interface UsageGrowthPeriod {
  items: number;
  images: number;
  videos: number;
}

let usageInFlight: Promise<UsageStats> | null = null;

/** Lấy số liệu thật trên toàn bucket R2 và toàn database D1 (không bị LIMIT 200). */
export function getUsageStats(): Promise<UsageStats> {
  if (usageInFlight) return usageInFlight;
  const p = (async () => {
    const res = await fetchRetry(`${WORKER_URL}/api/usage`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Không tải được thống kê (HTTP ${res.status})`);
    return res.json() as Promise<UsageStats>;
  })();
  usageInFlight = p;
  p.finally(() => { if (usageInFlight === p) usageInFlight = null; });
  return p;
}

// ---------- Quản lý dữ liệu theo thời gian ----------
export interface StorageDay {
  day: string; // yyyy-mm-dd theo giờ địa phương
  items: number;
  bytes: number;
  images: number;
  videos: number;
  imageBytes: number;
  videoBytes: number;
  unsized: number; // số mục chưa biết dung lượng (cần Đồng bộ)
}

export interface StorageOverview {
  generatedAt: number;
  total: {
    items: number;
    bytes: number;
    images: number;
    videos: number;
    imageBytes: number;
    videoBytes: number;
    unsized: number;
  };
  oldestAt: number | null;
  newestAt: number | null;
  days: StorageDay[];
}

export interface StorageItem {
  id: string;
  type: "image" | "video";
  title: string | null;
  createdAt: number;
  bytes: number | null;
  url: string;
  fileUrl: string;
}

export interface StorageItemsPage {
  total: number;
  totalBytes: number;
  truncated: boolean;
  items: StorageItem[];
}

export interface StorageSyncResult {
  updated: number;
  missingFiles: number;
  scannedObjects: number;
  listOperations: number;
  orphan: { count: number; bytes: number };
}

export interface PurgeResult {
  deleted: number;
  bytesFreed: number;
  hasMore: boolean;
  orphansDeleted?: number;
}

/** Dung lượng đang chiếm, gom theo từng ngày (cắt mốc ngày theo giờ máy người dùng). */
export async function getStorageOverview(): Promise<StorageOverview> {
  const tz = -new Date().getTimezoneOffset(); // phút lệch so với UTC (VN = +420)
  const res = await fetchRetry(`${WORKER_URL}/api/storage?tz=${tz}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Không tải được dung lượng (HTTP ${res.status})`);
  return res.json();
}

/** Các mục trong một khoảng thời gian, sắp xếp mục nặng nhất trước. */
export async function getStorageItems(from: number, to: number, limit = 300): Promise<StorageItemsPage> {
  const res = await fetchRetry(
    `${WORKER_URL}/api/storage/items?from=${from}&to=${to}&limit=${limit}`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`Không tải được danh sách (HTTP ${res.status})`);
  return res.json();
}

/** Quét R2 để điền dung lượng cho dữ liệu cũ và phát hiện file rác. */
export async function syncStorage(): Promise<StorageSyncResult> {
  const res = await fetchRetry(`${WORKER_URL}/api/storage/sync`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Đồng bộ thất bại (HTTP ${res.status})`);
  return res.json();
}

async function postPurge(body: Record<string, unknown>): Promise<PurgeResult> {
  const res = await fetchRetry(`${WORKER_URL}/api/storage/purge`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Xoá thất bại (HTTP ${res.status})`);
  return res.json();
}

// Worker xử lý tối đa 2.000 mục mỗi lượt → gọi lại tới khi hết (hasMore = false).
async function purgeAll(body: Record<string, unknown>): Promise<PurgeResult> {
  let deleted = 0;
  let bytesFreed = 0;
  for (let round = 0; round < 25; round++) {
    const r = await postPurge(body);
    deleted += r.deleted;
    bytesFreed += r.bytesFreed;
    if (!r.hasMore) return { deleted, bytesFreed, hasMore: false };
  }
  return { deleted, bytesFreed, hasMore: true };
}

/** Xoá mọi nội dung tạo trong khoảng [from, to]. */
export function purgeRange(from: number, to: number): Promise<PurgeResult> {
  return purgeAll({ from, to });
}

/** Xoá các mục được chọn (theo id). */
export async function purgeIds(ids: string[]): Promise<PurgeResult> {
  let deleted = 0;
  let bytesFreed = 0;
  // Cắt sẵn thành lô 2.000 — mỗi lời gọi worker chỉ nhận ngần đó.
  for (let i = 0; i < ids.length; i += 2000) {
    const r = await postPurge({ ids: ids.slice(i, i + 2000) });
    deleted += r.deleted;
    bytesFreed += r.bytesFreed;
  }
  return { deleted, bytesFreed, hasMore: false };
}

/** Dọn file trên R2 không còn bản ghi tương ứng (rác do xoá hụt trước đây). */
export function purgeOrphans(): Promise<PurgeResult> {
  return postPurge({ orphans: true });
}

// Tải một URL ảnh về dạng data URL (để mở lại trong editor khi sửa)
export async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`Không tải được ảnh gốc (HTTP ${res.status})`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
