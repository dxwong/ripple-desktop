use tauri::{AppHandle, Emitter, Manager, State};

// ==================== 配置持久化 ====================

fn get_config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| format!("{e}"))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("{e}"))?;
    Ok(app_dir.join("config.json"))
}

#[tauri::command]
fn save_config(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    let config_path = get_config_path(&app)?;
    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| format!("{e}"))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if let serde_json::Value::Object(ref mut map) = config { map.insert(key, value); }
    std::fs::write(&config_path, serde_json::to_string_pretty(&config).map_err(|e| format!("{e}"))?)
        .map_err(|e| format!("{e}"))?;
    Ok(())
}

#[tauri::command]
fn load_config(app: AppHandle, key: String) -> Result<serde_json::Value, String> {
    let config_path = get_config_path(&app)?;
    if !config_path.exists() { return Ok(serde_json::Value::Null); }
    let content = std::fs::read_to_string(&config_path).map_err(|e| format!("{e}"))?;
    let config: serde_json::Value = serde_json::from_str(&content).map_err(|e| format!("{e}"))?;
    Ok(config.get(&key).cloned().unwrap_or(serde_json::Value::Null))
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_config, load_config,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
