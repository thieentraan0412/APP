// Gọi API Worker để upload, lấy link, và quản lý nội dung.
import type { Annotations } from "../types";

const WORKER_URL = "https://captures-api.thieentraan.workers.dev";
// Khoá cho các thao tác quản lý (liệt kê/sửa/xoá).
// Lưu ý: nhúng trong app desktop nên không thật sự bí mật — chỉ chặn lạm dụng thông thường.
const API_KEY = "cap_2026_f4a9d3b7e1c85206ab";

export interface UploadResult {
  id: string;
  url: string;
}

export interface LibraryItem {
  id: string;
  type: "image" | "video";
  createdAt: number;
  url: string;
  fileUrl: string;
  hasAnnotations: boolean;
}

export interface ItemDetail {
  id: string;
  type: "image" | "video";
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
  annotations: Annotations
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", flattened, "image.png");
  form.append("original", original, "original.png");
  form.append("type", "image");
  form.append("annotations", JSON.stringify(annotations));
  return postUpload(form);
}

export async function uploadVideo(blob: Blob): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", blob, "video.mp4");
  form.append("type", "video");
  return postUpload(form);
}

async function postUpload(form: FormData): Promise<UploadResult> {
  const res = await fetch(`${WORKER_URL}/api/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Tải lên thất bại (HTTP ${res.status})`);
  return res.json();
}

// ---------- Quản lý ----------
const authHeader = { "x-api-key": API_KEY };

export async function listItems(): Promise<LibraryItem[]> {
  const res = await fetch(`${WORKER_URL}/api/items`, { headers: authHeader });
  if (!res.ok) throw new Error(`Không tải được danh sách (HTTP ${res.status})`);
  const data = await res.json();
  return data.items as LibraryItem[];
}

export async function getItem(id: string): Promise<ItemDetail> {
  const res = await fetch(`${WORKER_URL}/api/items/${id}`, { headers: authHeader });
  if (!res.ok) throw new Error(`Không tải được chi tiết (HTTP ${res.status})`);
  return res.json();
}

export async function deleteItem(id: string): Promise<void> {
  const res = await fetch(`${WORKER_URL}/api/items/${id}`, {
    method: "DELETE",
    headers: authHeader,
  });
  if (!res.ok) throw new Error(`Xoá thất bại (HTTP ${res.status})`);
}

export async function updateItem(
  id: string,
  flattened: Blob,
  annotations: Annotations
): Promise<{ url: string }> {
  const form = new FormData();
  form.append("file", flattened, "image.png");
  form.append("annotations", JSON.stringify(annotations));
  const res = await fetch(`${WORKER_URL}/api/items/${id}`, {
    method: "PATCH",
    headers: authHeader,
    body: form,
  });
  if (!res.ok) throw new Error(`Cập nhật thất bại (HTTP ${res.status})`);
  return res.json();
}

// Tải một URL ảnh về dạng data URL (để mở lại trong editor khi sửa)
export async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không tải được ảnh gốc (HTTP ${res.status})`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
