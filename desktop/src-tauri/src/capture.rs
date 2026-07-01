use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ExtendedColorType, ImageEncoder,
};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use xcap::Monitor;

pub struct RegionState {
    pub raw: Mutex<Option<Vec<u8>>>,
    pub w:   Mutex<u32>,
    pub h:   Mutex<u32>,
}

impl Default for RegionState {
    fn default() -> Self {
        RegionState {
            raw: Mutex::new(None),
            w:   Mutex::new(0),
            h:   Mutex::new(0),
        }
    }
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

// Ẩn main window, chờ 150ms để nó biến khỏi màn hình, chụp full, lưu vào RegionState, mở overlay.
pub fn begin_region_capture(app: AppHandle) {
    std::thread::spawn(move || {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        std::thread::sleep(std::time::Duration::from_millis(150));

        let state = app.state::<RegionState>();
        match capture_primary_raw() {
            Ok((raw, w, h)) => {
                *state.raw.lock().unwrap() = Some(raw);
                *state.w.lock().unwrap() = w;
                *state.h.lock().unwrap() = h;
                if let Some(sel) = app.get_webview_window("region_selector") {
                    let _ = sel.show();
                    let _ = sel.set_focus();
                }
            }
            Err(e) => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                }
                let _ = app.emit("capture-error", e);
            }
        }
    });
}

#[tauri::command]
pub fn start_region_capture(app: AppHandle) {
    begin_region_capture(app);
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
    if let Some(sel) = app.get_webview_window("region_selector") {
        let _ = sel.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }

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
    let data_url = rgba_to_data_url(&cropped, cw, ch)?;
    let _ = app.emit("image-captured", data_url);
    Ok(())
}

#[tauri::command]
pub fn cancel_region_capture(app: AppHandle) {
    if let Some(sel) = app.get_webview_window("region_selector") {
        let _ = sel.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit("region-cancelled", ());
}
