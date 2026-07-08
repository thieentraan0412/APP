// Quay toàn màn hình bằng ffmpeg (tải runtime, không bundle) qua gdigrab.
// - Phím tắt Quay lần 1 → bắt đầu; lần 2 → dừng sạch (gửi 'q') → báo frontend đường dẫn mp4.
// - Tạm dừng/Tiếp tục: ffmpeg gdigrab KHÔNG pause tại chỗ được, nên quay theo TỪNG ĐOẠN.
//   Tạm dừng = kết thúc đoạn hiện tại; quay tiếp = mở đoạn mới; dừng hẳn = NỐI các đoạn
//   lại thành 1 mp4 liền mạch (bỏ hẳn khoảng tạm dừng).
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct RecState {
    inner: Mutex<Session>,
}

#[derive(Default)]
struct Session {
    recording: bool,
    paused: bool,
    // Đang trong một chuyển trạng thái có spawn/chờ ffmpeg (start/resume/pause). Bật NGAY
    // trong lock trước khi spawn để bấm phím 2 lần nhanh không sinh tiến trình trùng (H5).
    busy: bool,
    ffmpeg: Option<PathBuf>,     // đường dẫn ffmpeg.exe (giữ lại để mở đoạn mới nhanh)
    child: Option<Child>,        // tiến trình ffmpeg của đoạn đang quay
    stdin: Option<ChildStdin>,   // stdin để gửi 'q' kết thúc đoạn
    segments: Vec<PathBuf>,      // các đoạn đã kết thúc, chờ nối
    seg_index: usize,            // số thứ tự đoạn đang quay
}

fn seg_path(index: usize) -> PathBuf {
    std::env::temp_dir().join(format!("capture_rec_seg{index}.mp4"))
}

// Spawn ffmpeg quay 1 đoạn ra file `out`. Thử lại nhiều lần vì ngay sau khi tải,
// Windows Defender có thể đang quét & khóa ffmpeg.exe (os error 32).
fn spawn_segment(app: &AppHandle, ffmpeg: &PathBuf, out: &PathBuf) -> Result<Child, String> {
    let out_str = out.to_string_lossy().to_string();
    let mut command = Command::new(ffmpeg);
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

    let mut last_err = String::new();
    for attempt in 0..8 {
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(e) => {
                last_err = e.to_string();
                if attempt == 0 {
                    let _ = app.emit("ffmpeg-preparing", ());
                }
                std::thread::sleep(std::time::Duration::from_millis(700));
            }
        }
    }
    Err(last_err)
}

pub fn toggle_recording(app: &AppHandle) {
    let recording = {
        let st = app.state::<RecState>();
        let mut s = st.inner.lock().unwrap();
        if s.busy {
            return; // đang khởi động dở → bỏ qua, tránh spawn ffmpeg trùng (H5)
        }
        if !s.recording {
            s.busy = true; // khoá re-entrancy TRƯỚC khi start() spawn ffmpeg
        }
        s.recording
    };
    if recording {
        stop(app);
    } else {
        start(app);
    }
}

// Ctrl+Shift+H: chỉ có tác dụng khi đang quay — đảo giữa tạm dừng và quay tiếp.
pub fn toggle_pause(app: &AppHandle) {
    let (recording, paused) = {
        let st = app.state::<RecState>();
        let mut s = st.inner.lock().unwrap();
        if s.busy || !s.recording {
            return; // đang chuyển trạng thái dở hoặc không quay → bỏ qua (H5)
        }
        s.busy = true; // khoá trước khi pause/resume spawn/chờ ffmpeg
        (s.recording, s.paused)
    };
    let _ = recording;
    if paused {
        resume(app);
    } else {
        pause(app);
    }
}

fn start(app: &AppHandle) {
    // Chạy trong thread để không treo UI khi lần đầu tải ffmpeg.
    let app = app.clone();
    std::thread::spawn(move || {
        let ffmpeg = match crate::ffmpeg::ensure_ffmpeg(&app) {
            Ok(p) => p,
            Err(e) => {
                clear_busy(&app); // mở khoá re-entrancy khi thất bại (H5)
                let _ = app.emit("video-error", format!("Không chuẩn bị được ffmpeg: {e}"));
                return;
            }
        };

        let out = seg_path(0);
        match spawn_segment(&app, &ffmpeg, &out) {
            Ok(mut child) => {
                {
                    let st = app.state::<RecState>();
                    let mut s = st.inner.lock().unwrap();
                    s.stdin = child.stdin.take();
                    s.child = Some(child);
                    s.recording = true;
                    s.paused = false;
                    s.ffmpeg = Some(ffmpeg);
                    s.segments = Vec::new();
                    s.seg_index = 0;
                    s.busy = false; // khởi động xong
                }
                let _ = app.emit("recording-started", ());
                show_notify(&app);
            }
            Err(last_err) => {
                clear_busy(&app);
                let _ = app.emit("video-error", format!("Không quay được: {last_err}"));
            }
        }
    });
}

// Mở khoá re-entrancy (H5) — dùng khi một chuyển trạng thái spawn/chờ kết thúc.
fn clear_busy(app: &AppHandle) {
    let st = app.state::<RecState>();
    st.inner.lock().unwrap().busy = false;
}

fn pause(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let st = app.state::<RecState>();
        // Lấy tiến trình đoạn hiện tại ra khỏi state, đánh dấu paused.
        let (mut child, stdin, seg_index) = {
            let mut s = st.inner.lock().unwrap();
            if !s.recording || s.paused {
                s.busy = false; // (H5)
                return;
            }
            s.paused = true;
            (s.child.take(), s.stdin.take(), s.seg_index)
        };
        // Gửi 'q' để ffmpeg ghi nốt & đóng file đoạn cho hợp lệ, rồi chờ nó thoát.
        if let Some(mut sin) = stdin {
            let _ = sin.write_all(b"q\n");
            let _ = sin.flush();
        }
        if let Some(ref mut c) = child {
            let _ = c.wait();
        }
        {
            let mut s = st.inner.lock().unwrap();
            s.segments.push(seg_path(seg_index));
            s.busy = false; // tạm dừng xong (H5)
        }
        let _ = app.emit("recording-paused", ());
    });
}

fn resume(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let st = app.state::<RecState>();
        let (ffmpeg, new_index) = {
            let mut s = st.inner.lock().unwrap();
            if !s.recording || !s.paused {
                s.busy = false; // (H5)
                return;
            }
            (s.ffmpeg.clone(), s.seg_index + 1)
        };
        let ffmpeg = match ffmpeg {
            Some(f) => f,
            None => {
                clear_busy(&app);
                return;
            }
        };
        let out = seg_path(new_index);
        match spawn_segment(&app, &ffmpeg, &out) {
            Ok(mut child) => {
                {
                    let mut s = st.inner.lock().unwrap();
                    s.stdin = child.stdin.take();
                    s.child = Some(child);
                    s.seg_index = new_index;
                    s.paused = false;
                    s.busy = false; // quay tiếp xong (H5)
                }
                let _ = app.emit("recording-resumed", ());
            }
            Err(e) => {
                clear_busy(&app);
                let _ = app.emit("video-error", format!("Không quay tiếp được: {e}"));
            }
        }
    });
}

fn stop(app: &AppHandle) {
    {
        let st = app.state::<RecState>();
        let mut s = st.inner.lock().unwrap();
        if !s.recording {
            return;
        }
        s.recording = false;
    }
    let _ = app.emit("recording-stopped", ());
    // Ẩn thông báo quay nếu vẫn còn hiện
    if let Some(notify) = app.get_webview_window("rec_notify") {
        let _ = notify.hide();
    }
    show_main(app);

    // Kết thúc đoạn cuối + nối tất cả đoạn trong thread (child.wait + ffmpeg concat có thể lâu).
    let app = app.clone();
    std::thread::spawn(move || {
        let st = app.state::<RecState>();
        let (mut child, stdin, paused, seg_index, mut segments, ffmpeg) = {
            let mut s = st.inner.lock().unwrap();
            (
                s.child.take(),
                s.stdin.take(),
                s.paused,
                s.seg_index,
                std::mem::take(&mut s.segments),
                s.ffmpeg.clone(),
            )
        };
        // Nếu đang quay (không phải đang tạm dừng) thì đoạn hiện tại chưa được đóng → đóng nốt.
        if !paused {
            if let Some(mut sin) = stdin {
                let _ = sin.write_all(b"q\n");
                let _ = sin.flush();
            }
            if let Some(ref mut c) = child {
                let _ = c.wait();
            }
            segments.push(seg_path(seg_index));
        }
        {
            let mut s = st.inner.lock().unwrap();
            s.paused = false;
        }

        // Tên duy nhất mỗi lần quay (theo timestamp) — tránh trùng với file của lần
        // quay trước đang được màn hình kết quả giữ. Nếu dùng chung 1 tên cố định,
        // khi quay lần 2 frontend sẽ remove_temp(path cũ) trùng path mới → xoá nhầm
        // file vừa quay → lỗi "không đọc được video".
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let final_out = std::env::temp_dir().join(format!("capture_rec_{stamp}.mp4"));
        match finalize(&app, ffmpeg.as_ref(), &segments, &final_out) {
            Ok(path) => {
                let _ = app.emit("video-ready", path.to_string_lossy().to_string());
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            Err(e) => {
                let _ = app.emit("video-error", e);
            }
        }
    });
}

// Nối các đoạn thành 1 mp4. 1 đoạn → chỉ copy sang tên cuối; nhiều đoạn → dùng concat demuxer.
fn finalize(
    app: &AppHandle,
    ffmpeg: Option<&PathBuf>,
    segments: &[PathBuf],
    out: &PathBuf,
) -> Result<PathBuf, String> {
    let _ = app;
    if segments.is_empty() {
        return Err("Không có dữ liệu quay".into());
    }
    if segments.len() == 1 {
        std::fs::copy(&segments[0], out).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&segments[0]);
        return Ok(out.clone());
    }

    let ffmpeg = ffmpeg.ok_or_else(|| "Thiếu ffmpeg để nối video".to_string())?;
    // File danh sách cho concat demuxer. Dùng '/' và escape ' để an toàn với đường dẫn Windows.
    let list_path = std::env::temp_dir().join("capture_rec_concat.txt");
    let mut list = String::new();
    for seg in segments {
        let p = seg.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
        list.push_str(&format!("file '{p}'\n"));
    }
    std::fs::write(&list_path, &list).map_err(|e| e.to_string())?;

    let list_str = list_path.to_string_lossy().to_string();
    let out_str = out.to_string_lossy().to_string();
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", list_str.as_str(),
            "-c", "copy",
            "-movflags", "+faststart",
            out_str.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let status = command.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Nối video các đoạn thất bại".into());
    }
    for seg in segments {
        let _ = std::fs::remove_file(seg);
    }
    let _ = std::fs::remove_file(&list_path);
    Ok(out.clone())
}

// Hiện cửa sổ thông báo nhỏ ở giữa màn hình, tự ẩn sau 500ms.
fn show_notify(app: &AppHandle) {
    if let Some(notify) = app.get_webview_window("rec_notify") {
        if let Ok(Some(mon)) = notify.primary_monitor() {
            let scale = mon.scale_factor();
            let mw = mon.size().width as f64 / scale;
            let mh = mon.size().height as f64 / scale;
            let mx = mon.position().x as f64 / scale;
            let my = mon.position().y as f64 / scale;
            let _ = notify.set_position(LogicalPosition::new(
                mx + (mw - 260.0) / 2.0,
                my + (mh - 54.0) / 2.0,
            ));
        }
        let _ = notify.show();
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Some(n) = app2.get_webview_window("rec_notify") {
                let _ = n.hide();
            }
        });
    }
}

// Hiện app ngay khi dừng quay (không đợi video encode xong), đưa về giữa màn hình.
fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        if let Ok(Some(mon)) = main.primary_monitor() {
            let scale = mon.scale_factor();
            let mw = mon.size().width as f64 / scale;
            let mh = mon.size().height as f64 / scale;
            let mx = mon.position().x as f64 / scale;
            let my = mon.position().y as f64 / scale;
            if let Ok(size) = main.outer_size() {
                let (ww, wh) = (size.width as f64 / scale, size.height as f64 / scale);
                let _ = main.set_position(LogicalPosition::new(
                    mx + (mw - ww) / 2.0,
                    my + (mh - wh) / 2.0,
                ));
            }
        }
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}
