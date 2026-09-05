mod archive;
mod capture;
mod ffmpeg;
mod record;

use base64::{engine::general_purpose, Engine as _};
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
struct ShortcutCfg {
    capture: Mutex<Option<Shortcut>>,
    record:  Mutex<Option<Shortcut>>,
    region:  Mutex<Option<Shortcut>>,
    pause:   Mutex<Option<Shortcut>>,
    recreg:  Mutex<Option<Shortcut>>,
}

// Chất lượng (chiều CAO tối đa, px) của ảnh chụp và video quay. Chỉ THU NHỎ khi ảnh/màn
// hình lớn hơn mức chọn — không bao giờ phóng to, vì phóng to chỉ làm file nặng thêm chứ
// không thêm chi tiết. Hai giá trị tách riêng: ảnh thường cần nét hơn video.
#[derive(Default)]
struct QualityCfg {
    image: Mutex<u32>,
    video: Mutex<u32>,
}

// ẢNH mặc định 4K: vì không bao giờ phóng to, mức này có nghĩa là "không thu nhỏ gì cả" —
// ảnh chụp giữ đúng từng pixel của màn hình dù màn to tới đâu. Máy 1080p/1440p không đổi gì
// so với mức 2K cũ (đằng nào cũng chẳng có gì để thu), chỉ màn 4K là hết bị cắt mất chi tiết.
pub const DEFAULT_IMAGE_QUALITY: u32 = 2160;
// VIDEO vẫn mặc định 2K: quay 4K nặng gấp bội cả lúc mã hoá lẫn lúc gửi đi, nên để người
// dùng tự chọn chứ không bật sẵn.
pub const DEFAULT_VIDEO_QUALITY: u32 = 1440;
const QUALITY_CHOICES: [u32; 4] = [720, 1080, 1440, 2160];

fn quality_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("quality.cfg"))
}

// Chỉ nhận đúng các mức có trong Cài đặt; số lạ (file hỏng, bản cũ) → mặc định, tránh để
// lọt số 0 xuống ffmpeg làm chết cả phiên quay. Ảnh và video có mặc định khác nhau nên
// phải truyền vào — dùng chung một hằng thì bản cũ hỏng file sẽ kéo video lên 4K.
fn parse_quality(s: Option<&str>, default: u32) -> u32 {
    s.and_then(|l| l.trim().parse::<u32>().ok())
        .filter(|v| QUALITY_CHOICES.contains(v))
        .unwrap_or(default)
}

fn load_saved_quality(app: &AppHandle) -> (u32, u32) {
    let content = match quality_file(app) {
        Some(p) => std::fs::read_to_string(p).unwrap_or_default(),
        None => String::new(),
    };
    let lines: Vec<&str> = content.lines().collect();
    (
        parse_quality(lines.first().copied(), DEFAULT_IMAGE_QUALITY),
        parse_quality(lines.get(1).copied(), DEFAULT_VIDEO_QUALITY),
    )
}

fn save_quality_file(app: &AppHandle, image: u32, video: u32) {
    if let Some(p) = quality_file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, format!("{image}\n{video}\n"));
    }
}

// Chiều cao tối đa cho ảnh chụp / video. Đọc từ state (đã nạp lúc khởi động) nên phím tắt
// dùng được ngay cả khi frontend chưa kịp chạy.
pub fn image_quality(app: &AppHandle) -> u32 {
    *app.state::<QualityCfg>().image.lock().unwrap()
}

pub fn video_quality(app: &AppHandle) -> u32 {
    *app.state::<QualityCfg>().video.lock().unwrap()
}

const DEFAULT_CAPTURE: &str = "CommandOrControl+Shift+1";
const DEFAULT_RECORD:  &str = "CommandOrControl+Shift+2";
const DEFAULT_REGION:  &str = "CommandOrControl+Shift+3";
// Tạm dừng / quay tiếp khi đang quay video. Cố định (không sửa trong Cài đặt).
const DEFAULT_PAUSE:   &str = "CommandOrControl+Shift+H";
// Quay video theo vùng chọn.
const DEFAULT_RECREG:  &str = "CommandOrControl+Shift+4";

// Lưu phím tắt phía Rust (file config) để đăng ký NGAY lúc khởi động, không phụ thuộc
// vào IPC từ frontend (lời gọi đầu tiên của WebView2 hay treo/rớt → phím tùy chỉnh
// không được đăng ký cho tới khi người dùng vào Cài đặt bấm "Lưu"). 4 dòng: cap/rec/reg/pause.
fn shortcuts_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("shortcuts.cfg"))
}

fn load_saved_shortcuts(app: &AppHandle) -> Option<(String, String, String, String, String)> {
    let content = std::fs::read_to_string(shortcuts_file(app)?).ok()?;
    let lines: Vec<&str> = content.lines().map(|l| l.trim()).collect();
    if lines.len() >= 4 && lines.iter().take(4).all(|l| !l.is_empty()) {
        // Dòng 5 (quay vùng) mới có từ bản này — người dùng cũ có file 4 dòng, thiếu thì
        // lấy mặc định chứ KHÔNG coi cả file là hỏng (làm vậy sẽ reset hết phím họ đã đặt).
        let recreg = lines
            .get(4)
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .unwrap_or_else(|| DEFAULT_RECREG.to_string());
        Some((
            lines[0].to_string(),
            lines[1].to_string(),
            lines[2].to_string(),
            lines[3].to_string(),
            recreg,
        ))
    } else {
        None
    }
}

fn save_shortcuts_file(app: &AppHandle, capture: &str, record: &str, region: &str, pause: &str, recreg: &str) {
    if let Some(p) = shortcuts_file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(
            p,
            format!("{}\n{}\n{}\n{}\n{}\n", capture, record, region, pause, recreg),
        );
    }
}

// Đưa cửa sổ chính ra trước mặt người dùng (chụp xong / quay xong / huỷ chọn vùng).
// Windows không cho tiến trình đang ở nền tự chiếm foreground: chỉ show() + set_focus()
// thì cửa sổ có hiện nhưng nằm SAU ứng dụng người dùng đang dùng, nên nhìn như app không
// bật lên. Nhấc tạm always-on-top rồi hạ xuống ngay buộc nó nổi lên trên cùng mà không
// bị dính "luôn trên cùng" vĩnh viễn. unminimize() để khôi phục cả khi đang thu nhỏ.
pub fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
        let _ = win.set_always_on_top(false);
    }
}

fn trigger_capture(app: &AppHandle) {
    // H2: đang chụp vùng (overlay mở) → bỏ qua chụp full để không tráo kết quả
    // giữa ảnh full và ảnh vùng / dò QR.
    if capture::region_active(app) {
        return;
    }
    match capture::capture_primary_png_base64(image_quality(app)) {
        Ok(data_url) => {
            let _ = app.emit("image-captured", capture::CapturedImage { data_url, region: false });
            focus_main(app);
        }
        Err(e) => {
            let _ = app.emit("capture-error", e);
        }
    }
}

fn trigger_region_capture(app: &AppHandle) {
    capture::begin_region_capture(app.clone());
}

fn trigger_region_record(app: &AppHandle) {
    // Đang quay → chính phím này DỪNG luôn, không bắt người dùng nhớ sang phím "Quay
    // toàn màn hình" mới tắt được phiên quay vùng mà nó vừa bật.
    if record::is_recording(app) {
        record::toggle_recording(app);
        return;
    }
    capture::begin_region_selection(app.clone(), true);
}

fn apply_shortcuts(app: &AppHandle, capture: &str, record: &str, region: &str, pause: &str, recreg: &str) -> Result<(), String> {
    let cap = Shortcut::from_str(capture).map_err(|e| e.to_string())?;
    let rec = Shortcut::from_str(record).map_err(|e| e.to_string())?;
    let reg = Shortcut::from_str(region).map_err(|e| e.to_string())?;
    let pause = Shortcut::from_str(pause).map_err(|e| e.to_string())?;
    let recreg = Shortcut::from_str(recreg).map_err(|e| e.to_string())?;

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    // Đăng ký từng phím ĐỘC LẬP: một phím lỗi (vd trùng hotkey của Windows) KHÔNG được
    // làm hỏng các phím còn lại (H8). Luôn cập nhật state khớp với phím đã đăng ký.
    let _ = gs.register(cap.clone());
    let _ = gs.register(rec.clone());
    let _ = gs.register(reg.clone());
    let _ = gs.register(pause.clone());
    let _ = gs.register(recreg.clone());

    let st = app.state::<ShortcutCfg>();
    *st.capture.lock().unwrap() = Some(cap);
    *st.record.lock().unwrap()  = Some(rec);
    *st.region.lock().unwrap()  = Some(reg);
    *st.pause.lock().unwrap()   = Some(pause);
    *st.recreg.lock().unwrap()  = Some(recreg);
    Ok(())
}

#[tauri::command]
fn set_shortcuts(app: AppHandle, capture: String, record: String, region: String, pause: String, region_record: String) -> Result<(), String> {
    apply_shortcuts(&app, &capture, &record, &region, &pause, &region_record)?;
    // Ghi lại để lần khởi động sau đăng ký đúng phím tùy chỉnh ngay từ đầu.
    save_shortcuts_file(&app, &capture, &record, &region, &pause, &region_record);
    Ok(())
}

// Đọc mức đang áp dụng. Frontend hỏi Rust chứ KHÔNG tự đẩy giá trị của mình lên lúc khởi
// động: file cấu hình bên Rust mới là bản chính (phím tắt toàn cục chụp/quay đọc thẳng từ
// đó), nên nếu localStorage của webview trống hay lệch thì nó sẽ âm thầm đạp mức người
// dùng đã chọn về mặc định.
#[tauri::command]
fn get_quality(app: AppHandle) -> (u32, u32) {
    (image_quality(&app), video_quality(&app))
}

#[tauri::command]
fn set_quality(app: AppHandle, image: u32, video: u32) {
    let image = parse_quality(Some(&image.to_string()), DEFAULT_IMAGE_QUALITY);
    let video = parse_quality(Some(&video.to_string()), DEFAULT_VIDEO_QUALITY);
    let st = app.state::<QualityCfg>();
    *st.image.lock().unwrap() = image;
    *st.video.lock().unwrap() = video;
    save_quality_file(&app, image, video);
}

#[tauri::command]
fn remove_temp(path: String) {
    let _ = std::fs::remove_file(path);
}

#[tauri::command]
fn save_video_to_path(src: String, dst: String) -> Result<(), String> {
    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
}

// Lưu ảnh đang chú thích ra file người dùng tự chọn. Ảnh đi từ webview sang dưới dạng
// data URL vì plugin fs chỉ được cấp quyền ĐỌC trong $TEMP — ghi ra chỗ khác phải qua đây.
#[tauri::command]
fn save_image_to_path(data_url: String, dst: String) -> Result<(), String> {
    let b64 = data_url
        .split_once("base64,")
        .map(|(_, rest)| rest)
        .unwrap_or(&data_url);
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Ảnh hỏng: {e}"))?;
    // Ghi ra .part rồi đổi tên: hết đĩa hay mất điện giữa chừng thì không để lại một file
    // .png dở dang trông y như đã lưu xong.
    let part = format!("{dst}.part");
    std::fs::write(&part, bytes).map_err(|e| format!("Không lưu được file: {e}"))?;
    std::fs::rename(&part, &dst).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("Không lưu được file: {e}")
    })
}

// Cắt video (async + spawn_blocking để không treo UI khi ffmpeg chạy).
#[tauri::command]
async fn trim_video(app: AppHandle, src: String, start: f64, end: f64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ffmpeg::trim(&app, &src, start, end))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn toggle_recording_cmd(app: AppHandle) {
    record::toggle_recording(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tắt QUIC/HTTP3 cho webview được đặt qua `additionalBrowserArgs` của cửa sổ main trong
    // tauri.conf.json (env var WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS bị wry đè nên vô tác dụng).
    tauri::Builder::default()
        // PHẢI là plugin đầu tiên. Chặn mở app 2 lần: instance thứ 2 sẽ đưa cửa sổ chính
        // của instance đang chạy lên rồi tự thoát — tránh 2 instance tranh nhau global hotkey
        // (khiến phím tắt Alt+* đăng ký thất bại → chụp vùng/quay/chụp đều chết).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Tự khởi động cùng Windows. Khi được máy chạy lúc boot sẽ kèm cờ "--minimized"
        // để app ẩn xuống khay hệ thống thay vì bật cửa sổ (xem xử lý trong .setup).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(record::RecState::default())
        .manage(ShortcutCfg::default())
        .manage(QualityCfg::default())
        .manage(capture::RegionState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let st = app.state::<ShortcutCfg>();
                    let is_cap = st.capture.lock().unwrap().as_ref().map_or(false, |s| s == shortcut);
                    let is_rec = st.record.lock().unwrap().as_ref().map_or(false, |s| s == shortcut);
                    let is_reg = st.region.lock().unwrap().as_ref().map_or(false, |s| s == shortcut);
                    let is_pause = st.pause.lock().unwrap().as_ref().map_or(false, |s| s == shortcut);
                    let is_recreg = st.recreg.lock().unwrap().as_ref().map_or(false, |s| s == shortcut);
                    if is_cap {
                        trigger_capture(app);
                    } else if is_rec {
                        record::toggle_recording(app);
                    } else if is_reg {
                        trigger_region_capture(app);
                    } else if is_pause {
                        record::toggle_pause(app);
                    } else if is_recreg {
                        trigger_region_record(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Khởi động cùng máy (cờ "--minimized"): ẩn cửa sổ chính xuống tray, không bật lên.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            // Chất lượng đã lưu — nạp TRƯỚC khi đăng ký phím tắt, vì phím tắt có thể được
            // bấm ngay giây đầu tiên và lúc đó chụp/quay phải dùng đúng mức người dùng chọn.
            {
                let (image, video) = load_saved_quality(app.handle());
                let st = app.state::<QualityCfg>();
                *st.image.lock().unwrap() = image;
                *st.video.lock().unwrap() = video;
            }

            // Đăng ký NGAY phím tắt đã lưu (nếu có) — dùng được liền khi mở app, không cần
            // vào Cài đặt bấm "Lưu". Chưa lưu bao giờ → dùng mặc định.
            match load_saved_shortcuts(app.handle()) {
                Some((c, r, g, p, rg)) => { let _ = apply_shortcuts(app.handle(), &c, &r, &g, &p, &rg); }
                None => { let _ = apply_shortcuts(app.handle(), DEFAULT_CAPTURE, DEFAULT_RECORD, DEFAULT_REGION, DEFAULT_PAUSE, DEFAULT_RECREG); }
            }

            let capture_i = MenuItem::with_id(app, "capture", "Chụp màn hình", true, None::<&str>)?;
            let region_i  = MenuItem::with_id(app, "region",  "Chụp vùng",     true, None::<&str>)?;
            let record_i  = MenuItem::with_id(app, "record",  "Quay / Dừng video", true, None::<&str>)?;
            let recreg_i  = MenuItem::with_id(app, "recregion", "Quay vùng",    true, None::<&str>)?;
            let pause_i   = MenuItem::with_id(app, "pause",   "Tạm dừng / Quay tiếp", true, None::<&str>)?;
            let show_i    = MenuItem::with_id(app, "show",    "Mở cửa sổ",     true, None::<&str>)?;
            let quit_i    = MenuItem::with_id(app, "quit",    "Thoát",          true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture_i, &region_i, &record_i, &recreg_i, &pause_i, &show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Chụp & chia sẻ")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => trigger_capture(app),
                    "region"  => trigger_region_capture(app),
                    "record"  => record::toggle_recording(app),
                    "recregion" => trigger_region_record(app),
                    "pause"   => record::toggle_pause(app),
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            capture::capture_screen,
            capture::start_region_capture,
            capture::start_region_record,
            capture::region_mode,
            capture::confirm_region_capture,
            capture::confirm_region_record,
            capture::cancel_region_capture,
            set_shortcuts,
            set_quality,
            get_quality,
            capture::capture_sizes,
            remove_temp,
            save_video_to_path,
            save_image_to_path,
            trim_video,
            toggle_recording_cmd,
            archive::archive_save,
            archive::archive_write_text,
            archive::archive_read_text,
            archive::archive_read_file,
            archive::archive_file_size,
            archive::archive_dir_state,
            archive::archive_open_dir,
            archive::device_name
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
