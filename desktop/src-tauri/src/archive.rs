// Lưu nội dung từ cloud về máy trước khi xoá trên R2 ("kho lưu trữ ngoại tuyến"),
// và đọc lại chúng khi khôi phục.
//
// Vì sao tải file ở Rust chứ không ở frontend: bản quay có thể vài trăm MB. Kéo cả file
// qua webview rồi ghi ra đĩa nghĩa là giữ nguyên chừng đó byte trong RAM; ở đây stream
// thẳng từ mạng xuống file nên bộ nhớ chỉ tốn đúng một buffer nhỏ.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

// Ghi ra file tạm rồi mới đổi tên thành file thật. Nếu tải nửa chừng thì đứt mạng/tắt app,
// thứ còn lại là file .part dang dở — KHÔNG phải một file .mp4 hỏng trông như đã lưu xong.
// Việc xoá trên cloud chỉ diễn ra sau khi lệnh này trả về Ok, nên tính chất này giữ cho
// dữ liệu không bao giờ bị xoá khi bản sao dưới máy chưa hoàn chỉnh.
#[tauri::command]
pub async fn archive_save(url: String, dest: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || download_to_file(&url, Path::new(&dest)))
        .await
        .map_err(|e| e.to_string())?
}

fn download_to_file(url: &str, dest: &Path) -> Result<u64, String> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Không tạo được thư mục: {e}"))?;
    }
    let part = part_path(dest);

    let mut resp = reqwest::blocking::get(url).map_err(|e| format!("Tải về lỗi: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Máy chủ trả về HTTP {}", resp.status()));
    }

    let mut file = std::fs::File::create(&part).map_err(|e| format!("Không ghi được file: {e}"))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("Đứt kết nối giữa chừng: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Ghi file lỗi: {e}"))?;
        written += n as u64;
    }
    // flush + sync: chắc chắn byte đã nằm trên đĩa trước khi báo thành công, vì ngay sau đó
    // bản trên cloud sẽ bị xoá.
    file.flush().map_err(|e| format!("Ghi file lỗi: {e}"))?;
    file.sync_all().map_err(|e| format!("Ghi file lỗi: {e}"))?;
    drop(file);

    if written == 0 {
        let _ = std::fs::remove_file(&part);
        return Err("File tải về rỗng".into());
    }
    std::fs::rename(&part, dest).map_err(|e| format!("Không lưu được file: {e}"))?;
    Ok(written)
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

// Ghi file văn bản (dùng cho manifest kho lưu trữ).
#[tauri::command]
pub fn archive_write_text(path: String, text: String) -> Result<(), String> {
    if let Some(dir) = Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Không tạo được thư mục: {e}"))?;
    }
    std::fs::write(&path, text).map_err(|e| format!("Không ghi được manifest: {e}"))
}

#[tauri::command]
pub fn archive_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Không đọc được manifest: {e}"))
}

// Đọc file nhị phân trả thẳng về frontend dưới dạng byte thô (tauri::ipc::Response), KHÔNG
// phải mảng số JSON — một video 100 MB serialize thành JSON sẽ phình lên vài trăm MB.
#[tauri::command]
pub fn archive_read_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Không đọc được file: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// Kiểm tra file có tồn tại và kích thước — để phát hiện manifest trỏ tới file đã bị người
// dùng xoá/di chuyển, trước khi khôi phục.
#[tauri::command]
pub fn archive_file_size(path: String) -> Option<u64> {
    std::fs::metadata(&path).ok().map(|m| m.len())
}
