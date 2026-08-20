use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ExtendedColorType, ImageEncoder,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use xcap::Monitor;

pub struct RegionState {
    pub raw: Mutex<Option<Vec<u8>>>,
    pub w:   Mutex<u32>,
    pub h:   Mutex<u32>,
    // Đang trong quá trình chọn vùng (overlay mở). Dùng để chặn chụp full màn hình
    // xen ngang làm tráo kết quả (H2).
    pub active: AtomicBool,
    // Overlay đang mở để chọn vùng QUAY VIDEO (false = chọn vùng chụp ảnh). Overlay là
    // một cửa sổ dùng chung cho cả hai, nên nó hỏi cờ này để biết mình đang ở chế độ nào.
    pub record: AtomicBool,
}

impl Default for RegionState {
    fn default() -> Self {
        RegionState {
            raw: Mutex::new(None),
            w:   Mutex::new(0),
            h:   Mutex::new(0),
            active: AtomicBool::new(false),
            record: AtomicBool::new(false),
        }
    }
}

// Payload sự kiện "image-captured". Cờ `region` cho frontend biết ảnh đến từ CẮT VÙNG
// (Alt+A) hay chụp full — chỉ ảnh cắt mới tự dò QR.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedImage {
    pub data_url: String,
    pub region: bool,
}

// Có đang chụp vùng không (để lib.rs chặn chụp full xen ngang).
pub fn region_active(app: &AppHandle) -> bool {
    app.state::<RegionState>().active.load(Ordering::SeqCst)
}

fn capture_primary_raw() -> Result<(Vec<u8>, u32, u32), String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or("Không tìm thấy màn hình nào")?;

    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    let raw = img.into_raw(); // RGBA8
    Ok((raw, w, h))
}

fn rgba_to_data_url(raw: &[u8], w: u32, h: u32) -> Result<String, String> {
    let capacity = (w * h * 4) as usize + 1024;
    let mut png: Vec<u8> = Vec::with_capacity(capacity);
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
        .write_image(raw, w, h, ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    let b64 = general_purpose::STANDARD.encode(&png);
    Ok(format!("data:image/png;base64,{}", b64))
}

fn copy_rgba_to_clipboard(raw: Vec<u8>, w: u32, h: u32) {
    std::thread::spawn(move || {
        if let Ok(mut cb) = Clipboard::new() {
            let img_data = ImageData {
                width: w as usize,
                height: h as usize,
                bytes: raw.into(),
            };
            let _ = cb.set_image(img_data);
        }
    });
}

pub fn capture_primary_png_base64() -> Result<String, String> {
    let (raw, w, h) = capture_primary_raw()?;
    copy_rgba_to_clipboard(raw.clone(), w, h);
    rgba_to_data_url(&raw, w, h)
}

#[tauri::command]
pub fn capture_screen() -> Result<String, String> {
    capture_primary_png_base64()
}

// Ẩn main window, chờ 150ms để nó biến khỏi màn hình, mở overlay chọn vùng.
// `record = false` (chụp ảnh): chụp full trước rồi mới mở overlay, vì ảnh kết quả được
// cắt ra từ ảnh chụp này. `record = true` (quay video): KHÔNG cần chụp — overlay trong
// suốt làm tối trực tiếp trên màn hình thật, và video do ffmpeg thu sau đó.
pub fn begin_region_selection(app: AppHandle, record: bool) {
    // Overlay đã mở rồi → bỏ qua, tránh đè hai phiên chọn vùng lên nhau.
    if region_active(&app) {
        return;
    }
    // Đang quay dở → không cho mở lớp chọn vùng (chọn xong cũng không quay được).
    if record && crate::record::is_recording(&app) {
        return;
    }
    std::thread::spawn(move || {
        let state = app.state::<RegionState>();
        // Đánh dấu đang chọn vùng NGAY từ đầu để chặn chụp full xen ngang (H2).
        state.active.store(true, Ordering::SeqCst);
        state.record.store(record, Ordering::SeqCst);
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        std::thread::sleep(std::time::Duration::from_millis(150));

        if !record {
            match capture_primary_raw() {
                Ok((raw, w, h)) => {
                    *state.raw.lock().unwrap() = Some(raw);
                    *state.w.lock().unwrap() = w;
                    *state.h.lock().unwrap() = h;
                }
                Err(e) => {
                    // Chụp lỗi → overlay không mở → hết trạng thái chọn vùng.
                    state.active.store(false, Ordering::SeqCst);
                    state.record.store(false, Ordering::SeqCst);
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.show();
                    }
                    let _ = app.emit("capture-error", e);
                    return;
                }
            }
        }

        if let Some(sel) = app.get_webview_window("region_selector") {
            let _ = sel.show();
            let _ = sel.set_focus();
        }
    });
}

pub fn begin_region_capture(app: AppHandle) {
    begin_region_selection(app, false);
}

#[tauri::command]
pub fn start_region_capture(app: AppHandle) {
    begin_region_selection(app, false);
}

#[tauri::command]
pub fn start_region_record(app: AppHandle) {
    begin_region_selection(app, true);
}

// Overlay hỏi mình đang mở ở chế độ nào (nó dùng chung cho chụp ảnh và quay video).
#[tauri::command]
pub fn region_mode(state: tauri::State<'_, RegionState>) -> String {
    if state.record.load(Ordering::SeqCst) {
        "record".into()
    } else {
        "capture".into()
    }
}

// Nhận tọa độ physical px (đã nhân DPI ở frontend), crop ảnh, gửi về main.
#[tauri::command]
pub fn confirm_region_capture(
    app: AppHandle,
    state: tauri::State<'_, RegionState>,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    state.active.store(false, Ordering::SeqCst); // hết chụp vùng (H2)
    if let Some(sel) = app.get_webview_window("region_selector") {
        let _ = sel.hide();
    }
    crate::focus_main(&app);

    // Crop trong closure để mọi lỗi đều báo về main qua "capture-error" (H3): trước đây
    // lỗi crop chỉ trả Err (RegionSelector không .catch) → overlay đã đóng, main hiện lên
    // mà không có ảnh và không báo gì → thất bại im lặng.
    let result: Result<String, String> = (|| {
        let guard = state.raw.lock().unwrap();
        let raw = guard.as_ref().ok_or("Không có ảnh trong bộ nhớ")?;
        let full_w = *state.w.lock().unwrap();
        let full_h = *state.h.lock().unwrap();

        // Clamp tránh out-of-bounds
        let x2 = (x + w).min(full_w);
        let y2 = (y + h).min(full_h);
        let cw = x2.saturating_sub(x);
        let ch = y2.saturating_sub(y);
        if cw == 0 || ch == 0 {
            return Err("Vùng chọn quá nhỏ".into());
        }

        let stride = full_w as usize * 4;
        let mut cropped = Vec::with_capacity(cw as usize * ch as usize * 4);
        for row in y..y2 {
            let start = row as usize * stride + x as usize * 4;
            cropped.extend_from_slice(&raw[start..start + cw as usize * 4]);
        }

        copy_rgba_to_clipboard(cropped.clone(), cw, ch);
        rgba_to_data_url(&cropped, cw, ch)
    })();

    match result {
        Ok(data_url) => {
            let _ = app.emit("image-captured", CapturedImage { data_url, region: true });
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("capture-error", e.clone());
            Err(e)
        }
    }
}

#[tauri::command]
pub fn cancel_region_capture(app: AppHandle) {
    let state = app.state::<RegionState>();
    state.active.store(false, Ordering::SeqCst); // hết chọn vùng (H2)
    state.record.store(false, Ordering::SeqCst);
    if let Some(sel) = app.get_webview_window("region_selector") {
        let _ = sel.hide();
    }
    crate::focus_main(&app);
    let _ = app.emit("region-cancelled", ());
}

// Người dùng chốt vùng và đã đếm ngược xong → bắt đầu quay.
// fx/fy/fw/fh là tỉ lệ (0..1) so với MÀN HÌNH chứa overlay.
#[tauri::command]
pub fn confirm_region_record(
    app: AppHandle,
    fx: f64,
    fy: f64,
    fw: f64,
    fh: f64,
) -> Result<(), String> {
    let crop = match to_virtual_crop(&app, fx, fy, fw, fh) {
        Ok(c) => c,
        Err(e) => {
            cancel_region_capture(app.clone());
            let _ = app.emit("video-error", e.clone());
            return Err(e);
        }
    };

    {
        let state = app.state::<RegionState>();
        state.active.store(false, Ordering::SeqCst);
        state.record.store(false, Ordering::SeqCst);
    }
    if let Some(sel) = app.get_webview_window("region_selector") {
        let _ = sel.hide();
    }
    // Cửa sổ chính vẫn ẩn: nó đang nằm giữa màn hình nên rất dễ lọt vào vùng quay.
    // stop() sẽ tự hiện lại khi dừng quay.

    // gdigrab thu đúng những gì đang hiển thị → phải chờ overlay biến hẳn khỏi màn hình,
    // nếu không lớp làm tối + viền chọn sẽ nằm trong mấy khung hình đầu của video.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        crate::record::start_region_recording(&app2, crop);
    });
    Ok(())
}

// Đổi tỉ lệ theo màn hình chứa overlay → tỉ lệ theo TOÀN BỘ virtual desktop, vì gdigrab
// với input "desktop" thu cả vùng bao của mọi màn hình chứ không riêng màn hình chính.
fn to_virtual_crop(
    app: &AppHandle,
    fx: f64,
    fy: f64,
    fw: f64,
    fh: f64,
) -> Result<crate::record::Crop, String> {
    let sel = app
        .get_webview_window("region_selector")
        .ok_or("Không tìm thấy lớp chọn vùng")?;
    let mon = sel
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(sel.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("Không tìm thấy màn hình nào")?;
    let (mp, ms) = (mon.position(), mon.size());

    // Hộp bao mọi màn hình, theo pixel vật lý.
    let mut left = mp.x;
    let mut top = mp.y;
    let mut right = mp.x + ms.width as i32;
    let mut bottom = mp.y + ms.height as i32;
    for m in sel.available_monitors().map_err(|e| e.to_string())? {
        let (p, s) = (m.position(), m.size());
        left = left.min(p.x);
        top = top.min(p.y);
        right = right.max(p.x + s.width as i32);
        bottom = bottom.max(p.y + s.height as i32);
    }
    let vw = (right - left) as f64;
    let vh = (bottom - top) as f64;
    if vw <= 0.0 || vh <= 0.0 {
        return Err("Không đọc được kích thước màn hình".into());
    }

    let x = (mp.x - left) as f64 + fx * ms.width as f64;
    let y = (mp.y - top) as f64 + fy * ms.height as f64;
    Ok(crate::record::Crop {
        fx: (x / vw).clamp(0.0, 1.0),
        fy: (y / vh).clamp(0.0, 1.0),
        fw: (fw * ms.width as f64 / vw).clamp(0.0, 1.0),
        fh: (fh * ms.height as f64 / vh).clamp(0.0, 1.0),
        // Toạ độ đặt cửa sổ dùng gốc màn hình chính (mp.x/mp.y đã theo gốc đó), khác với
        // gốc của hộp bao ở trên — nên tính riêng chứ không tái dùng x/y.
        sx: mp.x + (fx * ms.width as f64).round() as i32,
        sy: mp.y + (fy * ms.height as f64).round() as i32,
        sw: (fw * ms.width as f64).round().max(1.0) as u32,
        sh: (fh * ms.height as f64).round().max(1.0) as u32,
    })
}
