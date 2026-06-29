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
