use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ExtendedColorType, ImageEncoder,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
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

// Hộp bao mọi màn hình theo pixel vật lý. Gốc toạ độ là màn hình chính nên left/top âm khi có
// màn nằm bên trái hoặc phía trên nó.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    left: i32,
    top: i32,
    w: u32,
    h: u32,
}

fn bounding_box(rects: impl Iterator<Item = (i32, i32, u32, u32)>) -> Option<Bounds> {
    let (mut left, mut top, mut right, mut bottom) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for (x, y, w, h) in rects {
        left = left.min(x);
        top = top.min(y);
        right = right.max(x + w as i32);
        bottom = bottom.max(y + h as i32);
    }
    (right > left && bottom > top).then(|| Bounds {
        left,
        top,
        w: (right - left) as u32,
        h: (bottom - top) as u32,
    })
}

fn monitor_rect(m: &Monitor) -> Option<(i32, i32, u32, u32)> {
    Some((m.x().ok()?, m.y().ok()?, m.width().ok()?, m.height().ok()?))
}

fn monitors_bounds(monitors: &[Monitor]) -> Option<Bounds> {
    bounding_box(monitors.iter().filter_map(monitor_rect))
}

fn desktop_bounds() -> Result<Bounds, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    monitors_bounds(&monitors).ok_or("Không tìm thấy màn hình nào".into())
}

// Dán ảnh nguồn vào ảnh đích tại (ox, oy), phần tràn ra ngoài thì bỏ. Dùng kích thước thật của
// ảnh chụp chứ không tin số màn hình báo: lệch nhau thì thiếu vài px còn hơn panic.
fn blit(dst: &mut [u8], dst_w: u32, dst_h: u32, src: &[u8], src_w: u32, src_h: u32, ox: u32, oy: u32) {
    let row_len = src_w.min(dst_w.saturating_sub(ox)) as usize * 4;
    let rows = src_h.min(dst_h.saturating_sub(oy)) as usize;
    for row in 0..rows {
        let d = (oy as usize + row) * dst_w as usize * 4 + ox as usize * 4;
        let s = row * src_w as usize * 4;
        dst[d..d + row_len].copy_from_slice(&src[s..s + row_len]);
    }
}

// Chụp MỌI màn hình rồi ghép thành một ảnh đúng theo vị trí của chúng, để vùng chọn nằm ở màn
// nào (hay vắt qua hai màn) cũng cắt ra được. Góc hộp bao không có màn nào (hai màn lệch cao
// thấp) để đen đục. Một màn chụp lỗi thì màn đó đen, vẫn cho cắt trên các màn còn lại; chỉ báo
// lỗi khi không chụp được màn nào.
fn capture_virtual_raw() -> Result<(Vec<u8>, Bounds), String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let bounds = monitors_bounds(&monitors).ok_or("Không tìm thấy màn hình nào")?;
    let mut raw = [0u8, 0, 0, 255].repeat(bounds.w as usize * bounds.h as usize);

    let mut captured = false;
    let mut last_err = None;
    for mon in &monitors {
        let Some((x, y, _, _)) = monitor_rect(mon) else { continue };
        match mon.capture_image() {
            Ok(img) => {
                let (ox, oy) = ((x - bounds.left) as u32, (y - bounds.top) as u32);
                blit(&mut raw, bounds.w, bounds.h, img.as_raw(), img.width(), img.height(), ox, oy);
                captured = true;
            }
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    if !captured {
        return Err(last_err.unwrap_or("Không chụp được màn hình nào".into()));
    }
    Ok((raw, bounds))
}

// Trải overlay phủ kín hộp bao. Phải kiểm tra lại rồi đặt lần nữa: mỗi khi cửa sổ sang vùng có
// DPI khác, tao tự co giãn nó theo WM_DPICHANGED nên kích thước vừa đặt có thể bị đổi. Hàm đọc
// cũng là lệnh đồng bộ, nên chạy sau khi các lệnh đặt đã xong.
fn cover_desktop(sel: &WebviewWindow, b: Bounds) {
    let pos = PhysicalPosition::new(b.left, b.top);
    let size = PhysicalSize::new(b.w, b.h);
    for _ in 0..3 {
        let _ = sel.set_position(pos);
        let _ = sel.set_size(size);
        if sel.outer_position().ok() == Some(pos) && sel.outer_size().ok() == Some(size) {
            break;
        }
    }
}

// Đổi vùng chọn theo tỉ lệ (0..1) của overlay → pixel trên ảnh ghép, chặn trong khung ảnh.
fn frac_to_px(fx: f64, fy: f64, fw: f64, fh: f64, full_w: u32, full_h: u32) -> (u32, u32, u32, u32) {
    let px = |f: f64, full: u32| (f * full as f64).round().clamp(0.0, full as f64) as u32;
    let (x, y) = (px(fx, full_w), px(fy, full_h));
    let (x2, y2) = (px(fx + fw, full_w), px(fy + fh, full_h));
    (x, y, x2.saturating_sub(x), y2.saturating_sub(y))
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

// Kích thước đích của ảnh theo mức chất lượng đã chọn; None = giữ nguyên. `tier` = chiều cao
// ĐÍCH (720 / 1080 / 1440 / 2160), `src_h` = chiều cao cả màn hình nguồn (ảnh toàn màn hình thì
// chính là `h`).
// - Mức ≤ màn hình: thu nhỏ để cao tối đa `tier` như trước — ảnh toàn màn hình ra đúng `tier`,
//   vùng chọn vốn đã thấp hơn `tier` thì giữ nguyên.
// - Mức > màn hình: UPSCALE đúng tỉ lệ tier/src_h — chọn 4K trên màn 1920×1080 thì ảnh toàn màn
//   hình ra đúng 3840×2160, vùng chọn cũng to gấp đôi. Phóng to KHÔNG thêm chi tiết nào, nên
//   Cài đặt ghi rõ "Upscale" để không ai tưởng đó là 4K thật.
// Tách riêng khỏi phần resize để kiểm được bằng số thật; SettingsScreen.tsx (tierOutput) tính
// y hệt để hiện đúng con số — sửa thì sửa cả hai.
fn tier_size(w: u32, h: u32, tier: u32, src_h: u32) -> Option<(u32, u32)> {
    if tier == 0 || w == 0 || h == 0 || src_h == 0 {
        return None;
    }
    if tier > src_h {
        // Tính bằng số nguyên, làm tròn: 1920·1440/1080 = 2560 tròn, không lệch vì số thực.
        let up = |v: u32| ((v as u64 * tier as u64 + src_h as u64 / 2) / src_h as u64).max(1) as u32;
        return Some((up(w), up(h)));
    }
    if h > tier {
        let nw = ((w as f64) * (tier as f64) / (h as f64)).round().max(1.0) as u32;
        return Some((nw, tier));
    }
    None
}

fn scale_to_tier(raw: Vec<u8>, w: u32, h: u32, tier: u32, src_h: u32) -> (Vec<u8>, u32, u32) {
    let Some((nw, nh)) = tier_size(w, h, tier, src_h) else {
        return (raw, w, h);
    };
    // Mượn raw thay vì clone — ảnh 4K là ~33MB, nhân đôi chỉ để đổi kiểu là quá phí.
    let view: image::ImageBuffer<image::Rgba<u8>, &[u8]> =
        match image::ImageBuffer::from_raw(w, h, raw.as_slice()) {
            Some(v) => v,
            None => return (raw, w, h), // buffer không khớp kích thước → thôi, giữ ảnh gốc
        };
    // CatmullRom: nét hơn Triangle ở chữ nhỏ (ảnh chụp màn hình toàn chữ) mà vẫn nhanh
    // hơn Lanczos3 đáng kể — dùng cho cả thu nhỏ lẫn phóng to.
    let out = image::imageops::resize(&view, nw, nh, image::imageops::FilterType::CatmullRom);
    (out.into_raw(), nw, nh)
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

pub fn capture_primary_png_base64(max_h: u32) -> Result<String, String> {
    let (raw, w, h) = capture_primary_raw()?;
    // Đổi cỡ TRƯỚC khi chép clipboard để ảnh dán ra ngoài giống hệt ảnh trong app.
    let (raw, w, h) = scale_to_tier(raw, w, h, max_h, h);
    copy_rgba_to_clipboard(raw.clone(), w, h);
    rgba_to_data_url(&raw, w, h)
}

// Kích thước THẬT (pixel vật lý) của nguồn chụp và nguồn quay. Màn Cài đặt dùng nó để nói
// thẳng mỗi mức chất lượng cho ra ảnh/video bao nhiêu px — nếu không, trên màn 1080p hai
// mức "Full HD" và "2K" cho ra kết quả y hệt nhau mà người dùng không tài nào đoán được
// vì sao. Trả về 4 số: (rộng, cao) màn hình chính — nguồn của ảnh chụp; rồi (rộng, cao)
// hộp bao mọi màn hình — nguồn của video toàn màn hình, vì gdigrab thu cả virtual desktop
// chứ không riêng màn chính.
#[tauri::command]
pub fn capture_sizes() -> Result<(u32, u32, u32, u32), String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let m = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or("Không tìm thấy màn hình nào")?;
    let pw = m.width().map_err(|e| e.to_string())?;
    let ph = m.height().map_err(|e| e.to_string())?;

    // Không đọc được màn nào → lấy tạm màn chính, hơn là trả số âm vô nghĩa.
    let (vw, vh) = monitors_bounds(&monitors).map_or((pw, ph), |b| (b.w, b.h));
    Ok((pw, ph, vw, vh))
}

/// (rộng, cao) màn hình chính — nguồn của ảnh chụp.
pub fn primary_size() -> Option<(u32, u32)> {
    capture_sizes().ok().map(|(w, h, _, _)| (w, h))
}

/// (rộng, cao) hộp bao mọi màn hình — nguồn của video toàn màn hình (gdigrab thu cả desktop).
pub fn virtual_desktop_size() -> Option<(u32, u32)> {
    capture_sizes().ok().map(|(_, _, w, h)| (w, h))
}

#[tauri::command]
pub fn capture_screen(app: AppHandle) -> Result<String, String> {
    capture_primary_png_base64(crate::image_quality(&app))
}

// Ẩn main window, chờ 150ms để nó biến khỏi màn hình, mở overlay chọn vùng.
// `record = false` (chụp ảnh): chụp full trước rồi mới mở overlay, vì ảnh kết quả được
// cắt ra từ ảnh chụp này. `record = true` (quay video): KHÔNG cần chụp — overlay trong
// suốt làm tối trực tiếp trên màn hình thật, và video do ffmpeg thu sau đó.
// Cả hai chế độ overlay đều trải qua mọi màn hình để kéo chọn được ở màn nào cũng vậy.
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

        let bounds = if record {
            desktop_bounds()
        } else {
            capture_virtual_raw().map(|(raw, b)| {
                *state.raw.lock().unwrap() = Some(raw);
                *state.w.lock().unwrap() = b.w;
                *state.h.lock().unwrap() = b.h;
                b
            })
        };
        let bounds = match bounds {
            Ok(b) => b,
            Err(e) => {
                // Lỗi → overlay không mở → hết trạng thái chọn vùng.
                state.active.store(false, Ordering::SeqCst);
                state.record.store(false, Ordering::SeqCst);
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                }
                let _ = app.emit(if record { "video-error" } else { "capture-error" }, e);
                return;
            }
        };

        if let Some(sel) = app.get_webview_window("region_selector") {
            cover_desktop(&sel, bounds);
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

// Nhận vùng chọn theo TỈ LỆ (0..1) của overlay, crop ảnh, gửi về main. Không nhận pixel vì hai
// màn có thể khác mức scale; overlay phủ đúng hộp bao nên tỉ lệ khớp thẳng với ảnh ghép.
#[tauri::command]
pub fn confirm_region_capture(
    app: AppHandle,
    state: tauri::State<'_, RegionState>,
    fx: f64,
    fy: f64,
    fw: f64,
    fh: f64,
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

        let (x, y, cw, ch) = frac_to_px(fx, fy, fw, fh, full_w, full_h);
        if cw == 0 || ch == 0 {
            return Err("Vùng chọn quá nhỏ".into());
        }

        let stride = full_w as usize * 4;
        let mut cropped = Vec::with_capacity(cw as usize * ch as usize * 4);
        for row in y..y + ch {
            let start = row as usize * stride + x as usize * 4;
            cropped.extend_from_slice(&raw[start..start + cw as usize * 4]);
        }

        // Upscale tính theo tỉ lệ của CẢ màn hình chính, không theo vùng hay ảnh ghép: mức 4K
        // trên màn 1080p thì vùng nào cũng to gấp đôi, khớp với con số Cài đặt hiện cho ảnh
        // toàn màn hình.
        let src_h = primary_size().map_or(full_h, |(_, h)| h);
        let (cropped, cw, ch) = scale_to_tier(cropped, cw, ch, crate::image_quality(&app), src_h);
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
// fx/fy/fw/fh là tỉ lệ (0..1) so với overlay, tức cả virtual desktop.
#[tauri::command]
pub fn confirm_region_record(
    app: AppHandle,
    fx: f64,
    fy: f64,
    fw: f64,
    fh: f64,
) -> Result<(), String> {
    let crop = match to_virtual_crop(fx, fy, fw, fh) {
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

// Overlay phủ đúng hộp bao mọi màn hình, và gdigrab với input "desktop" cũng thu đúng hộp đó,
// nên tỉ lệ dùng thẳng được. Chỉ cần tính thêm toạ độ thật để đặt khung viền.
fn to_virtual_crop(fx: f64, fy: f64, fw: f64, fh: f64) -> Result<crate::record::Crop, String> {
    let b = desktop_bounds()?;
    let (vw, vh) = (b.w as f64, b.h as f64);
    Ok(crate::record::Crop {
        fx: fx.clamp(0.0, 1.0),
        fy: fy.clamp(0.0, 1.0),
        fw: fw.clamp(0.0, 1.0),
        fh: fh.clamp(0.0, 1.0),
        sx: b.left + (fx * vw).round() as i32,
        sy: b.top + (fy * vh).round() as i32,
        sw: (fw * vw).round().max(1.0) as u32,
        sh: (fh * vh).round().max(1.0) as u32,
    })
}

#[cfg(test)]
mod multi_monitor_tests {
    use super::{bounding_box, blit, frac_to_px, Bounds};

    #[test]
    fn hop_bao_khi_man_phu_nam_ben_trai() {
        let rects = [(0, 0, 1920, 1080), (-1920, 0, 1920, 1080)];
        assert_eq!(
            bounding_box(rects.into_iter()),
            Some(Bounds { left: -1920, top: 0, w: 3840, h: 1080 })
        );
    }

    #[test]
    fn hop_bao_khi_hai_man_lech_cao_thap() {
        let rects = [(0, 0, 1920, 1080), (1920, -200, 2560, 1440)];
        assert_eq!(
            bounding_box(rects.into_iter()),
            Some(Bounds { left: 0, top: -200, w: 4480, h: 1440 })
        );
    }

    #[test]
    fn khong_co_man_nao() {
        assert_eq!(bounding_box(std::iter::empty()), None);
    }

    #[test]
    fn dan_anh_dung_vi_tri() {
        let mut dst = vec![0u8; 3 * 2 * 4];
        let src = [9u8; 4];
        blit(&mut dst, 3, 2, &src, 1, 1, 2, 1);
        assert_eq!(&dst[20..24], &src); // hàng 1, cột 2
        assert_eq!(dst.iter().filter(|&&v| v != 0).count(), 4);
    }

    #[test]
    fn anh_chup_to_hon_khung_thi_cat_bot() {
        // Ảnh 2×2 dán ở (2, 1) vào khung 3×2: chỉ còn đúng 1 pixel lọt vào, không panic.
        let mut dst = vec![0u8; 3 * 2 * 4];
        let src: Vec<u8> = (1..=16).collect();
        blit(&mut dst, 3, 2, &src, 2, 2, 2, 1);
        assert_eq!(&dst[20..24], &src[0..4]);
        assert_eq!(dst.iter().filter(|&&v| v != 0).count(), 4);

        // Điểm dán nằm hẳn ngoài khung → bỏ qua.
        let mut dst = vec![0u8; 4];
        blit(&mut dst, 1, 1, &src, 2, 2, 5, 5);
        assert_eq!(dst, vec![0u8; 4]);
    }

    #[test]
    fn vung_vat_qua_hai_man() {
        // Ảnh ghép 3840×1080, vùng từ 1720 tới 2120 (vắt qua mép giữa hai màn).
        let (fw, fh) = (3840.0, 1080.0);
        assert_eq!(
            frac_to_px(1720.0 / fw, 100.0 / fh, 400.0 / fw, 300.0 / fh, 3840, 1080),
            (1720, 100, 400, 300)
        );
    }

    #[test]
    fn vung_tran_khung_bi_chan() {
        assert_eq!(frac_to_px(0.5, 0.5, 0.9, 0.9, 100, 100), (50, 50, 50, 50));
        assert_eq!(frac_to_px(1.0, 1.0, 0.1, 0.1, 100, 100), (100, 100, 0, 0));
    }
}

#[cfg(test)]
mod tier_tests {
    use super::tier_size;

    #[test]
    fn toan_man_1080p_ra_dung_do_phan_giai_dich() {
        assert_eq!(tier_size(1920, 1080, 720, 1080), Some((1280, 720)));
        assert_eq!(tier_size(1920, 1080, 1080, 1080), None); // native: giữ nguyên
        assert_eq!(tier_size(1920, 1080, 1440, 1080), Some((2560, 1440))); // Upscale
        assert_eq!(tier_size(1920, 1080, 2160, 1080), Some((3840, 2160))); // Upscale
    }

    #[test]
    fn man_4k_va_man_2k() {
        assert_eq!(tier_size(3840, 2160, 2160, 2160), None);
        assert_eq!(tier_size(3840, 2160, 1440, 2160), Some((2560, 1440)));
        assert_eq!(tier_size(3840, 2160, 1080, 2160), Some((1920, 1080)));
        assert_eq!(tier_size(2560, 1440, 1440, 1440), None);
        assert_eq!(tier_size(2560, 1440, 2160, 1440), Some((3840, 2160)));
    }

    #[test]
    fn man_chieu_cao_le_16_10() {
        // 1920×1200 không trùng mức nào: Full HD thu nhỏ, 2K/4K upscale
        assert_eq!(tier_size(1920, 1200, 1080, 1200), Some((1728, 1080)));
        assert_eq!(tier_size(1920, 1200, 2160, 1200), Some((3456, 2160)));
    }

    #[test]
    fn vung_chon_theo_ti_le_ca_man_hinh() {
        // Vùng 700×400 trên màn 1080p: 4K → to gấp đôi; mức ≤ màn hình mà vùng đã thấp hơn → giữ
        assert_eq!(tier_size(700, 400, 2160, 1080), Some((1400, 800)));
        assert_eq!(tier_size(700, 400, 720, 1080), None);
        assert_eq!(tier_size(1500, 900, 720, 1080), Some((1200, 720)));
    }
}
