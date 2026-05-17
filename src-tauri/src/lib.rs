use tauri::{AppHandle, Emitter, Manager};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

// ==================== 后端进程管理 ====================

/// 后端服务进程（全局单例）
pub struct BackendProcess {
    child: Mutex<Option<Child>>,
}

/// 启动后端 Node 服务
///
/// 在 ripple-agent 根目录执行 `node packages/server/dist/index.js`
/// 后端日志通过 stdout/stderr 捕获并转发给前端
#[tauri::command]
fn start_backend(app: AppHandle, state: tauri::State<BackendProcess>) -> Result<bool, String> {
    let mut child_guard = state.child.lock().map_err(|e| format!("锁错误: {e}"))?;

    // 如果已经在运行，先检查进程是否还活着
    if let Some(ref mut child) = *child_guard {
        match child.try_wait() {
            Ok(Some(_)) => { /* 已退出 */ }
            Ok(None) => {
                // 还在运行
                let _ = app.emit("backend-log", serde_json::json!({
                    "level": "info",
                    "message": "后端服务已在运行中"
                }));
                return Ok(true);
            }
            Err(_) => { /* 出错，重新启动 */ }
        }
    }

    // 查找后端路径：优先使用配置，否则使用默认路径
    let backend_dir = find_backend_dir(&app)?;
    let server_entry = backend_dir.join("packages").join("server").join("dist").join("index.js");

    if !server_entry.exists() {
        let _ = app.emit("backend-log", serde_json::json!({
            "level": "error",
            "message": format!("后端入口文件不存在: {}", server_entry.display())
        }));
        return Err(format!("后端入口文件不存在: {}", server_entry.display()));
    }

    let _ = app.emit("backend-log", serde_json::json!({
        "level": "info",
        "message": format!("正在启动后端服务: {}", server_entry.display())
    }));

    // 启动 Node 子进程
    let mut cmd = Command::new("node");
    cmd.arg(&server_entry)
        .current_dir(&backend_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn()
        .map_err(|e| {
            let _ = app.emit("backend-log", serde_json::json!({
                "level": "error",
                "message": format!("启动后端失败: {}", e)
            }));
            format!("启动后端失败: {e}")
        })?;

    // 捕获 stdout
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_clone.emit("backend-log", serde_json::json!({
                        "level": "info",
                        "message": line
                    }));
                }
            }
        });
    }

    // 捕获 stderr
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let level = if line.contains("ERROR") || line.contains("error") { "error" } else { "warn" };
                    let _ = app_clone.emit("backend-log", serde_json::json!({
                        "level": level,
                        "message": line
                    }));
                }
            }
        });
    }

    *child_guard = Some(child);

    let _ = app.emit("backend-log", serde_json::json!({
        "level": "success",
        "message": "后端服务已启动"
    }));

    Ok(true)
}

/// 停止后端服务
#[tauri::command]
fn stop_backend(app: AppHandle, state: tauri::State<BackendProcess>) -> Result<bool, String> {
    let mut child_guard = state.child.lock().map_err(|e| format!("锁错误: {e}"))?;

    if let Some(ref mut child) = *child_guard {
        match child.kill() {
            Ok(_) => {
                let _ = app.emit("backend-log", serde_json::json!({
                    "level": "info",
                    "message": "后端服务已停止"
                }));
                *child_guard = None;
                Ok(true)
            }
            Err(e) => Err(format!("停止后端失败: {e}")),
        }
    } else {
        Ok(false)
    }
}

/// 查找后端项目目录
fn find_backend_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // 1. 尝试从配置中读取
    if let Ok(config_path) = get_config_path(app) {
        if config_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(dir) = config.get("backend_dir").and_then(|v| v.as_str()) {
                        let path = std::path::PathBuf::from(dir);
                        if path.exists() {
                            return Ok(path);
                        }
                    }
                }
            }
        }
    }

    // 2. 默认路径（相对于前端项目的同级目录）
    let default_paths = [
        // 开发环境：ripple-agent 在同级目录
        std::path::PathBuf::from("../pi-mono/ripple-agent"),
        std::path::PathBuf::from("../../pi-mono/ripple-agent"),
        // 可能的其他位置
        std::path::PathBuf::from("../ripple-agent"),
    ];

    for path in &default_paths {
        if path.join("packages").join("server").exists() {
            return Ok(path.clone());
        }
    }

    Err("未找到后端项目目录，请在设置中配置 backend_dir".to_string())
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendProcess {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            save_config, load_config,
            start_backend, stop_backend,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
