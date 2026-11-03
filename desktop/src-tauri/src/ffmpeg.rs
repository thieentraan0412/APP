// Tải ffmpeg về app_data lần đầu (KHÔNG bundle vào bộ cài để cài nhẹ + build nhanh).
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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
            // Giữ tiếng nếu nguồn có (video nhập từ máy). Video quay bằng app không có luồng tiếng
            // nên lựa chọn này không sinh ra gì — trước đây là "-an", cắt video nhập vào là mất tiếng.
            "-c:a", "aac",
            "-b:a", "128k",
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

// ===================== Nhập ảnh / video từ máy =====================
//
// LUÔN làm việc trên một BẢN SAO trong thư mục tạm, không bao giờ trên file gốc:
// - webview chỉ được cấp quyền đọc file trong $TEMP (capabilities/default.json);
// - luồng video coi file của mình là file tạm: cắt xong và tải lên xong đều gọi remove_temp lên
//   nó. Đưa thẳng đường dẫn gốc vào là xoá mất video của người dùng.

/// Tệp nguồn lớn hơn mức này thì từ chối ngay: nạp cả file vào webview để xem trước / cắt sẽ ngốn
/// từng ấy RAM, và chuyển định dạng một file vài GB mất cả chục phút.
pub const IMPORT_MAX_BYTES: u64 = 500 * 1000 * 1000;

const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const VIDEO_EXT: [&str; 7] = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv"];

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// "image" | "video"
    pub kind: &'static str,
    /// Bản sao trong thư mục tạm — bên gọi được quyền xoá.
    pub path: String,
    /// Video đã được chuyển sang MP4 H.264 (nguồn là MOV / WebM / MKV / HEVC…).
    pub converted: bool,
}

pub fn import_media(app: &AppHandle, src: &str) -> Result<Imported, String> {
    // ffmpeg chỉ cần cho video; ảnh không đợi tải ffmpeg lần đầu.
    let ext = ext_of(src);
    if VIDEO_EXT.contains(&ext.as_str()) {
        let ffmpeg = ensure_ffmpeg(app)?;
        return import_with(Some(&ffmpeg), src);
    }
    import_with(None, src)
}

fn ext_of(src: &str) -> String {
    Path::new(src)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Phần lõi, tách khỏi AppHandle để kiểm bằng ffmpeg thật.
pub fn import_with(ffmpeg: Option<&Path>, src: &str) -> Result<Imported, String> {
    let ext = ext_of(src);
    let is_image = IMAGE_EXT.contains(&ext.as_str());
    if !is_image && !VIDEO_EXT.contains(&ext.as_str()) {
        return Err(
            "Chỉ mở được ảnh (PNG, JPG, WebP, GIF, BMP) hoặc video (MP4, MOV, WebM, MKV, AVI, WMV)".into(),
        );
    }
    let size = fs::metadata(src).map_err(|e| format!("Không đọc được tệp: {e}"))?.len();
    if size == 0 {
        return Err("Tệp rỗng".into());
    }
    if size > IMPORT_MAX_BYTES {
        return Err(format!(
            "Tệp nặng {} MB, vượt mức {} MB mở được trong app",
            size / 1_000_000,
            IMPORT_MAX_BYTES / 1_000_000
        ));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    if is_image {
        let out = std::env::temp_dir().join(format!("capture_import_{stamp}.{ext}"));
        fs::copy(src, &out).map_err(|e| format!("Không chép được ảnh: {e}"))?;
        return Ok(Imported { kind: "image", path: out.to_string_lossy().into_owned(), converted: false });
    }

    let ffmpeg = ffmpeg.ok_or("Thiếu ffmpeg")?;
    let out = std::env::temp_dir().join(format!("capture_import_{stamp}.mp4"));
    let ready = matches!(ext.as_str(), "mp4" | "m4v") && web_ready(&probe(ffmpeg, src)?);
    if ready {
        fs::copy(src, &out).map_err(|e| format!("Không chép được video: {e}"))?;
    } else if let Err(e) = transcode(ffmpeg, src, &out) {
        let _ = fs::remove_file(&out);
        return Err(e);
    }
    Ok(Imported { kind: "video", path: out.to_string_lossy().into_owned(), converted: !ready })
}

// `ffmpeg -i <file>` không có đầu ra thì thoát mã lỗi nhưng vẫn in đủ thông tin luồng ra stderr —
// chỉ cần đoạn đó. App không kèm ffprobe nên dùng cách này.
fn probe(ffmpeg: &Path, src: &str) -> Result<String, String> {
    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-i", src]).stdin(Stdio::null()).stdout(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let out = command.output().map_err(|e| format!("Không chạy được ffmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr).into_owned();
    if !text.contains("Stream #") {
        return Err("Không đọc được video này (tệp hỏng hoặc không phải video)".into());
    }
    Ok(text)
}

/// MP4 phát được trên MỌI trình duyệt mà không cần chuyển: hình H.264 8-bit 4:2:0 (yuv420p), tiếng
/// AAC / MP3 hoặc không có tiếng. HEVC (video iPhone), 10-bit, 4:4:4, tiếng PCM… đều phải chuyển:
/// WebView2 và trình duyệt của người nhận link thường không phát được.
pub fn web_ready(probe: &str) -> bool {
    let mut has_video = false;
    for line in probe.lines().filter(|l| l.contains("Stream #")) {
        if let Some(i) = line.find("Video: ") {
            let v = &line[i + 7..];
            // "yuv420p(" hoặc "yuv420p," — không lẫn với "yuv420p10le"
            if !v.starts_with("h264") || !(v.contains("yuv420p(") || v.contains("yuv420p,")) {
                return false;
            }
            has_video = true;
        } else if let Some(i) = line.find("Audio: ") {
            let a = &line[i + 7..];
            if !(a.starts_with("aac") || a.starts_with("mp3")) {
                return false;
            }
        }
    }
    has_video
}

fn transcode(ffmpeg: &Path, src: &str, out: &Path) -> Result<(), String> {
    let out_str = out.to_string_lossy().into_owned();
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-y",
            "-i", src,
            // Hình đầu tiên + tiếng đầu tiên nếu có ("?" = không có thì thôi, không báo lỗi)
            "-map", "0:v:0",
            "-map", "0:a:0?",
            // yuv420p bắt buộc cạnh chẵn — video quay điện thoại / cắt tay có thể lẻ 1px
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            out_str.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command.status().map_err(|e| format!("Không chạy được ffmpeg: {e}"))?;
    if !status.success() {
        return Err("Không chuyển được video sang MP4 (định dạng không hỗ trợ hoặc tệp hỏng)".into());
    }
    Ok(())
}

#[cfg(test)]
mod import_tests {
    use super::web_ready;

    const H264_AAC: &str = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080, 30 fps\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s";

    #[test]
    fn mp4_h264_phat_duoc_ngay() {
        assert!(web_ready(H264_AAC));
        assert!(web_ready("  Stream #0:0: Video: h264 (High), yuv420p, 1280x720")); // không tiếng
    }

    #[test]
    fn phai_chuyen_dinh_dang() {
        assert!(!web_ready("  Stream #0:0: Video: hevc (Main) (hvc1), yuv420p(tv), 1920x1080")); // iPhone
        assert!(!web_ready("  Stream #0:0: Video: h264 (High 10), yuv420p10le(tv), 1920x1080")); // 10-bit
        assert!(!web_ready("  Stream #0:0: Video: h264 (High 4:4:4), yuv444p, 1920x1080"));
        assert!(!web_ready("  Stream #0:0: Video: h264, yuv420p, 640x480\n  Stream #0:1: Audio: pcm_s16le, 48000 Hz"));
        assert!(!web_ready("  Stream #0:0: Audio: aac, 44100 Hz")); // không có hình
        assert!(!web_ready("")); // ffmpeg không đọc được gì
    }
}

// Kiểm với ffmpeg THẬT trên các tệp mẫu đủ loại (không chạy mặc định — cần ffmpeg):
//   CAPTURE_TEST_FFMPEG=<đường dẫn ffmpeg.exe> cargo test --lib import_real -- --ignored
#[cfg(test)]
mod import_real_tests {
    use super::{import_with, probe, web_ready};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn ff() -> PathBuf {
        PathBuf::from(std::env::var("CAPTURE_TEST_FFMPEG").expect("đặt CAPTURE_TEST_FFMPEG"))
    }

    // Tạo tệp mẫu 2 giây: hình testsrc2 (+ tiếng sine nếu `audio` có codec)
    fn sample(dir: &Path, name: &str, size: &str, vargs: &[&str], audio: Option<&[&str]>) -> String {
        let out = dir.join(name);
        let mut c = Command::new(ff());
        c.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc2=size={size}:rate=24")]);
        if audio.is_some() {
            c.args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]);
        }
        c.args(["-t", "2"]).args(vargs);
        match audio {
            Some(a) => { c.args(a); }
            None => { c.arg("-an"); }
        }
        c.arg(&out);
        assert!(c.status().unwrap().success(), "không tạo được mẫu {name}");
        out.to_string_lossy().into_owned()
    }

    fn streams(p: &str) -> String {
        probe(&ff(), p).unwrap().lines().filter(|l| l.contains("Stream #")).collect::<Vec<_>>().join(" || ")
    }

    #[test]
    #[ignore]
    fn import_real_ffmpeg() {
        let dir = std::env::temp_dir().join("capture_import_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = ff();
        let x264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
        let aac: &[&str] = &["-c:a", "aac"];

        // 1) MP4 H.264 + AAC → chép nguyên, KHÔNG chuyển, file gốc còn nguyên
        let src = sample(&dir, "a.mp4", "1280x720", &x264, Some(aac));
        let before = std::fs::read(&src).unwrap();
        let r = import_with(Some(&f), &src).unwrap();
        println!("mp4 h264+aac  -> {r:?}");
        assert_eq!((r.kind, r.converted), ("video", false));
        assert_eq!(std::fs::read(&r.path).unwrap(), before, "bản sao phải giống hệt");
        assert!(Path::new(&src).exists(), "file gốc phải còn");
        assert_ne!(Path::new(&r.path), Path::new(&src));

        // 2) MOV HEVC (kiểu video iPhone) → phải chuyển, ra H.264 + giữ tiếng
        let src = sample(&dir, "b.mov", "1280x720", &["-c:v", "libx265", "-tag:v", "hvc1"], Some(aac));
        let r = import_with(Some(&f), &src).unwrap();
        let s = streams(&r.path);
        println!("mov hevc      -> converted={} | {s}", r.converted);
        assert!(r.converted && web_ready(&probe(&f, &r.path).unwrap()) && s.contains("Audio: aac"));

        // 3) WebM VP9 + Opus → chuyển
        let src = sample(&dir, "c.webm", "640x360", &["-c:v", "libvpx-vp9", "-b:v", "500k"], Some(&["-c:a", "libopus"]));
        let r = import_with(Some(&f), &src).unwrap();
        let s = streams(&r.path);
        println!("webm vp9+opus -> converted={} | {s}", r.converted);
        assert!(r.converted && web_ready(&probe(&f, &r.path).unwrap()) && s.contains("Audio: aac"));

        // 4) MKV, cạnh LẺ 641x481, không tiếng → chuyển, cạnh thành chẵn
        let src = sample(&dir, "d.mkv", "641x481", &["-c:v", "libx264", "-pix_fmt", "yuv444p"], None);
        let r = import_with(Some(&f), &src).unwrap();
        let s = streams(&r.path);
        println!("mkv 641x481   -> converted={} | {s}", r.converted);
        assert!(r.converted && web_ready(&probe(&f, &r.path).unwrap()) && s.contains("640x480") && !s.contains("Audio"));

        // 5) MP4 nhưng tiếng PCM → chuyển (trình duyệt không phát PCM trong MP4)
        let src = sample(&dir, "e.mov", "640x360", &x264, Some(&["-c:a", "pcm_s16le"]));
        let r = import_with(Some(&f), &src).unwrap();
        println!("mov h264+pcm  -> converted={}", r.converted);
        assert!(r.converted && streams(&r.path).contains("Audio: aac"));

        // 6) Ảnh → chép nguyên, đúng đuôi
        let png = dir.join("f.png");
        assert!(Command::new(&f).args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x200", "-frames:v", "1"]).arg(&png).status().unwrap().success());
        let r = import_with(Some(&f), png.to_str().unwrap()).unwrap();
        println!("png           -> {r:?}");
        assert!(r.kind == "image" && !r.converted && r.path.ends_with(".png"));
        assert_eq!(std::fs::read(&r.path).unwrap(), std::fs::read(&png).unwrap());

        // 7) Lỗi phải nói rõ: đuôi lạ / video hỏng / file rỗng
        let txt = dir.join("g.txt"); std::fs::write(&txt, "x").unwrap();
        let bad = dir.join("h.mp4"); std::fs::write(&bad, vec![7u8; 4096]).unwrap();
        let empty = dir.join("i.mov"); std::fs::write(&empty, b"").unwrap();
        for p in [&txt, &bad, &empty] {
            let e = import_with(Some(&f), p.to_str().unwrap()).unwrap_err();
            println!("{:<12} -> LỖI: {e}", p.file_name().unwrap().to_string_lossy());
        }
        let _ = std::fs::remove_dir_all(&dir);
        // Dọn các bản sao import_with vừa tạo trong thư mục tạm trong lúc chạy test này
        if let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) {
            for e in rd.flatten() {
                let fresh = e.metadata().and_then(|m| m.modified()).map(|t| t.elapsed().map_or(true, |d| d.as_secs() < 300)).unwrap_or(false);
                if fresh && e.file_name().to_string_lossy().starts_with("capture_import_") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}
