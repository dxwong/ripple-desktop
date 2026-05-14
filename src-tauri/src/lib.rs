mod ws_client;

use tauri::{AppHandle, Emitter, Manager, State};
use ws_client::{BridgeRequest, SharedWsClient, WsConnectionState};

/// 桥接服务默认地址
const DEFAULT_BRIDGE_URL: &str = "ws://127.0.0.1:9876";

// ==================== Tauri 命令 ====================

/// 连接到 Python 桥接服务
#[tauri::command]
async fn connect_bridge(
    state: State<'_, SharedWsClient>,
    app: AppHandle,
) -> Result<String, String> {
    // 检查是否已连接
    {
        let client = state.client.lock().await;
        if client.state == WsConnectionState::Connected {
            return Ok("already_connected".to_string());
        }
    }

    match state.connect().await {
        Ok(()) => {
            // 启动后台事件循环，接收来自桥接服务的消息
            let client_clone = state.inner().clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                ws_event_loop(client_clone, app_clone).await;
            });

            let _ = app.emit("bridge-status", serde_json::json!({
                "status": "connected",
                "url": DEFAULT_BRIDGE_URL,
            }));

            Ok("connected".to_string())
        }
        Err(e) => {
            let _ = app.emit("bridge-status", serde_json::json!({
                "status": "error",
                "error": e,
            }));
            Err(e)
        }
    }
}

/// 断开与桥接服务的连接
#[tauri::command]
async fn disconnect_bridge(
    state: State<'_, SharedWsClient>,
    app: AppHandle,
) -> Result<String, String> {
    state.disconnect().await;
    let _ = app.emit("bridge-status", serde_json::json!({
        "status": "disconnected",
    }));
    Ok("disconnected".to_string())
}

// ==================== JSON 配置持久化 ====================

/// 配置文件路径（应用数据目录下的 config.json）
fn get_config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_dir = app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("无法创建数据目录: {}", e))?;
    Ok(app_dir.join("config.json"))
}

/// 保存配置项到本地 JSON 文件
#[tauri::command]
fn save_config(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    let config_path = get_config_path(&app)?;

    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if let serde_json::Value::Object(ref mut map) = config {
        map.insert(key, value);
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("写入配置文件失败: {}", e))?;

    Ok(())
}

/// 从本地 JSON 文件加载配置项
#[tauri::command]
fn load_config(app: AppHandle, key: String) -> Result<serde_json::Value, String> {
    let config_path = get_config_path(&app)?;

    if !config_path.exists() {
        return Ok(serde_json::Value::Null);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取配置文件失败: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析配置失败: {}", e))?;

    Ok(config.get(&key).cloned().unwrap_or(serde_json::Value::Null))
}

// ==================== OpenCode 配置读取 ====================

/// 读取 OpenCode CLI 的配置文件，返回可用模型列表
#[tauri::command]
fn read_opencode_config() -> Result<serde_json::Value, String> {
    let search_paths = [
        std::env::var("APPDATA").ok()
            .map(|p| std::path::PathBuf::from(p).join("opencode").join("config.json")),
        std::env::var("APPDATA").ok()
            .map(|p| std::path::PathBuf::from(p).join("opencode").join("settings.json")),
        std::env::var("USERPROFILE").ok()
            .map(|p| std::path::PathBuf::from(p).join(".config").join("opencode").join("config.json")),
        std::env::var("USERPROFILE").ok()
            .map(|p| std::path::PathBuf::from(p).join(".opencode").join("config.json")),
        std::env::var("HOME").ok()
            .map(|p| std::path::PathBuf::from(p).join(".config").join("opencode").join("config.json")),
        std::env::var("HOME").ok()
            .map(|p| std::path::PathBuf::from(p).join(".opencode").join("config.json")),
    ];

    let mut tried_paths: Vec<String> = Vec::new();

    for path_opt in &search_paths {
        if let Some(ref path) = path_opt {
            tried_paths.push(path.to_string_lossy().to_string());
            if path.exists() {
                match std::fs::read_to_string(path) {
                    Ok(content) => {
                        match serde_json::from_str::<serde_json::Value>(&content) {
                            Ok(config) => {
                                let mut models = Vec::new();

                                if let Some(providers) = config.get("providers").and_then(|p| p.as_object()) {
                                    for (provider_name, provider_cfg) in providers {
                                        if let Some(provider_models) = provider_cfg.get("models") {
                                            if let Some(models_obj) = provider_models.as_object() {
                                                for (model_name, _model_cfg) in models_obj {
                                                    models.push(serde_json::json!({
                                                        "name": model_name,
                                                        "provider": provider_name,
                                                    }));
                                                }
                                            }
                                            if let Some(models_arr) = provider_models.as_array() {
                                                for m in models_arr {
                                                    if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                                                        let mut entry = serde_json::json!({
                                                            "name": name, "provider": provider_name,
                                                        });
                                                        if let Some(obj) = entry.as_object_mut() {
                                                            if let Some(m_obj) = m.as_object() {
                                                                for (k, v) in m_obj {
                                                                    if k != "name" && (v.is_string() || v.is_number() || v.is_boolean()) {
                                                                        obj.insert(k.clone(), v.clone());
                                                                    }
                                                                }
                                                            }
                                                        }
                                                        models.push(entry);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                if let Some(top_models) = config.get("models").and_then(|m| m.as_array()) {
                                    for m in top_models {
                                        if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                                            if !models.iter().any(|existing| existing.get("name").and_then(|n| n.as_str()) == Some(name)) {
                                                models.push(m.clone());
                                            }
                                        }
                                    }
                                }

                                if let Some(selected) = config.get("selectedModel").and_then(|s| s.as_str()) {
                                    if !models.iter().any(|m| m.get("name").and_then(|n| n.as_str()) == Some(selected)) {
                                        models.push(serde_json::json!({ "name": selected }));
                                    }
                                }

                                if models.is_empty() {
                                    log::warn!("OpenCode 配置存在但未解析出模型: {}", path.display());
                                }

                                return Ok(serde_json::json!({
                                    "models": models,
                                    "config_path": path.to_string_lossy().to_string(),
                                }));
                            }
                            Err(e) => {
                                log::warn!("解析 OpenCode 配置文件失败 ({}): {}", path.display(), e);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("读取 OpenCode 配置文件失败 ({}): {}", path.display(), e);
                    }
                }
            }
        }
    }

    log::info!("未找到 OpenCode 配置文件，已扫描路径: {:?}", tried_paths);
    Ok(serde_json::json!({
        "models": [],
        "note": "未找到配置文件，可在下拉菜单中手动输入模型名",
        "scanned_paths": tried_paths,
    }))
}

/// 获取桥接服务连接状态
#[tauri::command]
async fn get_bridge_status(
    state: State<'_, SharedWsClient>,
) -> Result<WsConnectionState, String> {
    let client = state.client.lock().await;
    Ok(client.state.clone())
}

/// 发送消息到桥接服务并等待响应
///
/// SharedWsClient::send_request 内部已处理两阶段锁：
/// 锁 client 设 pending → 锁 ws_stream 发消息 → 释放两锁 → 无锁等 oneshot
#[tauri::command]
async fn send_to_bridge(
    state: State<'_, SharedWsClient>,
    msg_type: String,
    data: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = BridgeRequest {
        id: uuid::Uuid::new_v4().to_string(),
        msg_type,
        data,
    };

    let response = state.send_request(request).await?;

    Ok(serde_json::json!({
        "status": response.status,
        "data": response.data,
    }))
}

/// 发送消息到桥接服务（不等待响应，用于流式输出）
#[tauri::command]
async fn send_to_bridge_no_wait(
    state: State<'_, SharedWsClient>,
    msg_type: String,
    data: serde_json::Value,
) -> Result<String, String> {
    let request = BridgeRequest {
        id: uuid::Uuid::new_v4().to_string(),
        msg_type,
        data,
    };

    state.send_no_wait(request).await?;
    Ok("消息已发送".to_string())
}

/// 后台事件循环：持续读取 WebSocket 消息并转发到前端
///
/// 只锁 ws_stream 读消息 → 短暂锁 client 路由/转发 → 释放 → 继续读
/// 不阻塞 send_to_bridge / send_to_bridge_no_wait
async fn ws_event_loop(shared: SharedWsClient, app: AppHandle) {
    loop {
        // 读一条消息（锁 ws_stream）
        let response = shared.read_message().await;

        match response {
            Some(Ok(msg)) => {
                // 检查是否是 pending 请求的响应（锁 client）
                let is_pending = {
                    let client = shared.client.lock().await;
                    client.pending_requests.contains_key(&msg.id)
                };

                if is_pending {
                    shared.handle_incoming(msg).await;
                } else {
                    // 作为事件转发到前端
                    let _ = app.emit("bridge-message", serde_json::json!({
                        "id": msg.id,
                        "type": msg.msg_type,
                        "status": msg.status,
                        "data": msg.data,
                    }));
                }
            }
            Some(Err(e)) => {
                log::error!("WebSocket 接收错误: {}", e);
                let _ = app.emit("bridge-status", serde_json::json!({
                    "status": "error",
                    "error": e,
                }));
                break;
            }
            None => {
                // 流已结束或连接断开
                break;
            }
        }
    }
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let ws_client = SharedWsClient::new(DEFAULT_BRIDGE_URL);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ws_client)
        .invoke_handler(tauri::generate_handler![
            connect_bridge,
            disconnect_bridge,
            get_bridge_status,
            send_to_bridge,
            send_to_bridge_no_wait,
            save_config,
            load_config,
            read_opencode_config,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
