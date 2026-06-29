// Kiểm tra & cài đặt bản cập nhật qua Tauri updater.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

// Trả về thông tin bản mới nếu có, null nếu đã mới nhất hoặc lỗi.
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (e) {
    console.error("Lỗi kiểm tra cập nhật:", e);
    return null;
  }
}

// Tải toàn bộ bộ cài + cài + khởi động lại app.
// onProgress nhận giá trị 0..1 trong lúc tải.
export async function applyUpdate(
  update: Update,
  onProgress?: (pct: number) => void
): Promise<void> {
  let total = 0;
  let got = 0;
  await update.downloadAndInstall((e) => {
    switch (e.event) {
      case "Started":
        total = e.data.contentLength ?? 0;
        onProgress?.(0);
        break;
      case "Progress":
        got += e.data.chunkLength;
        onProgress?.(total ? got / total : 0);
        break;
      case "Finished":
        onProgress?.(1);
        break;
    }
  });
  await relaunch(); // khởi động lại sang bản mới (nếu cài thành công)
}
