mod capture;
mod record;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::ShortcutState;

// Chụp màn hình rồi gửi ảnh (data URL) sang giao diện + hiện cửa sổ editor.
fn trigger_capture(app: &tauri::AppHandle) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(record::RecState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // Chỉ xử lý khi nhấn xuống (tránh fire 2 lần khi nhả phím).
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let mods = tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::SHIFT;
                    if shortcut.matches(mods, tauri_plugin_global_shortcut::Code::Digit1) {
                        trigger_capture(app);
                    } else if shortcut.matches(mods, tauri_plugin_global_shortcut::Code::Digit2) {
                        record::toggle_recording(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Phím tắt toàn cục: Ctrl+Shift+1 → chụp ảnh; Ctrl+Shift+2 → quay/dừng video.
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            app.global_shortcut().register("CommandOrControl+Shift+1")?;
            app.global_shortcut().register("CommandOrControl+Shift+2")?;

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
        .invoke_handler(tauri::generate_handler![capture::capture_screen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
