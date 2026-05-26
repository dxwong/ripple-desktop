use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

const DEFAULT_PORT: u16 = 9876;
const AGENT_URL: &str = "http://127.0.0.1:3002";
const READ_TIMEOUT_SECS: u64 = 30;
// 空闲超时（心跳计数）：手机端发消息后等待回复，超过此阈值认为连接已死
// 每个心跳间隔 1 秒，故 RESPONSE_IDLE_MAX = 60 即 60 秒无事件则断开
const RESPONSE_IDLE_MAX: u32 = 60;    // handle_chat_stream: 60秒无转发事件则断开
const SUBSCRIBE_IDLE_MAX: u32 = 120;  // handle_bridge_subscribe: 120秒无任何事件则断开

// ── SSE 客户端连接 ──────────────────────────────────────────

struct SseClient {
    sender: Sender<String>,
    #[allow(dead_code)]
    id: u64, // 唯一标识，用于日志追踪
}

static NEXT_SSE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_sse_id() -> u64 {
    NEXT_SSE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub struct MobileBridgeState {
    pub running: Arc<Mutex<bool>>,
    pub port: Arc<Mutex<u16>>,
    sse_clients: Arc<Mutex<Vec<SseClient>>>,
}

impl MobileBridgeState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(false)),
            port: Arc::new(Mutex::new(DEFAULT_PORT)),
            sse_clients: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }

    pub fn get_port(&self) -> u16 {
        *self.port.lock().unwrap()
    }
}

// ── 简单 HTTP 请求解析 ──────────────────────────────────────

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: String,
    #[allow(dead_code)]
    headers: HashMap<String, String>,
}

fn parse_http_request(stream: &mut TcpStream) -> Option<HttpRequest> {
    stream.set_read_timeout(Some(Duration::from_secs(READ_TIMEOUT_SECS))).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);

    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let method = parts[0].to_uppercase();
    let full_path = parts[1].to_string();

    let (path, query) = if let Some(pos) = full_path.find('?') {
        let p = full_path[..pos].to_string();
        let qs = full_path[pos + 1..].to_string();
        let params: HashMap<String, String> = qs
            .split('&')
            .filter_map(|s| {
                let mut kv = s.splitn(2, '=');
                Some((
                    kv.next()?.to_string(),
                    kv.next().unwrap_or("").to_string(),
                ))
            })
            .collect();
        (p, params)
    } else {
        (full_path, HashMap::new())
    };

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(pos) = trimmed.find(':') {
            let key = trimmed[..pos].trim().to_lowercase();
            let val = trimmed[pos + 1..].trim().to_string();
            headers.insert(key, val);
        }
    }

    let mut body = String::new();
    if let Some(len_str) = headers.get("content-length") {
        if let Ok(len) = len_str.parse::<usize>() {
            let mut buf = vec![0u8; len];
            reader.read_exact(&mut buf).ok()?;
            body = String::from_utf8_lossy(&buf).to_string();
        }
    }

    Some(HttpRequest {
        method,
        path,
        query,
        body,
        headers,
    })
}

// ── HTTP 代理：转发请求到 Agent Server ─────────────────────

fn proxy_to_agent(
    method: &str,
    path: &str,
    query: &HashMap<String, String>,
    body: &str,
    content_type: Option<&str>,
) -> Result<(u16, String, String), String> {
    let qs: Vec<String> = query
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect();
    let full_url = if qs.is_empty() {
        format!("{}{}", AGENT_URL, path)
    } else {
        format!("{}{}?{}", AGENT_URL, path, qs.join("&"))
    };

    let ct = content_type.unwrap_or("application/json");

    let resp = match method {
        "GET" => ureq::get(&full_url).call(),
        "DELETE" => ureq::delete(&full_url).call(),
        "POST" => ureq::post(&full_url)
            .set("Content-Type", ct)
            .send_string(body),
        _ => ureq::request(method, &full_url)
            .set("Content-Type", ct)
            .send_string(body),
    }
    .map_err(|e| {
        let err_str = e.to_string();
        format!("代理请求失败 [{} {}]: {}", method, full_url, err_str)
    })?;

    let status = resp.status();
    let resp_body = resp.into_string().map_err(|e| format!("读取响应失败: {}", e))?;

    Ok((status, resp_body, full_url))
}

// ── SSE 响应 ────────────────────────────────────────────────

fn write_sse_response(stream: &mut TcpStream) {
    let headers = "HTTP/1.1 200 OK\r\n\
                   Content-Type: text/event-stream\r\n\
                   Cache-Control: no-cache\r\n\
                   Connection: keep-alive\r\n\
                   Access-Control-Allow-Origin: *\r\n\
                   \r\n";
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.flush();
}

fn write_sse_event(stream: &mut TcpStream, data: &str) -> bool {
    let payload = format!("data: {}\n\n", data);
    stream.write_all(payload.as_bytes()).is_ok() && stream.flush().is_ok()
}

fn write_http_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        status,
        status_text(status),
        content_type,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn write_cors_preflight(stream: &mut TcpStream) {
    let response = "HTTP/1.1 204 No Content\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n\
                    Access-Control-Allow-Headers: Content-Type, Accept\r\n\
                    Content-Length: 0\r\n\
                    Connection: close\r\n\
                    \r\n";
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

// ── 请求路由 ────────────────────────────────────────────────

fn handle_connection(
    mut stream: TcpStream,
    sse_clients: Arc<Mutex<Vec<SseClient>>>,
    app_handle: AppHandle,
) {
    // 缩短的 idle timeout 会快速检测手机端断开（60秒内判定），
    // 替代 TCP keepalive（Windows 兼容性问题）
    
    let request = match parse_http_request(&mut stream) {
        Some(req) => req,
        None => {
            write_http_response(&mut stream, 400, "application/json", r#"{"error":"Bad request"}"#);
            return;
        }
    };

    // CORS 预检
    if request.method == "OPTIONS" {
        write_cors_preflight(&mut stream);
        return;
    }

    // 路由分发
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/health") => {
            write_http_response(
                &mut stream,
                200,
                "application/json",
                r#"{"status":"ok","bridge":"ripple-mobile-bridge"}"#,
            );
        }

        // ── 代理：会话列表 ──
        ("GET", "/api/sessions") => {
            match proxy_to_agent("GET", "/api/sessions", &request.query, "", None) {
                Ok((status, body, _)) => {
                    write_http_response(&mut stream, status, "application/json", &body);
                }
                Err(e) => {
                    write_http_response(&mut stream, 500, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                }
            }
        }

        // ── 代理：单个会话详情（支持分页） ──
        ("GET", path) if path.starts_with("/api/sessions/") && !path.ends_with("/copy") => {
            match proxy_to_agent("GET", path, &request.query, "", None) {
                Ok((status, body, _)) => {
                    write_http_response(&mut stream, status, "application/json", &body);
                }
                Err(e) => {
                    write_http_response(&mut stream, 500, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                }
            }
        }

        // ── 代理：删除会话（同时通知桌面端前端刷新） ──
        ("DELETE", path) if path.starts_with("/api/sessions/") => {
            match proxy_to_agent("DELETE", path, &request.query, &request.body, None) {
                Ok((status, body, _)) => {
                    write_http_response(&mut stream, status, "application/json", &body);
                    // 删除成功后通知桌面端前端刷新对话列表
                    if status == 200 {
                        let session_id = path.strip_prefix("/api/sessions/").unwrap_or("").to_string();
                        // 去掉末尾的查询参数（如果有）和空白
                        let session_id = session_id.split('?').next().unwrap_or("").trim().to_string();
                        if !session_id.is_empty() {
                            println!("[MobileBridge] 手机端删除对话成功，通知桌面端: sessionId={}", session_id);
                            let _ = app_handle.emit(
                                "mobile-delete-conversation",
                                serde_json::json!({
                                    "sessionId": session_id
                                }),
                            );
                        }
                    }
                }
                Err(e) => {
                    write_http_response(&mut stream, 500, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                }
            }
        }

        // ── 代理：创建/更新会话（手机端新建对话时调用 saveSession）──
        ("POST", path) if path.starts_with("/api/sessions/") => {
            match proxy_to_agent(
                "POST",
                path,
                &request.query,
                &request.body,
                Some("application/json"),
            ) {
                Ok((status, body, _)) => {
                    write_http_response(&mut stream, status, "application/json", &body);
                }
                Err(e) => {
                    write_http_response(&mut stream, 500, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                }
            }
        }

        // ── 代理：停止生成 ──
        ("POST", "/api/chat/abort") => {
            match proxy_to_agent(
                "POST",
                "/api/chat/abort",
                &request.query,
                &request.body,
                Some("application/json"),
            ) {
                Ok((status, body, _)) => {
                    write_http_response(&mut stream, status, "application/json", &body);
                }
                Err(e) => {
                    write_http_response(&mut stream, 500, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                }
            }
        }

        // ── 代理：工具确认 ──
        ("POST", path) if path.starts_with("/api/chat/") && path.ends_with("/confirm") => {
            match proxy_to_agent(
                "POST",
                path,
                &request.query,
                &request.body,
                Some("application/json"),
            ) {
                Ok((status, body, _)) => {
                    write_http_response(&mut stream, status, "application/json", &body);
                }
                Err(e) => {
                    write_http_response(&mut stream, 500, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                }
            }
        }

        // ── 被动监听 SSE（手机端订阅桌面端事件流）──
        ("GET", "/api/bridge/subscribe") => {
            handle_bridge_subscribe(&mut stream, &sse_clients, &app_handle);
        }

        // ── 会话同步（手机端通知桌面端切换对话）──
        ("POST", "/api/bridge/sync-session") => {
            let body: Value = match serde_json::from_str(&request.body) {
                Ok(v) => v,
                Err(e) => {
                    write_http_response(&mut stream, 400, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                    return;
                }
            };
            let session_id = body.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let title = body.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let _ = app_handle.emit(
                "mobile-sync-session",
                serde_json::json!({
                    "sessionId": session_id,
                    "title": title
                }),
            );
            write_http_response(
                &mut stream,
                200,
                "application/json",
                r#"{"status":"ok"}"#,
            );
        }

        // ── 手机端新建普通对话 ──
        ("POST", "/api/bridge/new-conversation") => {
            let body: Value = match serde_json::from_str(&request.body) {
                Ok(v) => v,
                Err(e) => {
                    write_http_response(&mut stream, 400, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                    return;
                }
            };
            let session_id = body.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let title = body.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let mode = body.get("mode").and_then(|v| v.as_str()).unwrap_or("chat");
            let cwd = body.get("cwd").and_then(|v| v.as_str());
            let _ = app_handle.emit(
                "mobile-new-conversation",
                serde_json::json!({
                    "sessionId": session_id,
                    "title": title,
                    "mode": mode,
                    "cwd": cwd,
                }),
            );
            println!("[MobileBridge] 手机端请求新建对话: sessionId={} title={} mode={} cwd={:?}", session_id, title, mode, cwd);
            write_http_response(&mut stream, 200, "application/json", r#"{"status":"ok"}"#);
        }

        // ── 手机端新建项目对话 ──
        ("POST", "/api/bridge/new-project-conversation") => {
            let body: Value = match serde_json::from_str(&request.body) {
                Ok(v) => v,
                Err(e) => {
                    write_http_response(&mut stream, 400, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                    return;
                }
            };
            let session_id = body.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("新项目");
            let directory = body.get("directory").and_then(|v| v.as_str()).unwrap_or("");
            let _ = app_handle.emit(
                "mobile-new-project-conversation",
                serde_json::json!({
                    "sessionId": session_id,
                    "name": name,
                    "directory": directory,
                }),
            );
            println!("[MobileBridge] 手机端请求新建项目对话: sessionId={} name={} directory={}", session_id, name, directory);
            write_http_response(&mut stream, 200, "application/json", r#"{"status":"ok"}"#);
        }

        // ── 手机端重命名对话 ──
        ("POST", "/api/bridge/rename-conversation") => {
            let body: Value = match serde_json::from_str(&request.body) {
                Ok(v) => v,
                Err(e) => {
                    write_http_response(&mut stream, 400, "application/json", &format!(r#"{{"error":"{}"}}"#, e));
                    return;
                }
            };
            let session_id = body.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let title = body.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let _ = app_handle.emit(
                "mobile-rename-conversation",
                serde_json::json!({
                    "sessionId": session_id,
                    "title": title,
                }),
            );
            println!("[MobileBridge] 手机端请求重命名对话: sessionId={} title={}", session_id, title);
            write_http_response(&mut stream, 200, "application/json", r#"{"status":"ok"}"#);
        }

        // ── 聊天 SSE 流（手机端发消息入口）──
        // 必须同时支持 /api/chat 和 /api/chat/stream 两种路径：
        //   - /api/chat          ← 共享 SSEClient 的硬编码路径（手机端和桌面端都用这个）
        //   - /api/chat/stream   ← Bridge 专属路径（架构文档中的规范路径）
        // ⚠️ Agent Server 也有 POST /api/chat 路由（端口 3002）
        //    如果 Bridge 不处理此路径，手机端 SSEClient 请求会穿透到 Agent Server
        //    导致手机直连 Agent、绕过桌面端、桌面端无反应
        ("POST", "/api/chat") | ("POST", "/api/chat/stream") => {
            handle_chat_stream(&mut stream, &request, &sse_clients, &app_handle);
        }

        _ => {
            write_http_response(
                &mut stream,
                404,
                "application/json",
                &format!(r#"{{"error":"Not found: {} {}"}}"#, request.method, request.path),
            );
        }
    }
}

// ── 聊天 SSE 处理 ───────────────────────────────────────────

fn handle_chat_stream(
    stream: &mut TcpStream,
    request: &HttpRequest,
    sse_clients: &Arc<Mutex<Vec<SseClient>>>,
    app_handle: &AppHandle,
) {
    // 解析请求体
    let chat_request: Value = match serde_json::from_str(&request.body) {
        Ok(v) => v,
        Err(e) => {
            write_http_response(
                stream,
                400,
                "application/json",
                &format!(r#"{{"error":"Invalid JSON: {}"}}"#, e),
            );
            return;
        }
    };

    // 调试日志：记录手机端请求的关键字段
    {
        let debug_info = serde_json::json!({
            "event": "mobile_chat_request",
            "sessionId": chat_request.get("sessionId"),
            "message_length": chat_request.get("message").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0),
            "has_cwd": chat_request.get("cwd").is_some(),
            "has_title": chat_request.get("title").is_some(),
        });
        println!("[MobileBridge] 收到手机端请求: {}", serde_json::to_string(&debug_info).unwrap_or_default());
    }

    let session_id = chat_request
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();

    // 建立 SSE 响应
    write_sse_response(stream);

    // 注册 SSE 客户端
    let (tx, rx) = mpsc::channel::<String>();
    let client_id = next_sse_id();
    {
        let mut clients = sse_clients.lock().unwrap();
        clients.retain(|c| !c.sender.send("__ping__".to_string()).is_err());
        clients.push(SseClient { sender: tx, id: client_id });
    }
    println!(
        "[MobileBridge] SSE 客户端已连接 (client_id={}, session={}), 当前连接数: {}",
        client_id,
        session_id,
        sse_clients.lock().unwrap().len()
    );

    // 发送确认连接事件
    write_sse_event(
        stream,
        &serde_json::json!({
            "type": "connected",
            "sessionId": session_id
        })
        .to_string(),
    );

    // 通知前端：手机端已连接
    let client_count = sse_clients.lock().unwrap().len();
    let _ = app_handle.emit(
        "mobile-connection-change",
        serde_json::json!({
            "connected": true,
            "count": client_count
        }),
    );

    // 通过 Tauri 事件通知前端：手机端发来了消息
    // 只传递必要字段：message、sessionId、cwd、title（手机端只需抛数据，不传递模型配置）
    let chat_request_payload = serde_json::json!({
        "message": chat_request.get("message").and_then(|v| v.as_str()).unwrap_or(""),
        "sessionId": session_id,
        "cwd": chat_request.get("cwd").and_then(|v| v.as_str()),
        "title": chat_request.get("title").and_then(|v| v.as_str()),
        "regenerate": chat_request.get("regenerate").and_then(|v| v.as_bool()).unwrap_or(false),
    });
    println!("[MobileBridge] 发射 mobile-chat-request 事件: {}", serde_json::to_string(&chat_request_payload).unwrap_or_default());
    let _ = app_handle.emit(
        "mobile-chat-request",
        chat_request_payload,
    );

    // 持续读取来自前端的广播事件，推送给手机端
    let mut error_count = 0u32;
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(event_json) => {
                if event_json == "__ping__" {
                    continue;
                }
                if event_json == "__done__" {
                    write_sse_event(
                        stream,
                        &serde_json::json!({"type": "done"}).to_string(),
                    );
                    break;
                }
                if !write_sse_event(stream, &event_json) {
                    break;
                }
                error_count = 0;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // 发送心跳保持连接（SSE 注释行以 : 开头）
                let ping = ": heartbeat\n\n";
                if stream.write_all(ping.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }

        error_count += 1;
        if error_count > RESPONSE_IDLE_MAX {
            // 60秒无真实事件，断开
            break;
        }
    }

    // 计算剩余存活连接数（排除当前正在断开的客户端自身）
    let remaining = {
        let mut clients = sse_clients.lock().unwrap();
        // 清理其他已断开的客户端（它们的 rx 已 drop，send 会失败）
        clients.retain(|c| c.id == client_id || c.sender.send("__ping__".to_string()).is_ok());
        // 统计除自己外的存活客户端数
        let other_count = clients.iter().filter(|c| c.id != client_id).count();
        // 从列表中移除自己（当前线程的 rx 仍在作用域内，ping 检查会误判为存活）
        clients.retain(|c| c.id != client_id);
        other_count
    };
    println!(
        "[MobileBridge] SSE 客户端已断开 (client_id={}, session={}), 当前连接数: {}",
        client_id,
        session_id,
        remaining
    );

    // 通知前端：手机端已断开（报告当前剩余连接数）
    let _ = app_handle.emit(
        "mobile-connection-change",
        serde_json::json!({
            "connected": remaining > 0,
            "count": remaining
        }),
    );
}

// ── 被动监听 SSE（手机端订阅，不触发聊天）───────────────────

fn handle_bridge_subscribe(
    stream: &mut TcpStream,
    sse_clients: &Arc<Mutex<Vec<SseClient>>>,
    app_handle: &AppHandle,
) {
    write_sse_response(stream);

    let (tx, rx) = mpsc::channel::<String>();
    let client_id = next_sse_id();
    {
        let mut clients = sse_clients.lock().unwrap();
        clients.retain(|c| !c.sender.send("__ping__".to_string()).is_err());
        clients.push(SseClient { sender: tx, id: client_id });
    }
    println!(
        "[MobileBridge] 被动监听 SSE 已连接 (client_id={}), 当前连接数: {}",
        client_id,
        sse_clients.lock().unwrap().len()
    );

    write_sse_event(
        stream,
        &serde_json::json!({
            "type": "subscribed"
        }).to_string(),
    );

    // 通知前端：手机端已通过持久订阅连接
    let client_count = sse_clients.lock().unwrap().len();
    let _ = app_handle.emit(
        "mobile-connection-change",
        serde_json::json!({
            "connected": true,
            "count": client_count
        }),
    );

    let mut error_count = 0u32;
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(event_json) => {
                if event_json == "__ping__" {
                    continue;
                }
                if event_json == "__done__" {
                    break;
                }
                if !write_sse_event(stream, &event_json) {
                    break;
                }
                error_count = 0;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let ping = ": heartbeat\n\n";
                if stream.write_all(ping.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }

        error_count += 1;
        if error_count > SUBSCRIBE_IDLE_MAX {
            // 120秒无真实事件，断开（心跳不计）
            break;
        }
    }

    // 计算剩余存活连接数（排除当前正在断开的客户端自身）
    let remaining = {
        let mut clients = sse_clients.lock().unwrap();
        // 清理其他已断开的客户端（它们的 rx 已 drop，send 会失败）
        clients.retain(|c| c.id == client_id || c.sender.send("__ping__".to_string()).is_ok());
        // 统计除自己外的存活客户端数
        let other_count = clients.iter().filter(|c| c.id != client_id).count();
        // 从列表中移除自己（当前线程的 rx 仍在作用域内，ping 检查会误判为存活）
        clients.retain(|c| c.id != client_id);
        other_count
    };
    println!(
        "[MobileBridge] 被动监听 SSE 已断开 (client_id={}), 当前连接数: {}",
        client_id,
        remaining
    );

    // 通知前端：手机端已断开（报告当前剩余连接数）
    let _ = app_handle.emit(
        "mobile-connection-change",
        serde_json::json!({
            "connected": remaining > 0,
            "count": remaining
        }),
    );
}

// ── 广播事件给所有连接的手机端 ──────────────────────────────

fn broadcast_event(sse_clients: &Arc<Mutex<Vec<SseClient>>>, event_json: &str) -> usize {
    let mut clients = sse_clients.lock().unwrap();
    // 清理断开的客户端
    clients.retain(|c| c.sender.send("__ping__".to_string()).is_ok());
    // 广播
    let mut sent = 0usize;
    for client in clients.iter() {
        if client.sender.send(event_json.to_string()).is_ok() {
            sent += 1;
        }
    }
    if sent > 0 {
        println!("[MobileBridge] 广播事件到 {} 个客户端, 存活: {}", sent, clients.len());
    }
    sent
}

// ── Tauri 命令 ──────────────────────────────────────────────

#[tauri::command]
pub fn start_mobile_bridge(
    app_handle: AppHandle,
    state: tauri::State<MobileBridgeState>,
    port: Option<u16>,
) -> Result<u16, String> {
    if *state.running.lock().unwrap() {
        return Ok(state.get_port());
    }

    let bridge_port = port.unwrap_or(DEFAULT_PORT);
    *state.port.lock().unwrap() = bridge_port;

    let sse_clients = state.sse_clients.clone();
    let running = state.running.clone();

    let listener = TcpListener::bind(format!("0.0.0.0:{}", bridge_port))
        .map_err(|e| format!("无法绑定端口 {}: {}", bridge_port, e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败: {}", e))?;

    *running.lock().unwrap() = true;

    let running_clone = running.clone();
    let app_clone = app_handle.clone();

    thread::spawn(move || {
        println!("[MobileBridge] 服务已启动在端口 {}", bridge_port);

        let _ = app_clone.emit(
            "mobile-bridge-status",
            serde_json::json!({
                "status": "started",
                "port": bridge_port
            }),
        );

        loop {
            if !*running_clone.lock().unwrap() {
                break;
            }

            match listener.accept() {
                Ok((stream, addr)) => {
                    println!("[MobileBridge] 新连接: {}", addr);
                    let clients = sse_clients.clone();
                    let app = app_clone.clone();
                    thread::spawn(move || {
                        handle_connection(stream, clients, app);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    eprintln!("[MobileBridge] 接受连接失败: {}", e);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }

        println!("[MobileBridge] 服务已停止");
    });

    Ok(bridge_port)
}

#[tauri::command]
pub fn stop_mobile_bridge(
    app_handle: AppHandle,
    state: tauri::State<MobileBridgeState>,
) -> Result<bool, String> {
    let was_running = *state.running.lock().unwrap();
    *state.running.lock().unwrap() = false;

    // 通知所有 SSE 客户端断开
    {
        let mut clients = state.sse_clients.lock().unwrap();
        for client in clients.iter() {
            let _ = client.sender.send("__done__".to_string());
        }
        clients.clear();
    }

    if was_running {
        let _ = app_handle.emit(
            "mobile-bridge-status",
            serde_json::json!({
                "status": "stopped"
            }),
        );
    }

    Ok(was_running)
}

#[tauri::command]
pub fn broadcast_mobile_event(
    state: tauri::State<MobileBridgeState>,
    event_json: String,
) -> Result<usize, String> {
    if !*state.running.lock().unwrap() {
        return Ok(0);
    }
    let sent = broadcast_event(&state.sse_clients, &event_json);
    Ok(sent)
}