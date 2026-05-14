mod ws_client;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_tungstenite::tungstenite::Message;
use ws_client::{BridgeRequest, BridgeResponse, EventLoopCommand, SharedWsClient, WsConnectionState, WebSocketClient};

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
        Ok((stream, command_rx)) => {
            // 启动后台事件循环，独占 WebSocket 流
            let client_arc = state.client.clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                event_loop(stream, command_rx, client_arc, app_clone).await;
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

// ==================== 事件循环 ====================

/// 后台事件循环：独占 WebSocket 流，用 select! 同时处理收发
///
/// select! 的两个分支：
/// 1. stream.next() → 收到桥接消息 → 路由到 pending 请求或 emit 到前端
/// 2. command_rx.recv() → 收到发送命令 → 通过 WebSocket 发出
///
/// 关键优势：没有共享锁，事件循环持有流期间不阻塞任何其他操作
async fn event_loop(
    mut stream: impl futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
    mut command_rx: tokio::sync::mpsc::UnboundedReceiver<EventLoopCommand>,
    client_arc: std::sync::Arc<tokio::sync::Mutex<WebSocketClient>>,
    app: AppHandle,
) {
    use futures_util::SinkExt;

    loop {
        tokio::select! {
            // ===== 分支 1：收到桥接消息 =====
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<BridgeResponse>(&text) {
                            Ok(response) => {
                                let is_pending = {
                                    let client = client_arc.lock().await;
                                    client.pending_requests.contains_key(&response.id)
                                };

                                if is_pending {
                                    // 路由到 pending 请求
                                    let mut client = client_arc.lock().await;
                                    if let Some(sender) = client.pending_requests.remove(&response.id) {
                                        let _ = sender.send(Ok(response));
                                    } else {
                                        log::warn!("pending 请求 {} 已消失", response.id);
                                    }
                                } else {
                                    // 作为事件转发到前端
                                    let _ = app.emit("bridge-message", serde_json::json!({
                                        "id": response.id,
                                        "type": response.msg_type,
                                        "status": response.status,
                                        "data": response.data,
                                    }));
                                }
                            }
                            Err(e) => {
                                log::error!("解析桥接响应失败: {}", e);
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        log::info!("桥接连接已关闭");
                        let mut client = client_arc.lock().await;
                        client.state = WsConnectionState::Disconnected;
                        let _ = app.emit("bridge-status", serde_json::json!({
                            "status": "disconnected",
                        }));
                        break;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if let Err(e) = stream.send(Message::Pong(data)).await {
                            log::error!("发送 Pong 失败: {}", e);
                        }
                    }
                    Some(Ok(_)) => {} // 其他消息类型忽略
                    Some(Err(e)) => {
                        log::error!("WebSocket 接收错误: {}", e);
                        let mut client = client_arc.lock().await;
                        client.state = WsConnectionState::Error(e.to_string());
                        let _ = app.emit("bridge-status", serde_json::json!({
                            "status": "error",
                            "error": e.to_string(),
                        }));
                        break;
                    }
                    None => {
                        log::info!("WebSocket 流已结束");
                        let mut client = client_arc.lock().await;
                        client.state = WsConnectionState::Disconnected;
                        break;
                    }
                }
            }

            // ===== 分支 2：收到发送命令 =====
            cmd = command_rx.recv() => {
                match cmd {
                    Some(EventLoopCommand::SendAndWait { request, sender }) => {
                        let json = match serde_json::to_string(&request) {
                            Ok(j) => j,
                            Err(e) => {
                                let _ = sender.send(Err(format!("序列化失败: {}", e)));
                                continue;
                            }
                        };
                        match stream.send(Message::Text(json.into())).await {
                            Ok(_) => {
                                // 发送成功，将 sender 存入 pending
                                let mut client = client_arc.lock().await;
                                // 将 oneshot::Sender<Result<BridgeResponse, String>> 转为
                                // oneshot::Sender<BridgeResponse> 存入 pending_requests
                                // 我们需要一个新的通道类型来匹配
                                // 这里直接使用 sender 的变体
                                client.pending_requests.insert(request.id.clone(), sender);
                            }
                            Err(e) => {
                                let _ = sender.send(Err(format!("发送失败: {}", e)));
                            }
                        }
                    }
                    Some(EventLoopCommand::SendNoWait { request }) => {
                        let json = match serde_json::to_string(&request) {
                            Ok(j) => j,
                            Err(e) => {
                                log::error!("序列化发送请求失败: {}", e);
                                continue;
                            }
                        };
                        if let Err(e) = stream.send(Message::Text(json.into())).await {
                            log::error!("发送消息失败: {}", e);
                        }
                    }
                    None => {
                        // command_rx 通道关闭，退出
                        log::info!("事件循环命令通道已关闭");
                        break;
                    }
                }
            }
        }
    }

    // 清理 pending_requests（通知所有等待者）
    let mut client = client_arc.lock().await;
    client.pending_requests.clear();
    client.state = WsConnectionState::Disconnected;
}

// ==================== JSON 配置持久化 ====================

/// 配置文件路径
fn get_config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_dir = app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("无法创建数据目录: {}", e))?;
    Ok(app_dir.join("config.json"))
}

/// 保存配置
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

/// 加载配置
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

/// 读取 OpenCode CLI 配置
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
                                                    models.push(serde_json::json!({"name": model_name, "provider": provider_name}));
                                                }
                                            }
                                            if let Some(models_arr) = provider_models.as_array() {
                                                for m in models_arr {
                                                    if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                                                        let entry = serde_json::json!({"name": name, "provider": provider_name});
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
                                        models.push(serde_json::json!({"name": selected}));
                                    }
                                }
                                return Ok(serde_json::json!({"models": models, "config_path": path.to_string_lossy().to_string()}));
                            }
                            Err(e) => log::warn!("解析 OpenCode 配置文件失败 ({}): {}", path.display(), e),
                        }
                    }
                    Err(e) => log::warn!("读取 OpenCode 配置文件失败 ({}): {}", path.display(), e),
                }
            }
        }
    }
    log::info!("未找到 OpenCode 配置文件，已扫描路径: {:?}", tried_paths);
    Ok(serde_json::json!({"models": [], "note": "未找到配置文件，可在下拉菜单中手动输入模型名", "scanned_paths": tried_paths}))
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
    Ok(serde_json::json!({"status": response.status, "data": response.data}))
}

/// 发送消息到桥接服务（不等待响应）
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
