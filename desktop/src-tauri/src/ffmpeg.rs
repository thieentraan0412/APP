// Tải ffmpeg về app_data lần đầu (KHÔNG bundle vào bộ cài để cài nhẹ + build nhanh).
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Nơi tải ffmpeg.exe (đặt sẵn trong một GitHub Release của repo).
const FFMPEG_URL: &str =
    "https://github.com/thieentraan0412/APP/releases/download/ffmpeg-bin/ffmpeg.exe";
const MIN_SIZE: u64 = 5_000_000; // file hợp lệ phải > 5MB

// Trả về đường dẫn ffmpeg.exe, tải về nếu chưa có.
pub fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("ffmpeg.exe");

    // Đã có + CHẠY ĐƯỢC → dùng luôn. Chạy `-version` để bắt cả file tải THIẾU (đứt
    // mạng giữa chừng) lẫn file hỏng đã cache từ trước — chỉ kiểm size 5MB là không đủ (H4).
    if ffmpeg_runs(&path) {
        return Ok(path);
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
    // Nếu server báo dung lượng → phải khớp CHÍNH XÁC (chống file tải cụt qua kiểm 5MB).
    if let Some(t) = total {
        let got = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        if got != t {
            let _ = fs::remove_file(&tmp);
            return Err(format!("ffmpeg tải chưa xong ({got}/{t} byte) — hãy thử lại"));
        }
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    // Xác thực nhị phân THẬT SỰ chạy được trước khi dùng (bắt file hỏng dù đủ dung lượng).
    if !ffmpeg_runs(&path) {
        let _ = fs::remove_file(&path);
        return Err("File ffmpeg tải về không chạy được — hãy thử lại".into());
    }
    let _ = app.emit("ffmpeg-ready", ());
    Ok(path)
}

// ffmpeg.exe tồn tại + chạy `-version` thành công (nhị phân hợp lệ, không cụt/hỏng).
fn ffmpeg_runs(path: &PathBuf) -> bool {
    if fs::metadata(path).map(|m| m.len() < MIN_SIZE).unwrap_or(true) {
        return false; // thiếu hẳn hoặc quá nhỏ → khỏi tốn công spawn
    }
    let mut cmd = Command::new(path);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

// Cắt video từ `start` đến `end` (giây) → xuất mp4 tạm mới, trả về đường dẫn.
// Dùng input-seek (`-ss` trước `-i`) + `-t` (thời lượng) rồi re-encode khớp cấu hình quay
// để cắt chính xác theo khung hình. Tên output kèm timestamp → không đè lên file nguồn
// (cho phép cắt nhiều lần liên tiếp). Mức nén lấy đúng crf của mức chất lượng đang chọn:
// cắt mà nén thô hơn bản quay thì đoạn cắt xấu hơn đoạn gốc — người dùng không thể hiểu nổi.
pub fn trim(app: &AppHandle, src: &str, start: f64, end: f64) -> Result<String, String> {
    let dur = end - start;
    if dur < 0.1 {
        return Err("Đoạn chọn quá ngắn".into());
    }
    let ffmpeg = ensure_ffmpeg(app)?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("capture_rec_trim_{stamp}.mp4"));
    let out_str = out.to_string_lossy().to_string();

    let ss = format!("{:.3}", start.max(0.0));
    let t = format!("{dur:.3}");

    let mut command = Command::new(&ffmpeg);
    command
        .args([
            "-y",
            "-ss", ss.as_str(),
            "-i", src,
            "-t", t.as_str(),
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", crate::record::crf_for(crate::video_quality(app)),
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-an", // video quay không có tiếng
            out_str.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let status = command.status().map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(&out);
        return Err("Cắt video thất bại".into());
    }
    Ok(out_str)
}
