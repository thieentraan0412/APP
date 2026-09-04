// Quay màn hình bằng ffmpeg (tải runtime, không bundle) qua gdigrab.
// - Phím tắt Quay lần 1 → bắt đầu; lần 2 → dừng sạch (gửi 'q') → báo frontend đường dẫn mp4.
// - Tạm dừng/Tiếp tục: ffmpeg gdigrab KHÔNG pause tại chỗ được, nên quay theo TỪNG ĐOẠN.
//   Tạm dừng = kết thúc đoạn hiện tại; quay tiếp = mở đoạn mới; dừng hẳn = NỐI các đoạn
//   lại thành 1 mp4 liền mạch (bỏ hẳn khoảng tạm dừng).
// - Quay VÙNG: cùng đường đi, chỉ khác là mỗi đoạn được cắt bằng bộ lọc `crop` (xem Crop).
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, PhysicalSize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Giới hạn độ dài một phiên quay. Chạm mốc → tự dừng như bấm phím tắt dừng (nối đoạn,
// trả video về app). Chỉ tính thời gian THỰC SỰ quay: khoảng tạm dừng không bị trừ vào
// hạn mức, vì nó cũng không nằm trong video xuất ra.
const MAX_RECORD_MS: u64 = 5 * 60 * 1000;
// Nhịp kiểm tra của watchdog. 250ms đủ nhỏ để video không vượt mốc quá vài phần mười giây.
const LIMIT_TICK_MS: u64 = 250;

#[derive(Default)]
pub struct RecState {
    inner: Mutex<Session>,
}

// Vùng cần quay, lưu theo TỈ LỆ (0..1) của khung hình gdigrab thu được — KHÔNG phải toạ độ
// pixel. Lý do: ffmpeg.exe không khai báo DPI-aware, nên trên màn hình scale 125%/150%
// Windows trả cho nó một desktop đã bị thu nhỏ; toạ độ pixel sẽ lệch còn tỉ lệ thì không.
#[derive(Clone, Copy, Debug)]
pub struct Crop {
    pub fx: f64,
    pub fy: f64,
    pub fw: f64,
    pub fh: f64,
    // Cùng vùng đó nhưng theo pixel vật lý trên màn hình (gốc = màn hình chính).
    // CHỈ dùng để đặt khung viền báo đang quay — không dính gì tới việc cắt video.
    pub sx: i32,
    pub sy: i32,
    pub sw: u32,
    pub sh: u32,
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
    // Vùng đang quay (None = toàn màn hình). PHẢI giữ trong suốt phiên quay: đoạn mở
    // sau khi "quay tiếp" cắt sai vùng sẽ khác độ phân giải đoạn trước → nối bằng
    // `-c copy` thất bại, mất trắng bản quay.
    crop: Option<Crop>,
    // Chiều cao tối đa (px) của phiên quay, chốt lúc bắt đầu. PHẢI giữ nguyên suốt phiên
    // vì lý do y hệt `crop`: người dùng đổi Cài đặt giữa chừng mà đoạn sau ra độ phân giải
    // khác thì nối bằng `-c copy` sẽ thất bại, mất trắng bản quay.
    max_h: u32,
    // Tổng thời lượng các đoạn ĐÃ đóng (ms) — dùng để chặn ở MAX_RECORD_MS.
    elapsed_ms: u64,
    // Mốc bắt đầu đoạn đang quay; None khi đang tạm dừng (lúc đó không cộng thời gian).
    seg_started: Option<std::time::Instant>,
    // Số hiệu phiên quay, tăng mỗi lần bắt đầu/dừng. Watchdog nhớ số của phiên mình canh
    // và tự thoát khi lệch — nếu không, watchdog của phiên cũ có thể dừng nhầm phiên mới.
    generation: u64,
}

impl Session {
    // Thời lượng video sẽ xuất ra nếu dừng ngay lúc này = các đoạn đã đóng + đoạn đang quay.
    fn recorded_ms(&self) -> u64 {
        let current = self
            .seg_started
            .map_or(0, |t| t.elapsed().as_millis() as u64);
        self.elapsed_ms + current
    }
}

// Đang quay hay không — để chặn mở lớp chọn vùng đè lên một phiên quay đang chạy.
pub fn is_recording(app: &AppHandle) -> bool {
    app.state::<RecState>().inner.lock().unwrap().recording
}

fn seg_path(index: usize) -> PathBuf {
    std::env::temp_dir().join(format!("capture_rec_seg{index}.mp4"))
}

// Spawn ffmpeg quay 1 đoạn ra file `out`. Thử lại nhiều lần vì ngay sau khi tải,
// Windows Defender có thể đang quét & khóa ffmpeg.exe (os error 32).
fn spawn_segment(
    app: &AppHandle,
    ffmpeg: &PathBuf,
    out: &PathBuf,
    crop: Option<&Crop>,
    max_h: u32,
) -> Result<Child, String> {
    let out_str = out.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(), "gdigrab".into(),
        "-framerate".into(), "24".into(), // 24fps cho nhẹ
        "-i".into(), "desktop".into(),
    ];
    // Quay vùng → cắt theo tỉ lệ khung hình gdigrab thu được (in_w/in_h do ffmpeg tự biết),
    // nên không cần đoán độ phân giải thật của desktop.
    // - Kích thước dùng round() TRƯỚC: tỉ lệ in ra 8 chữ số nên in_w*fw ra 639.9994 chứ
    //   không tròn 640; floor thẳng sẽ ăn bớt 2px của mọi vùng chọn.
    // - floor(../2)*2 vì libx264 + yuv420p BẮT BUỘC cạnh chẵn — kích thước lẻ (người dùng
    //   kéo được 1281×721) làm ffmpeg chết ngay khi khởi động.
    // - Toạ độ dùng floor() (KHÔNG round) để bảo đảm x+w <= in_w: x <= in*fx và
    //   w <= in*fw + 0.5, nên x+w <= in + 0.5; x, w nguyên ⇒ x+w <= in. Nếu round cả hai
    //   thì vùng sát mép phải có thể tràn 1px và ffmpeg từ chối cả phiên quay.
    let mut filters: Vec<String> = Vec::new();
    if let Some(c) = crop {
        filters.push(format!(
            "crop=floor(round(in_w*{fw:.8})/2)*2:floor(round(in_h*{fh:.8})/2)*2:floor(in_w*{fx:.8}):floor(in_h*{fy:.8})",
            fw = c.fw, fh = c.fh, fx = c.fx, fy = c.fy,
        ));
    }
    // Hạ độ phân giải theo mức chất lượng đã chọn. Dùng biểu thức min(...) chứ không phải
    // số cứng để KHÔNG BAO GIỜ phóng to: màn 1080p chọn mức 2K thì giữ nguyên 1080p.
    // - Dấu phẩy trong min() phải escape, nếu không ffmpeg đọc nhầm thành dấu ngăn hai bộ lọc.
    // - Chiều rộng -2 = tự suy theo tỉ lệ và LÀM TRÒN VỀ SỐ CHẴN, bắt buộc với libx264 +
    //   yuv420p (cạnh lẻ là ffmpeg chết ngay lúc khởi động); trunc(../2)*2 lo nốt chiều
    //   cao, vì giữ nguyên ih của một màn hình cao lẻ cũng ra cạnh lẻ y như vậy.
    if max_h > 0 {
        filters.push(format!("scale=-2:trunc(min({max_h}\\,ih)/2)*2"));
    }
    if !filters.is_empty() {
        args.push("-vf".into());
        args.push(filters.join(","));
    }
    args.extend([
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "ultrafast".into(), // không delay khi record
        "-crf".into(), "28".into(),           // cân bằng chất/nặng
        "-pix_fmt".into(), "yuv420p".into(),
        "-movflags".into(), "+faststart".into(),
        out_str,
    ]);

    let mut command = Command::new(ffmpeg);
    command
        .args(&args)
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
        // Lớp chọn vùng đang mở → phím tắt/tray "Quay" sẽ quay nhầm cả lớp overlay vào
        // video. Bỏ qua; người dùng chọn xong vùng (hoặc Esc) rồi hãy quay.
        if !s.recording && crate::capture::region_active(app) {
            return;
        }
        if !s.recording {
            s.busy = true; // khoá re-entrancy TRƯỚC khi start() spawn ffmpeg
        }
        s.recording
    };
    if recording {
        stop(app);
    } else {
        start(app, None); // None = quay toàn màn hình
    }
}

// Bắt đầu quay THEO VÙNG. Gọi sau khi lớp chọn vùng đã ẩn hẳn khỏi màn hình.
pub fn start_region_recording(app: &AppHandle, crop: Crop) {
    {
        let st = app.state::<RecState>();
        let mut s = st.inner.lock().unwrap();
        if s.busy || s.recording {
            return;
        }
        s.busy = true; // khoá re-entrancy TRƯỚC khi start() spawn ffmpeg (H5)
    }
    start(app, Some(crop));
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

fn start(app: &AppHandle, crop: Option<Crop>) {
    // Đọc mức chất lượng NGAY tại đây và giữ nguyên tới hết phiên — xem ghi chú ở
    // Session::max_h về việc mọi đoạn phải cùng độ phân giải mới nối được.
    let max_h = crate::video_quality(app);
    // Chạy trong thread để không treo UI khi lần đầu tải ffmpeg.
    let app = app.clone();
    std::thread::spawn(move || {
        let ffmpeg = match crate::ffmpeg::ensure_ffmpeg(&app) {
            Ok(p) => p,
            Err(e) => {
                clear_busy(&app); // mở khoá re-entrancy khi thất bại (H5)
                // Quay vùng ẩn cửa sổ chính trước khi quay → phải hiện lại, nếu không
                // "video-error" phát vào một cửa sổ đang ẩn và người dùng không thấy gì.
                show_main(&app);
                let _ = app.emit("video-error", format!("Không chuẩn bị được ffmpeg: {e}"));
                return;
            }
        };

        let out = seg_path(0);
        match spawn_segment(&app, &ffmpeg, &out, crop.as_ref(), max_h) {
            Ok(mut child) => {
                let generation = {
                    let st = app.state::<RecState>();
                    let mut s = st.inner.lock().unwrap();
                    s.stdin = child.stdin.take();
                    s.child = Some(child);
                    s.recording = true;
                    s.paused = false;
                    s.ffmpeg = Some(ffmpeg);
                    s.segments = Vec::new();
                    s.seg_index = 0;
                    s.crop = crop;
                    s.max_h = max_h;
                    s.busy = false; // khởi động xong
                    s.elapsed_ms = 0;
                    s.seg_started = Some(std::time::Instant::now());
                    s.generation = s.generation.wrapping_add(1);
                    s.generation
                };
                spawn_limit_watchdog(&app, generation);
                let _ = app.emit("recording-started", ());
                match &crop {
                    // Quay vùng: KHÔNG hiện popup báo — nó nằm giữa màn hình nên sẽ lọt vào
                    // những khung hình đầu của video nếu vùng chọn trùm qua giữa màn hình.
                    // Thay bằng khung viền bao quanh vùng (nằm ngoài nên không vào video).
                    Some(c) => show_border(&app, c),
                    None => show_notify(&app),
                }
            }
            Err(last_err) => {
                clear_busy(&app);
                hide_border(&app);
                show_main(&app); // xem lý do ở nhánh lỗi ffmpeg phía trên
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

// Canh phiên quay, chạm MAX_RECORD_MS thì dừng hộ người dùng. Đi qua đúng `stop()` như khi
// bấm phím tắt nên vẫn nối đoạn, hiện lại cửa sổ chính và bắn "video-ready" — người dùng
// nhận được bản quay 5 phút hoàn chỉnh chứ không mất.
fn spawn_limit_watchdog(app: &AppHandle, generation: u64) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(LIMIT_TICK_MS));
        let reached = {
            let st = app.state::<RecState>();
            let s = st.inner.lock().unwrap();
            // Phiên đã dừng, hoặc đây là watchdog của phiên cũ → hết việc.
            if !s.recording || s.generation != generation {
                return;
            }
            // Đang pause/resume dở dang: nhường cho chuyển trạng thái đó xong đã, tick sau
            // tính lại. Dừng chen ngang lúc này dễ giành mất `child`/`stdin` của nó (H5).
            !s.busy && s.recorded_ms() >= MAX_RECORD_MS
        };
        if reached {
            // Bắn trước khi dừng để app kịp giải thích vì sao đang quay lại tự tắt.
            let _ = app.emit("recording-limit", ());
            stop(&app);
            return;
        }
    });
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
            // Chốt thời lượng đoạn vừa đóng TRƯỚC khi bỏ mốc — sau dòng này đồng hồ đứng
            // yên cho tới khi quay tiếp.
            s.elapsed_ms = s.recorded_ms();
            s.seg_started = None;
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
        let (ffmpeg, new_index, crop, max_h) = {
            let mut s = st.inner.lock().unwrap();
            if !s.recording || !s.paused {
                s.busy = false; // (H5)
                return;
            }
            // Giữ nguyên vùng của phiên quay → mọi đoạn cùng độ phân giải để nối được.
            (s.ffmpeg.clone(), s.seg_index + 1, s.crop, s.max_h)
        };
        let ffmpeg = match ffmpeg {
            Some(f) => f,
            None => {
                clear_busy(&app);
                return;
            }
        };
        let out = seg_path(new_index);
        match spawn_segment(&app, &ffmpeg, &out, crop.as_ref(), max_h) {
            Ok(mut child) => {
                {
                    let mut s = st.inner.lock().unwrap();
                    s.stdin = child.stdin.take();
                    s.child = Some(child);
                    s.seg_index = new_index;
                    s.paused = false;
                    s.busy = false; // quay tiếp xong (H5)
                    s.seg_started = Some(std::time::Instant::now()); // đồng hồ chạy lại
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
        // Đổi số phiên → watchdog đang canh phiên này thoát ngay, không đụng vào phiên sau.
        s.generation = s.generation.wrapping_add(1);
        s.elapsed_ms = 0;
        s.seg_started = None;
    }
    let _ = app.emit("recording-stopped", ());
    // Ẩn thông báo quay nếu vẫn còn hiện
    if let Some(notify) = app.get_webview_window("rec_notify") {
        let _ = notify.hide();
    }
    hide_border(app);
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
            s.crop = None; // phiên quay kết thúc → lần quay sau mặc định toàn màn hình
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
                // Encode xong (có thể mất vài giây, người dùng đã chuyển sang việc khác)
                // → gọi lại cho chắc, để xem/lưu video ngay.
                crate::focus_main(&app);
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

// Khoảng hở giữa vùng quay và cửa sổ khung viền, tính bằng pixel VẬT LÝ.
// Nét viền 2px CSS ăn tối đa 4px vật lý (phóng to 200%), còn vùng ffmpeg cắt có thể lệch
// thêm 1px do làm tròn xuống chẵn → 6 cho dư 1-2px, bảo đảm không nét nào lọt vào video.
const BORDER_GAP: i32 = 6;

// Hiện khung viền bao quanh (KHÔNG đè lên) vùng đang quay.
fn show_border(app: &AppHandle, c: &Crop) {
    let Some(win) = app.get_webview_window("rec_border") else { return };
    let g = BORDER_GAP;
    let _ = win.set_position(PhysicalPosition::new(c.sx - g, c.sy - g));
    let _ = win.set_size(PhysicalSize::new(
        c.sw + (g as u32) * 2,
        c.sh + (g as u32) * 2,
    ));
    // Click xuyên qua: khung viền chỉ để nhìn, không được chặn thao tác của người dùng
    // với ứng dụng đang nằm dưới nó suốt thời gian quay.
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.show();
    let _ = win.set_always_on_top(true);
}

fn hide_border(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("rec_border") {
        let _ = win.hide();
    }
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
    }
    crate::focus_main(app);
}
