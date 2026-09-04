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

// Mức nén WebP đi theo mức chất lượng người dùng chọn trong Cài đặt. Trước đây cố định
// 0.85 cho MỌI mức: ảnh chụp màn hình toàn chữ nhỏ và nét mảnh nên ở 0.85 nhìn rõ bị bệt,
// và đó là cái "hơi mờ" còn lại kể cả khi để 2K — chọn mức cao mà ảnh vẫn bị nén như mức
// thấp thì cài đặt coi như vô nghĩa. Người chọn 720p là đang ưu tiên file nhẹ nên giữ 0.85.
export function webpQuality(maxHeight: number): number {
  if (maxHeight <= 720) return 0.85;
  if (maxHeight <= 1080) return 0.92;
  return 0.97;
}

// pixelRatio = ảnh gốc / ảnh hiển thị → xuất đúng độ phân giải gốc.
export function flattenStage(stage: Konva.Stage, pixelRatio: number, quality: number): Blob {
  const dataUrl = stage.toDataURL({ mimeType: "image/webp", quality, pixelRatio });
  return dataUrlToBlob(dataUrl);
}

// Nén ảnh gốc (HTMLImageElement) sang WebP để upload NHẸ hơn PNG rất nhiều.
// Ảnh chụp màn hình là PNG (do backend Rust) — full desktop có thể vài MB → upload lâu.
// Đây là bản để mở lại sửa annotate nên nén nhẹ tay hơn bản xuất ra: sửa đi sửa lại nhiều
// lần mà mỗi lần nén thêm một lớp thì ảnh xuống cấp dần.
export function imageToWebpBlob(img: HTMLImageElement, quality = 0.92): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", quality));
}
