mod capture;
mod ffmpeg;
mod record;

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
}

const DEFAULT_CAPTURE: &str = "CommandOrControl+Shift+1";
const DEFAULT_RECORD:  &str = "CommandOrControl+Shift+2";
const DEFAULT_REGION:  &str = "CommandOrControl+Shift+3";
// Tạm dừng / quay tiếp khi đang quay video. Cố định (không sửa trong Cài đặt).
const DEFAULT_PAUSE:   &str = "CommandOrControl+Shift+H";

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

fn trigger_region_capture(app: &AppHandle) {
    capture::begin_region_capture(app.clone());
}

fn apply_shortcuts(app: &AppHandle, capture: &str, record: &str, region: &str, pause: &str) -> Result<(), String> {
    let cap = Shortcut::from_str(capture).map_err(|e| e.to_string())?;
    let rec = Shortcut::from_str(record).map_err(|e| e.to_string())?;
    let reg = Shortcut::from_str(region).map_err(|e| e.to_string())?;
    let pause = Shortcut::from_str(pause).map_err(|e| e.to_string())?;

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(cap.clone()).map_err(|e| e.to_string())?;
    gs.register(rec.clone()).map_err(|e| e.to_string())?;
    gs.register(reg.clone()).map_err(|e| e.to_string())?;
    // Không để phím tạm dừng làm hỏng cả cấu hình nếu lỡ trùng phím khác.
    let _ = gs.register(pause.clone());

    let st = app.state::<ShortcutCfg>();
    *st.capture.lock().unwrap() = Some(cap);
    *st.record.lock().unwrap()  = Some(rec);
    *st.region.lock().unwrap()  = Some(reg);
    *st.pause.lock().unwrap()   = Some(pause);
    Ok(())
}

#[tauri::command]
fn set_shortcuts(app: AppHandle, capture: String, record: String, region: String, pause: String) -> Result<(), String> {
    apply_shortcuts(&app, &capture, &record, &region, &pause)
}

#[tauri::command]
fn remove_temp(path: String) {
    let _ = std::fs::remove_file(path);
}

#[tauri::command]
fn save_video_to_path(src: String, dst: String) -> Result<(), String> {
    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(record::RecState::default())
        .manage(ShortcutCfg::default())
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
                    if is_cap {
                        trigger_capture(app);
                    } else if is_rec {
                        record::toggle_recording(app);
                    } else if is_reg {
                        trigger_region_capture(app);
                    } else if is_pause {
                        record::toggle_pause(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let _ = apply_shortcuts(app.handle(), DEFAULT_CAPTURE, DEFAULT_RECORD, DEFAULT_REGION, DEFAULT_PAUSE);

            let capture_i = MenuItem::with_id(app, "capture", "Chụp màn hình", true, None::<&str>)?;
            let region_i  = MenuItem::with_id(app, "region",  "Chụp vùng",     true, None::<&str>)?;
            let record_i  = MenuItem::with_id(app, "record",  "Quay / Dừng video", true, None::<&str>)?;
            let pause_i   = MenuItem::with_id(app, "pause",   "Tạm dừng / Quay tiếp", true, None::<&str>)?;
            let show_i    = MenuItem::with_id(app, "show",    "Mở cửa sổ",     true, None::<&str>)?;
            let quit_i    = MenuItem::with_id(app, "quit",    "Thoát",          true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture_i, &region_i, &record_i, &pause_i, &show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Chụp & chia sẻ")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => trigger_capture(app),
                    "region"  => trigger_region_capture(app),
                    "record"  => record::toggle_recording(app),
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
            capture::confirm_region_capture,
            capture::cancel_region_capture,
            set_shortcuts,
            remove_temp,
            save_video_to_path,
            trim_video,
            toggle_recording_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
