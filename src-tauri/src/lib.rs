mod ws_client;

use futures_util::StreamExt;
use std::io::BufRead;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_tungstenite::tungstenite::Message;
use ws_client::{BridgeRequest, BridgeResponse, EventLoopCommand, SharedWsClient, WsConnectionState, WebSocketClient};

const DEFAULT_BRIDGE_URL: &str = "ws://127.0.0.1:9876";

// ==================== 桥接进程管理 ====================

#[derive(Clone, serde::Serialize)]
pub struct BridgeLogEntry {
    pub line: String,
    pub timestamp: String,
}

#[derive(Clone)]
pub struct BridgeProcess {
    pub child: Arc<Mutex<Option<std::process::Child>>>,
    pub logs: Arc<Mutex<Vec<BridgeLogEntry>>>,
}

/// 退出时自动清理桥接进程
impl Drop for BridgeProcess {
    fn drop(&mut self) {
        let mut guard = self.child.blocking_lock();
        if let Some(ref mut child) = *guard {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl BridgeProcess {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            logs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 启动 Python 桥接服务
    pub async fn start(&self, app_dir: &std::path::Path) {
        // 尝试多个路径：项目根目录、src-tauri 上级目录、当前目录
        let candidates = [
            app_dir.join("bridge").join("bridge_server.py"),
            app_dir.join("../bridge").join("bridge_server.py"),
            std::path::PathBuf::from("bridge/bridge_server.py"),
            std::path::PathBuf::from("../bridge/bridge_server.py"),
        ];
        let bridge_path = candidates.iter().find(|p| p.exists()).cloned();
        let bridge_path = match bridge_path {
            Some(p) => p,
            None => {
                log::warn!("未找到 bridge/bridge_server.py，已搜索 {:?}", candidates);
                self.add_log("WARN: 未找到桥接脚本").await;
                return;
            }
        };

        log::info!("启动桥接: {}", bridge_path.display());
        self.add_log(&format!("启动桥接: {}", bridge_path.display())).await;

        match std::process::Command::new("python")
            .arg(&bridge_path)
            .current_dir(app_dir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                let logs_arc = self.logs.clone();

                // 读 stdout
                if let Some(stdout) = child.stdout.take() {
                    std::thread::spawn(move || {
                        let reader = std::io::BufReader::new(stdout);
                        for line in reader.lines().flatten() {
                            let ts = format_ts();
                            let mut logs = logs_arc.blocking_lock();
                            logs.push(BridgeLogEntry { timestamp: ts, line });
                            if logs.len() > 1000 { logs.remove(0); }
                        }
                    });
                }

                // 读 stderr
                if let Some(stderr) = child.stderr.take() {
                    let logs_arc = self.logs.clone();
                    std::thread::spawn(move || {
                        let reader = std::io::BufReader::new(stderr);
                        for line in reader.lines().flatten() {
                            let ts = format_ts();
                            let mut logs = logs_arc.blocking_lock();
                            logs.push(BridgeLogEntry { timestamp: ts, line: format!("[ERR] {}", line) });
                            if logs.len() > 1000 { logs.remove(0); }
                        }
                    });
                }

                let mut guard = self.child.blocking_lock();
                *guard = Some(child);
                log::info!("桥接已启动");
                self.add_log("桥接已启动").await;
            }
            Err(e) => {
                log::error!("启动桥接失败: {}", e);
                self.add_log(&format!("启动失败: {}", e)).await;
            }
        }
    }

    pub async fn stop(&self) {
        let mut guard = self.child.lock().await;
        if let Some(ref mut child) = *guard {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }

    async fn add_log(&self, line: &str) {
        let mut logs = self.logs.lock().await;
        logs.push(BridgeLogEntry { timestamp: format_ts(), line: line.to_string() });
        if logs.len() > 1000 { logs.remove(0); }
    }
}

fn format_ts() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() % 86400;
    format!("{:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
}

#[tauri::command]
async fn get_bridge_logs(state: State<'_, BridgeProcess>) -> Result<Vec<BridgeLogEntry>, String> {
    Ok(state.logs.lock().await.clone())
}

// ==================== Tauri 命令 ====================

#[tauri::command]
async fn connect_bridge(state: State<'_, SharedWsClient>, app: AppHandle) -> Result<String, String> {
    {
        let client = state.client.lock().await;
        if client.state == WsConnectionState::Connected {
            return Ok("already_connected".to_string());
        }
    }

    match state.connect().await {
        Ok((stream, command_rx)) => {
            let client_arc = state.client.clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                event_loop(stream, command_rx, client_arc, app_clone).await;
            });
            let _ = app.emit("bridge-status", serde_json::json!({"status": "connected", "url": DEFAULT_BRIDGE_URL}));
            Ok("connected".to_string())
        }
        Err(e) => {
            let _ = app.emit("bridge-status", serde_json::json!({"status": "error", "error": e.clone()}));
            Err(e)
        }
    }
}

#[tauri::command]
async fn disconnect_bridge(state: State<'_, SharedWsClient>, app: AppHandle) -> Result<String, String> {
    state.disconnect().await;
    let _ = app.emit("bridge-status", serde_json::json!({"status": "disconnected"}));
    Ok("disconnected".to_string())
}

// ==================== 事件循环 ====================

async fn event_loop(
    mut stream: impl futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
    mut command_rx: tokio::sync::mpsc::UnboundedReceiver<EventLoopCommand>,
    client_arc: Arc<tokio::sync::Mutex<WebSocketClient>>,
    app: AppHandle,
) {
    use futures_util::SinkExt;
    loop {
        tokio::select! {
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<BridgeResponse>(&text) {
                            Ok(response) => {
                                let is_pending = { client_arc.lock().await.pending_requests.contains_key(&response.id) };
                                if is_pending {
                                    let mut client = client_arc.lock().await;
                                    if let Some(sender) = client.pending_requests.remove(&response.id) {
                                        let _ = sender.send(Ok(response));
                                    }
                                } else {
                                    let _ = app.emit("bridge-message", serde_json::json!({
                                        "id": response.id, "type": response.msg_type,
                                        "status": response.status, "data": response.data,
                                    }));
                                }
                            }
                            Err(e) => log::error!("解析桥接响应失败: {}", e),
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        let mut client = client_arc.lock().await;
                        client.state = WsConnectionState::Disconnected;
                        let _ = app.emit("bridge-status", serde_json::json!({"status": "disconnected"}));
                        break;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = stream.send(Message::Pong(data)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        let mut client = client_arc.lock().await;
                        client.state = WsConnectionState::Error(e.to_string());
                        let _ = app.emit("bridge-status", serde_json::json!({"status": "error", "error": e.to_string()}));
                        break;
                    }
                    None => { break; }
                }
            }
            cmd = command_rx.recv() => {
                match cmd {
                    Some(EventLoopCommand::SendAndWait { request, sender }) => {
                        let json = match serde_json::to_string(&request) {
                            Ok(j) => j,
                            Err(e) => { let _ = sender.send(Err(format!("序列化失败: {}", e))); continue; }
                        };
                        match stream.send(Message::Text(json.into())).await {
                            Ok(_) => { client_arc.lock().await.pending_requests.insert(request.id.clone(), sender); }
                            Err(e) => { let _ = sender.send(Err(format!("发送失败: {}", e))); }
                        }
                    }
                    Some(EventLoopCommand::SendNoWait { request }) => {
                        if let Ok(json) = serde_json::to_string(&request) {
                            let _ = stream.send(Message::Text(json.into())).await;
                        }
                    }
                    None => { break; }
                }
            }
        }
    }
    let mut client = client_arc.lock().await;
    client.pending_requests.clear();
    client.state = WsConnectionState::Disconnected;
}

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

// ==================== OpenCode 配置读取 ====================

#[tauri::command]
fn read_opencode_config() -> Result<serde_json::Value, String> {
    let search_paths = [
        std::env::var("APPDATA").ok().map(|p| std::path::PathBuf::from(p).join("opencode").join("config.json")),
        std::env::var("APPDATA").ok().map(|p| std::path::PathBuf::from(p).join("opencode").join("settings.json")),
        std::env::var("USERPROFILE").ok().map(|p| std::path::PathBuf::from(p).join(".config").join("opencode").join("config.json")),
        std::env::var("USERPROFILE").ok().map(|p| std::path::PathBuf::from(p).join(".opencode").join("config.json")),
    ];
    for path_opt in &search_paths {
        if let Some(ref path) = path_opt {
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(path) {
                    if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                        let models = extract_models(&config);
                        return Ok(serde_json::json!({"models": models, "config_path": path.to_string_lossy().to_string()}));
                    }
                }
            }
        }
    }
    Ok(serde_json::json!({"models": [], "note": "未找到配置文件"}))
}

fn extract_models(config: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut models = Vec::new();
    if let Some(providers) = config.get("providers").and_then(|p| p.as_object()) {
        for (pn, pc) in providers {
            if let Some(ms) = pc.get("models").and_then(|m| m.as_object()) {
                for (mn, _) in ms {
                    models.push(serde_json::json!({"name": mn, "provider": pn}));
                }
            }
        }
    }
    if let Some(top) = config.get("models").and_then(|m| m.as_array()) {
        for m in top {
            if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                if !models.iter().any(|e| e.get("name").and_then(|n| n.as_str()) == Some(name)) {
                    models.push(m.clone());
                }
            }
        }
    }
    models
}

#[tauri::command]
async fn get_bridge_status(state: State<'_, SharedWsClient>) -> Result<WsConnectionState, String> {
    Ok(state.client.lock().await.state.clone())
}

#[tauri::command]
async fn send_to_bridge(state: State<'_, SharedWsClient>, msg_type: String, data: serde_json::Value) -> Result<serde_json::Value, String> {
    let request = BridgeRequest { id: uuid::Uuid::new_v4().to_string(), msg_type, data };
    let response = state.send_request(request).await?;
    Ok(serde_json::json!({"status": response.status, "data": response.data}))
}

#[tauri::command]
async fn send_to_bridge_no_wait(state: State<'_, SharedWsClient>, msg_type: String, data: serde_json::Value) -> Result<String, String> {
    let request = BridgeRequest { id: uuid::Uuid::new_v4().to_string(), msg_type, data };
    state.send_no_wait(request).await?;
    Ok("ok".to_string())
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let ws_client = SharedWsClient::new(DEFAULT_BRIDGE_URL);
    let bridge_process = BridgeProcess::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ws_client)
        .manage(bridge_process)
        .invoke_handler(tauri::generate_handler![
            connect_bridge, disconnect_bridge, get_bridge_status,
            send_to_bridge, send_to_bridge_no_wait,
            save_config, load_config, read_opencode_config,
            get_bridge_logs,
        ])
        .setup(|app| {
            let bp: BridgeProcess = app.state::<BridgeProcess>().inner().clone();
            let app_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all().build().unwrap();
                rt.block_on(bp.start(&app_dir));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
