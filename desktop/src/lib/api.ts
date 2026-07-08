// Gọi API Worker để upload, lấy link, và quản lý nội dung.
import type { Annotations } from "../types";

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
    headers: authHeader,
    body: form,
  });
  if (!res.ok) throw new Error(`Tải lên thất bại (HTTP ${res.status})`);
  return res.json();
}

// ---------- Quản lý ----------
const authHeader = { "x-api-key": API_KEY };

// Gộp các lời gọi listItems() đồng thời vào CHUNG một request đang bay.
// Lúc khởi động (nhất là dev + React.StrictMode) hàm này bị gọi nhiều lần cùng lúc
// (openLibrary + loadUsageStats × 2). Nếu để chạy song song, một request có thể rớt
// và hiện "Failed to fetch" dù các request khác thành công. Coalescing → 1 fetch thật,
// mọi caller nhận cùng kết quả.
let itemsInFlight: Promise<LibraryItem[]> | null = null;

export function listItems(): Promise<LibraryItem[]> {
  if (itemsInFlight) return itemsInFlight;
  const p = (async () => {
    const res = await fetchRetry(`${WORKER_URL}/api/items`, { headers: authHeader });
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
  const res = await fetchRetry(`${WORKER_URL}/api/items/${id}`, { headers: authHeader });
  if (!res.ok) throw new Error(`Không tải được chi tiết (HTTP ${res.status})`);
  return res.json();
}

export async function deleteItem(id: string): Promise<void> {
  const res = await fetchRetry(`${WORKER_URL}/api/items/${id}`, {
    method: "DELETE",
    headers: authHeader,
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
    headers: authHeader,
    body: form,
  });
  if (!res.ok) throw new Error(`Cập nhật thất bại (HTTP ${res.status})`);
  return res.json();
}

export interface UsageStats {
  totalItems: number;
  imageCount: number;
  videoCount: number;
  estimatedMB: number;
}

export function calcStats(items: LibraryItem[]): UsageStats {
  const imageCount = items.filter((i) => i.type === "image").length;
  const videoCount = items.filter((i) => i.type === "video").length;
  // Sau tối ưu: ảnh WebP ~0.4MB, video CRF28/24fps ~6MB trung bình
  const estimatedMB = imageCount * 0.4 + videoCount * 6;
  return { totalItems: items.length, imageCount, videoCount, estimatedMB };
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
