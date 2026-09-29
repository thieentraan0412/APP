// Xuất nội dung Konva Stage ra PNG (đã gộp ảnh nền + khung + note).
import type Konva from "konva";

// data URL -> Blob (an toàn, không cần fetch)
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = head.match(/:(.*?);/)?.[1] || "image/png";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Chromium coi WebP quality = 1.0 là LOSSLESS — đúng từng pixel. Đo trên ảnh chụp màn hình
// 1080p toàn chữ: lossless ra 15 KB, trong khi q 0.97 ra 931 KB mà vẫn đổi 34% pixel. Với
// ảnh UI/chữ thì nén mất dữ liệu vừa mờ vừa nặng — không có lý do gì để dùng.
export const LOSSLESS = 1;
// Lossless chỉ phình to trên ảnh nhiều hình chụp/gradient. Vượt ngưỡng thì rơi về 0.97:
// ảnh kiểu đó lossy mới hợp, và người dùng không bị bất ngờ vì một file 8 MB.
//
// Ngưỡng phải tính theo SỐ PIXEL, không thể là một con số byte cố định. Với trần 4 MB cứng,
// ảnh 4K (8,3 MP) gần như luôn vượt và bị đẩy về lossy, trong khi cũng cảnh đó ở 2K (3,7 MP)
// thì vẫn lossless — tức là chọn mức CAO hơn lại nhận ảnh XẤU hơn, cài đặt thành vô nghĩa.
// Giữ đúng ngân sách byte/pixel của trần cũ: 4 MB cho ảnh 1920×1080 ≈ 2 MB mỗi megapixel.
const LOSSLESS_BUDGET_PER_MP = 2 * 1024 * 1024;
// Sàn để ảnh nhỏ (vùng chọn vài trăm px) không bị ngưỡng bóp xuống còn vài chục KB.
const LOSSLESS_CAP_MIN = 4 * 1024 * 1024;
const LOSSLESS_FALLBACK = 0.97;

function losslessCap(pixels: number): number {
  return Math.max(LOSSLESS_CAP_MIN, (pixels / 1_000_000) * LOSSLESS_BUDGET_PER_MP);
}

// Mức nén WebP theo mức chất lượng đã chọn. LOSSLESS khi mức KHÔNG thu nhỏ ảnh — bằng hoặc
// cao hơn màn hình (Native / Upscale): người dùng không hề đòi file nhẹ đi, và ảnh chụp màn
// hình nén lossless vốn đã nhỏ. Chỉ nén mất dữ liệu khi họ chủ động chọn mức THẤP hơn màn hình
// cho nhẹ: 720p → 0.85, Full HD → 0.92 (0.85 cho MỌI mức như hồi đầu thì chữ nhỏ bị bệt).
// `screenH` = chiều cao màn hình chính; null (chưa đọc được) thì như trước: từ 2K là lossless.
// Cài đặt cũng gọi hàm này để ghi đúng cách nén lên từng nút.
export function webpQuality(tier: number, screenH: number | null = null): number {
  if (screenH && tier >= screenH) return LOSSLESS;
  if (tier <= 720) return 0.85;
  if (tier <= 1080) return 0.92;
  return LOSSLESS;
}

// pixelRatio = ảnh gốc / ảnh hiển thị → xuất đúng độ phân giải gốc.
export function flattenStage(stage: Konva.Stage, pixelRatio: number, quality: number): Blob {
  const blob = dataUrlToBlob(stage.toDataURL({ mimeType: "image/webp", quality, pixelRatio }));
  const cap = losslessCap(stage.width() * stage.height() * pixelRatio * pixelRatio);
  if (quality < LOSSLESS || blob.size <= cap) return blob;
  return dataUrlToBlob(stage.toDataURL({ mimeType: "image/webp", quality: LOSSLESS_FALLBACK, pixelRatio }));
}

// Nén ảnh gốc (HTMLImageElement) sang WebP để upload NHẸ hơn PNG rất nhiều.
// Ảnh chụp màn hình là PNG (do backend Rust) — full desktop có thể vài MB → upload lâu.
// Đây là bản MASTER để mở lại sửa annotate, nên mặc định LOSSLESS bất kể mức chọn: sửa
// đi sửa lại bao nhiêu lần cũng không nén chồng thêm lớp nào. Mất nét ở bản này là mất
// vĩnh viễn, còn bản xuất ra thì lúc nào cũng dựng lại được từ đây.
export async function imageToWebpBlob(img: HTMLImageElement, quality = LOSSLESS): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const encode = (q: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", q));
  const blob = await encode(quality);
  const cap = losslessCap(canvas.width * canvas.height);
  if (!blob || quality < LOSSLESS || blob.size <= cap) return blob;
  return encode(LOSSLESS_FALLBACK);
}
