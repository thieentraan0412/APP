// Quay toàn màn hình bằng ffmpeg (sidecar) qua gdigrab.
// Bấm phím tắt lần 1 → bắt đầu; lần 2 → dừng sạch (gửi 'q') → báo frontend đường dẫn mp4.
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
pub struct RecState {
    child: Mutex<Option<CommandChild>>,
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
    let out = std::env::temp_dir().join("capture_rec.mp4");
    let out_str = out.to_string_lossy().to_string();

    let sidecar = match app.shell().sidecar("ffmpeg") {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit("video-error", format!("Không tìm thấy ffmpeg: {e}"));
            return;
        }
    };

    let cmd = sidecar.args([
        "-y",
        "-f", "gdigrab",
        "-framerate", "24",       // 24fps thay vì 30 → nhẹ hơn ~20%
        "-i", "desktop",
        "-c:v", "libx264",
        "-preset", "ultrafast",   // giữ ultrafast để không delay khi record
        "-crf", "28",             // CRF 28: cân bằng chất/nặng (default ~23 → file to hơn nhiều)
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", // metadata đầu file → stream nhanh hơn
        out_str.as_str(),
    ]);

    match cmd.spawn() {
        Ok((mut rx, child)) => {
            {
                let st = app.state::<RecState>();
                *st.child.lock().unwrap() = Some(child);
                *st.recording.lock().unwrap() = true;
            }
            let _ = app.emit("recording-started", ());

            // Theo dõi: khi ffmpeg kết thúc → báo frontend đường dẫn file để upload.
            let app2 = app.clone();
            let out2 = out.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    if let CommandEvent::Terminated(_) = ev {
                        break;
                    }
                }
                let _ = app2.emit("video-ready", out2.to_string_lossy().to_string());
                if let Some(win) = app2.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            });
        }
        Err(e) => {
            let _ = app.emit("video-error", format!("Không quay được: {e}"));
        }
    }
}

fn stop(app: &AppHandle) {
    *app.state::<RecState>().recording.lock().unwrap() = false;
    let _ = app.emit("recording-stopped", ());

    let child = app.state::<RecState>().child.lock().unwrap().take();
    if let Some(mut child) = child {
        // Gửi 'q' để ffmpeg ghi nốt và đóng file mp4 hợp lệ (không cắt cụt).
        let _ = child.write(b"q\n");
    }
}
