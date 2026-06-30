// Quay toàn màn hình bằng ffmpeg (tải runtime, không bundle) qua gdigrab.
// Bấm phím tắt lần 1 → bắt đầu; lần 2 → dừng sạch (gửi 'q') → báo frontend đường dẫn mp4.
use std::io::Write;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct RecState {
    // Giữ stdin của ffmpeg để gửi 'q' khi dừng.
    stdin: Mutex<Option<ChildStdin>>,
    recording: Mutex<bool>,
}

pub fn toggle_recording(app: &AppHandle) {
    let recording = *app.state::<RecState>().recording.lock().unwrap();
    if recording {
        stop(app);
    } else {
        start(app);
    }
}

fn start(app: &AppHandle) {
    // Chạy trong thread để không treo UI khi lần đầu tải ffmpeg.
    let app = app.clone();
    std::thread::spawn(move || {
        let ffmpeg = match crate::ffmpeg::ensure_ffmpeg(&app) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit("video-error", format!("Không chuẩn bị được ffmpeg: {e}"));
                return;
            }
        };

        let out = std::env::temp_dir().join("capture_rec.mp4");
        let out_str = out.to_string_lossy().to_string();

        let mut command = Command::new(&ffmpeg);
        command
            .args([
                "-y",
                "-f", "gdigrab",
                "-framerate", "24",       // 24fps cho nhẹ
                "-i", "desktop",
                "-c:v", "libx264",
                "-preset", "ultrafast",   // không delay khi record
                "-crf", "28",             // cân bằng chất/nặng
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                out_str.as_str(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        // Thử spawn nhiều lần: ngay sau khi tải, Windows Defender có thể đang quét &
        // khóa ffmpeg.exe (os error 32). Chờ rồi thử lại để khỏi báo lỗi oan.
        let mut spawned = None;
        let mut last_err = String::new();
        for attempt in 0..8 {
            match command.spawn() {
                Ok(child) => {
                    spawned = Some(child);
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt == 0 {
                        let _ = app.emit("ffmpeg-preparing", ());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
            }
        }

        match spawned {
            Some(mut child) => {
                {
                    let st = app.state::<RecState>();
                    *st.stdin.lock().unwrap() = child.stdin.take();
                    *st.recording.lock().unwrap() = true;
                }
                let _ = app.emit("recording-started", ());

                // Chờ ffmpeg kết thúc (sau khi nhận 'q') → báo frontend file để upload.
                let _ = child.wait();
                {
                    let st = app.state::<RecState>();
                    *st.recording.lock().unwrap() = false;
                    *st.stdin.lock().unwrap() = None;
                }
                let _ = app.emit("video-ready", out.to_string_lossy().to_string());
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            None => {
                let _ = app.emit("video-error", format!("Không quay được: {last_err}"));
            }
        }
    });
}

fn stop(app: &AppHandle) {
    *app.state::<RecState>().recording.lock().unwrap() = false;
    let _ = app.emit("recording-stopped", ());

    // Gửi 'q' để ffmpeg ghi nốt và đóng file mp4 hợp lệ (không cắt cụt).
    if let Some(mut stdin) = app.state::<RecState>().stdin.lock().unwrap().take() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
}
