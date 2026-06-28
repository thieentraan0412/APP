// Chụp toàn màn hình chính, trả về data URL PNG (base64) để frontend hiển thị ngay.
use base64::{engine::general_purpose, Engine as _};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use xcap::Monitor;

pub fn capture_primary_png_base64() -> Result<String, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    // Lấy màn hình chính (primary); nếu không xác định được thì lấy cái đầu tiên.
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or("Không tìm thấy màn hình nào")?;

    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    let raw = img.into_raw(); // RGBA8

    // Mã hoá PNG bằng chính crate image của ta (an toàn về phiên bản).
    let mut png: Vec<u8> = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&raw, w, h, ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;

    let b64 = general_purpose::STANDARD.encode(&png);
    Ok(format!("data:image/png;base64,{}", b64))
}

// Lệnh gọi từ frontend (nút "Chụp" trong app, nếu cần).
#[tauri::command]
pub fn capture_screen() -> Result<String, String> {
    capture_primary_png_base64()
}
