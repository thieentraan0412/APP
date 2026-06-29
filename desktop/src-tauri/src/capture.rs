use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ExtendedColorType, ImageEncoder,
};
use xcap::Monitor;

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
    // CompressionType::Fast (level 1) thay vì default (level 6) → 4–5x nhanh hơn.
    // FilterType::NoFilter bỏ qua bước lọc không cần thiết khi không nén sâu.
    let capacity = (w * h * 4) as usize + 1024;
    let mut png: Vec<u8> = Vec::with_capacity(capacity);
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
        .write_image(raw, w, h, ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    let b64 = general_purpose::STANDARD.encode(&png);
    Ok(format!("data:image/png;base64,{}", b64))
}

fn copy_rgba_to_clipboard(raw: Vec<u8>, w: u32, h: u32) {
    // Chạy trong thread riêng để không block luồng PNG encode.
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

// Chụp màn hình: clipboard + data URL chạy song song → tổng thời gian = max(hai bước), không phải tổng cộng.
pub fn capture_primary_png_base64() -> Result<String, String> {
    let (raw, w, h) = capture_primary_raw()?;
    copy_rgba_to_clipboard(raw.clone(), w, h); // spawn thread, không chờ
    rgba_to_data_url(&raw, w, h)               // encode ngay trên thread hiện tại
}

#[tauri::command]
pub fn capture_screen() -> Result<String, String> {
    capture_primary_png_base64()
}
