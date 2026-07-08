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

// pixelRatio = ảnh gốc / ảnh hiển thị → xuất đúng độ phân giải gốc.
// WebP quality 0.85 nhẹ hơn PNG ~60% với chất lượng gần như không đổi.
export function flattenStage(stage: Konva.Stage, pixelRatio: number): Blob {
  const dataUrl = stage.toDataURL({ mimeType: "image/webp", quality: 0.85, pixelRatio });
  return dataUrlToBlob(dataUrl);
}

// Nén ảnh gốc (HTMLImageElement) sang WebP để upload NHẸ hơn PNG rất nhiều.
// Ảnh chụp màn hình là PNG (do backend Rust) — full desktop có thể vài MB → upload lâu.
// WebP quality 0.92 giữ chất lượng đủ tốt để mở lại sửa annotate mà nhỏ hơn ~5-10 lần.
export function imageToWebpBlob(img: HTMLImageElement, quality = 0.92): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", quality));
}
