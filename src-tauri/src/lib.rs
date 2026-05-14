mod ws_client;

use futures_util::SinkExt;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_tungstenite::tungstenite::Message;
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
    let mut client = state.lock().await;
    
    if client.state == WsConnectionState::Connected {
        return Ok("already_connected".to_string());
    }

    // 如果之前连接过但断开了，先重置
    if client.state != WsConnectionState::Disconnected {
        client.disconnect().await;
    }

    match client.connect().await {
        Ok(()) => {
            // 启动后台事件循环，接收来自桥接服务的消息
            let client_clone = state.inner().clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                ws_event_loop(client_clone, app_clone).await;
            });
            
            // 发送连接状态事件到前端
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
    let mut client = state.lock().await;
    client.disconnect().await;
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
    
    // 读取现有配置（如果文件存在）
    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    
    // 更新指定键
    if let serde_json::Value::Object(ref mut map) = config {
        map.insert(key, value);
    }
    
    // 写回文件
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
        .map_err(|e| format!("解析配置文件失败: {}", e))?;
    
    Ok(config.get(&key).cloned().unwrap_or(serde_json::Value::Null))
}

// ==================== OpenCode 配置读取 ====================

/// 读取 OpenCode CLI 的配置文件，返回可用模型列表
#[tauri::command]
fn read_opencode_config() -> Result<serde_json::Value, String> {
    // 搜索路径（按优先级）
    let search_paths = [
        // Windows: %APPDATA%/opencode/config.json (最常见)
        std::env::var("APPDATA").ok()
            .map(|p| std::path::PathBuf::from(p).join("opencode").join("config.json")),
        // Windows: %APPDATA%/opencode/settings.json
        std::env::var("APPDATA").ok()
            .map(|p| std::path::PathBuf::from(p).join("opencode").join("settings.json")),
        // Windows: %USERPROFILE%/.config/opencode/config.json
        std::env::var("USERPROFILE").ok()
            .map(|p| std::path::PathBuf::from(p).join(".config").join("opencode").join("config.json")),
        // Windows: %USERPROFILE%/.opencode/config.json
        std::env::var("USERPROFILE").ok()
            .map(|p| std::path::PathBuf::from(p).join(".opencode").join("config.json")),
        // Linux/Mac: ~/.config/opencode/config.json
        std::env::var("HOME").ok()
            .map(|p| std::path::PathBuf::from(p).join(".config").join("opencode").join("config.json")),
        // Linux/Mac: ~/.opencode/config.json
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
                                
                                // 格式1: { "providers": { "openai": { "models": { "gpt-4o": {...} } } } }
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
                                
                                // 格式2: { "models": [ { "name": "...", ... } ] }
                                if let Some(top_models) = config.get("models").and_then(|m| m.as_array()) {
                                    for m in top_models {
                                        if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                                            if !models.iter().any(|existing| existing.get("name").and_then(|n| n.as_str()) == Some(name)) {
                                                models.push(m.clone());
                                            }
                                        }
                                    }
                                }

                                // 格式3: { "selectedModel": "gpt-4o", ... } 单模型格式
                                if let Some(selected) = config.get("selectedModel").and_then(|s| s.as_str()) {
                                    if !models.iter().any(|m| m.get("name").and_then(|n| n.as_str()) == Some(selected)) {
                                        models.push(serde_json::json!({ "name": selected }));
                                    }
                                }

                                if models.is_empty() {
                                    // 配置存在但没解析出模型，加个诊断
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

    // 没找到配置 → 返回常见默认模型，用户可在下拉中手动输入
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
    let client = state.lock().await;
    Ok(client.state.clone())
}

/// 发送消息到桥接服务并等待响应
///
/// ⚠️ 关键设计：分两阶段执行，避免持有锁等待响应。
/// - 阶段一：持锁，插入 pending 记录，发送消息 → 立即释放锁
/// - 阶段二：无锁等待 oneshot 响应（ws_event_loop 可正常读消息和响应 ping）
#[tauri::command]
async fn send_to_bridge(
    state: State<'_, SharedWsClient>,
    msg_type: String,
    data: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // ===== 阶段一：持锁发送，不等待 =====
    let rx = {
        let mut client = state.lock().await;

        // 检查连接状态
        if client.state != WsConnectionState::Connected {
            return Err("未连接到桥接服务，请先调用 connect_bridge".to_string());
        }

        let request = BridgeRequest {
            id: uuid::Uuid::new_v4().to_string(),
            msg_type,
            data,
        };

        // 创建 oneshot channel
        let (tx, rx) = tokio::sync::oneshot::channel();
        client.pending_requests.insert(request.id.clone(), tx);

        // 发送消息
        let stream = client.stream.as_mut()
            .ok_or_else(|| "WebSocket 流不可用".to_string())?;
        let json = serde_json::to_string(&request)
            .map_err(|e| format!("序列化请求失败: {}", e))?;
        stream.send(Message::Text(json.into()))
            .await
            .map_err(|e| format!("发送消息失败: {}", e))?;

        rx // 将 receiver 移出锁作用域
    }; // ★ 锁在此处释放，ws_event_loop 可继续运行 ★

    // ===== 阶段二：无锁等待响应 =====
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        rx,
    )
    .await
    .map_err(|_| "等待响应超时（120秒）".to_string())?
    .map_err(|_| "响应通道已关闭".to_string())?;

    // 返回响应数据
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
    let mut client = state.lock().await;
    
    // 检查连接状态
    if client.state != WsConnectionState::Connected {
        return Err("未连接到桥接服务，请先调用 connect_bridge".to_string());
    }

    // 创建请求
    let request = BridgeRequest {
        id: uuid::Uuid::new_v4().to_string(),
        msg_type,
        data,
    };

    // 只发送不等待响应
    client.send_no_wait(request).await?;

    Ok("消息已发送".to_string())
}

/// 后台事件循环：持续读取 WebSocket 消息并转发到前端
async fn ws_event_loop(client: SharedWsClient, app: AppHandle) {
    loop {
        let mut client_guard = client.lock().await;
        
        // 检查连接是否已断开
        if client_guard.state == WsConnectionState::Disconnected
            || client_guard.state == WsConnectionState::Error("".to_string())
        {
            break;
        }

        match client_guard.read_message().await {
            Some(Ok(response)) => {
                // 如果是 pending request 的响应，直接处理
                if client_guard.pending_requests.contains_key(&response.id) {
                    client_guard.handle_incoming(response).await;
                } else {
                    // 否则作为事件转发到前端
                    let _ = app.emit("bridge-message", serde_json::json!({
                        "id": response.id,
                        "type": response.msg_type,
                        "status": response.status,
                        "data": response.data,
                    }));
                }
            }
            Some(Err(e)) => {
                let err_msg = e.clone();
                log::error!("WebSocket 接收错误: {}", e);
                client_guard.state = WsConnectionState::Error(e);
                let _ = app.emit("bridge-status", serde_json::json!({
                    "status": "error",
                    "error": err_msg,
                }));
                break;
            }
            None => {
                // 流已结束
                break;
            }
        }
    }
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化日志
    env_logger::init();

    // 创建共享的 WebSocket 客户端
    let ws_client = ws_client::create_shared_client(DEFAULT_BRIDGE_URL);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 注册共享状态
        .manage(ws_client)
        // 注册 IPC 命令
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
