// Tải ffmpeg về app_data lần đầu (KHÔNG bundle vào bộ cài để cài nhẹ + build nhanh).
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

// Nơi tải ffmpeg.exe (đặt sẵn trong một GitHub Release của repo).
const FFMPEG_URL: &str =
    "https://github.com/thieentraan0412/APP/releases/download/ffmpeg-bin/ffmpeg.exe";
const MIN_SIZE: u64 = 5_000_000; // file hợp lệ phải > 5MB

// Trả về đường dẫn ffmpeg.exe, tải về nếu chưa có.
pub fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("ffmpeg.exe");

    // Đã có và đủ lớn → dùng luôn
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MIN_SIZE {
            return Ok(path);
        }
    }

    // Tải về (stream ra file để không ngốn RAM)
    let _ = app.emit("ffmpeg-downloading", ());
    let mut resp = reqwest::blocking::get(FFMPEG_URL).map_err(|e| format!("Tải ffmpeg lỗi: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Tải ffmpeg lỗi HTTP {}", resp.status()));
    }
    let tmp = dir.join("ffmpeg.exe.part");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut resp, &mut file).map_err(|e| e.to_string())?;
    }
    // Kiểm tra kích thước trước khi dùng
    let ok = fs::metadata(&tmp).map(|m| m.len() > MIN_SIZE).unwrap_or(false);
    if !ok {
        let _ = fs::remove_file(&tmp);
        return Err("File ffmpeg tải về không hợp lệ".into());
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    let _ = app.emit("ffmpeg-ready", ());
    Ok(path)
}
