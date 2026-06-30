// Tải ffmpeg về app_data lần đầu (KHÔNG bundle vào bộ cài để cài nhẹ + build nhanh).
use std::fs;
use std::io::{Read, Write};
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

    // Tải về (stream ra file để không ngốn RAM) + phát tiến độ %.
    let _ = app.emit("ffmpeg-downloading", ());
    let mut resp = reqwest::blocking::get(FFMPEG_URL).map_err(|e| format!("Tải ffmpeg lỗi: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Tải ffmpeg lỗi HTTP {}", resp.status()));
    }
    let total = resp.content_length(); // Option<u64>: None nếu server không báo dung lượng
    let tmp = dir.join("ffmpeg.exe.part");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut downloaded: u64 = 0;
        let mut last_pct: i64 = -1;
        loop {
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            downloaded += n as u64;
            // Có dung lượng tổng → phát % (0..100); không có → phát -1 (không xác định)
            let pct = match total {
                Some(t) if t > 0 => ((downloaded as f64 / t as f64) * 100.0) as i64,
                _ => -1,
            };
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("ffmpeg-progress", pct);
            }
        }
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
