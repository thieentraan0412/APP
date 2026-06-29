mod capture;
mod record;

use std::str::FromStr;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// Lưu phím tắt hiện tại để handler so khớp (cho phép đổi trong Cài đặt).
#[derive(Default)]
struct ShortcutCfg {
    capture: Mutex<Option<Shortcut>>,
    record: Mutex<Option<Shortcut>>,
}

const DEFAULT_CAPTURE: &str = "CommandOrControl+Shift+1";
const DEFAULT_RECORD: &str = "CommandOrControl+Shift+2";

// Chụp màn hình rồi gửi ảnh (data URL) sang giao diện + hiện cửa sổ editor.
fn trigger_capture(app: &AppHandle) {
    match capture::capture_primary_png_base64() {
        Ok(data_url) => {
            let _ = app.emit("image-captured", data_url);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }
        Err(e) => {
            let _ = app.emit("capture-error", e);
        }
    }
}

// Đăng ký lại 2 phím tắt (dùng cho khởi động và khi đổi trong Cài đặt).
fn apply_shortcuts(app: &AppHandle, capture: &str, record: &str) -> Result<(), String> {
    let cap = Shortcut::from_str(capture).map_err(|e| e.to_string())?;
    let rec = Shortcut::from_str(record).map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(cap.clone()).map_err(|e| e.to_string())?;
    gs.register(rec.clone()).map_err(|e| e.to_string())?;
    let st = app.state::<ShortcutCfg>();
    *st.capture.lock().unwrap() = Some(cap);
    *st.record.lock().unwrap() = Some(rec);
    Ok(())
}

#[tauri::command]
fn set_shortcuts(app: AppHandle, capture: String, record: String) -> Result<(), String> {
    apply_shortcuts(&app, &capture, &record)
}

// Xoá file tạm (vd video sau khi upload xong).
#[tauri::command]
fn remove_temp(path: String) {
    let _ = std::fs::remove_file(path);
}

#[tauri::command]
fn toggle_recording_cmd(app: AppHandle) {
    record::toggle_recording(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(record::RecState::default())
        .manage(ShortcutCfg::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let st = app.state::<ShortcutCfg>();
                    let is_cap = st
                        .capture
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map_or(false, |s| s == shortcut);
                    let is_rec = st
                        .record
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map_or(false, |s| s == shortcut);
                    if is_cap {
                        trigger_capture(app);
                    } else if is_rec {
                        record::toggle_recording(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Đăng ký phím tắt mặc định khi khởi động.
            let _ = apply_shortcuts(app.handle(), DEFAULT_CAPTURE, DEFAULT_RECORD);

            // System tray: menu Chụp / Quay / Mở / Thoát.
            let capture_i = MenuItem::with_id(app, "capture", "Chụp màn hình", true, None::<&str>)?;
            let record_i = MenuItem::with_id(app, "record", "Quay / Dừng video", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Mở cửa sổ", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture_i, &record_i, &show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Chụp & chia sẻ")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => trigger_capture(app),
                    "record" => record::toggle_recording(app),
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
        // Đóng cửa sổ → ẩn xuống tray thay vì thoát app (để phím tắt vẫn chạy nền).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            capture::capture_screen,
            set_shortcuts,
            remove_temp,
            toggle_recording_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
