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
// Lossless chỉ phình to trên ảnh nhiều hình chụp/gradient. Vượt mức này thì rơi về 0.97:
// ảnh kiểu đó lossy mới hợp, và người dùng không bị bất ngờ vì một file 8 MB.
const LOSSLESS_CAP = 4 * 1024 * 1024;
const LOSSLESS_FALLBACK = 0.97;

// Mức nén WebP đi theo mức chất lượng người dùng chọn trong Cài đặt. Trước đây cố định
// 0.85 cho MỌI mức: ảnh chụp màn hình toàn chữ nhỏ và nét mảnh nên ở 0.85 nhìn rõ bị bệt.
// Người chọn 720p là đang ưu tiên file nhẹ nên giữ 0.85; mức cao nhất thì không nén mất
// dữ liệu nữa — đó mới là "nét nhất" thật sự chứ không phải 0.97.
export function webpQuality(maxHeight: number): number {
  if (maxHeight <= 720) return 0.85;
  if (maxHeight <= 1080) return 0.92;
  return LOSSLESS;
}

// pixelRatio = ảnh gốc / ảnh hiển thị → xuất đúng độ phân giải gốc.
export function flattenStage(stage: Konva.Stage, pixelRatio: number, quality: number): Blob {
  const blob = dataUrlToBlob(stage.toDataURL({ mimeType: "image/webp", quality, pixelRatio }));
  if (quality < LOSSLESS || blob.size <= LOSSLESS_CAP) return blob;
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
  if (!blob || quality < LOSSLESS || blob.size <= LOSSLESS_CAP) return blob;
  return encode(LOSSLESS_FALLBACK);
}
