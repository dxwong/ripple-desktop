use std::sync::Arc;
use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;

/// WebSocket 连接状态
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WsConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

/// 发送给桥接服务的消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub data: Value,
}

/// 从桥接服务收到的响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub status: String,
    pub data: Value,
}

/// WebSocket 客户端状态（不含 stream，stream 单独加锁）
pub struct WebSocketClient {
    /// 连接状态
    pub state: WsConnectionState,
    /// 挂起的请求映射（ID → oneshot 发送端）
    pub(crate) pending_requests: HashMap<String, tokio::sync::oneshot::Sender<BridgeResponse>>,
}

impl WebSocketClient {
    pub fn new() -> Self {
        Self {
            state: WsConnectionState::Disconnected,
            pending_requests: HashMap::new(),
        }
    }
}

/// 共享客户端：两把独立锁，互不阻塞
///
/// - `client` 锁：保护连接状态 + 挂起请求
/// - `ws_stream` 锁：保护 WebSocket 流（发送/接收）
///
/// ws_event_loop 只锁 ws_stream 读消息，然后短暂锁 client 路由消息。
/// send_to_bridge 锁 client 设 pending，锁 ws_stream 发消息，然后释放两把锁等响应。
#[derive(Clone)]
pub struct SharedWsClient {
    pub client: Arc<Mutex<WebSocketClient>>,
    pub ws_stream: Arc<Mutex<Option<WebSocketStream<MaybeTlsStream<TcpStream>>>>>,
    bridge_url: String,
}

impl SharedWsClient {
    pub fn new(bridge_url: &str) -> Self {
        Self {
            client: Arc::new(Mutex::new(WebSocketClient::new())),
            ws_stream: Arc::new(Mutex::new(None)),
            bridge_url: bridge_url.to_string(),
        }
    }

    /// 连接到 Python 桥接服务
    pub async fn connect(&self) -> Result<(), String> {
        {
            let mut client = self.client.lock().await;
            if client.state == WsConnectionState::Connected {
                return Ok(());
            }
            client.state = WsConnectionState::Connecting;
        }

        let (stream, _) = tokio_tungstenite::connect_async(&self.bridge_url)
            .await
            .map_err(|e| format!("连接桥接服务失败: {}", e))?;

        {
            let mut client = self.client.lock().await;
            client.state = WsConnectionState::Connected;
        }
        {
            let mut ws = self.ws_stream.lock().await;
            *ws = Some(stream);
        }

        log::info!("WebSocket 已连接到桥接服务: {}", self.bridge_url);
        Ok(())
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        {
            let mut ws = self.ws_stream.lock().await;
            if let Some(mut stream) = ws.take() {
                let _ = stream.close(None).await;
            }
        }
        {
            let mut client = self.client.lock().await;
            client.state = WsConnectionState::Disconnected;
            client.pending_requests.clear();
        }
        log::info!("WebSocket 已断开连接");
    }

    /// 发送消息并等待响应
    /// 分两阶段：持锁发送 → 释放锁 → 无锁等待 oneshot
    pub async fn send_request(&self, request: BridgeRequest) -> Result<BridgeResponse, String> {
        // 阶段一：锁 client 设 pending，锁 ws_stream 发消息 → 释放两把锁
        let rx = {
            let mut client = self.client.lock().await;
            if client.state != WsConnectionState::Connected {
                return Err("未连接到桥接服务".to_string());
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            client.pending_requests.insert(request.id.clone(), tx);
            drop(client); // 释放 client 锁

            let mut ws = self.ws_stream.lock().await;
            let stream = ws.as_mut().ok_or_else(|| "WebSocket 流不可用".to_string())?;
            let json = serde_json::to_string(&request)
                .map_err(|e| format!("序列化请求失败: {}", e))?;
            stream.send(Message::Text(json.into()))
                .await
                .map_err(|e| format!("发送消息失败: {}", e))?;
            drop(ws); // 释放 ws_stream 锁

            rx // 将 receiver 移出锁作用域
        }; // ★ 两把锁均已释放 ★

        // 阶段二：无锁等待响应
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            rx,
        )
        .await
        .map_err(|_| "等待响应超时（120秒）".to_string())?
        .map_err(|_| "响应通道已关闭".to_string())?;

        Ok(response)
    }

    /// 发送消息但不等待响应（用于流式请求）
    pub async fn send_no_wait(&self, request: BridgeRequest) -> Result<(), String> {
        let mut ws = self.ws_stream.lock().await;
        let stream = ws.as_mut().ok_or_else(|| "未连接到桥接服务".to_string())?;
        let json = serde_json::to_string(&request)
            .map_err(|e| format!("序列化请求失败: {}", e))?;
        stream.send(Message::Text(json.into()))
            .await
            .map_err(|e| format!("发送消息失败: {}", e))?;
        Ok(())
    }

    /// 从 WebSocket 流读取一条消息（仅事件循环调用）
    pub async fn read_message(&self) -> Option<Result<BridgeResponse, String>> {
        let mut ws = self.ws_stream.lock().await;
        let stream = ws.as_mut()?;
        let msg = stream.next().await?;
        match msg {
            Ok(Message::Text(text)) => {
                match serde_json::from_str::<BridgeResponse>(&text) {
                    Ok(response) => Some(Ok(response)),
                    Err(e) => Some(Err(format!("解析响应失败: {}", e))),
                }
            }
            Ok(Message::Close(_)) => {
                let mut client = self.client.lock().await;
                client.state = WsConnectionState::Disconnected;
                Some(Err("连接已关闭".to_string()))
            }
            Ok(Message::Ping(data)) => {
                let _ = stream.send(Message::Pong(data)).await;
                None // Ping 不需要对外响应
            }
            Err(e) => {
                let mut client = self.client.lock().await;
                client.state = WsConnectionState::Error(e.to_string());
                Some(Err(format!("WebSocket 错误: {}", e)))
            }
            _ => None,
        }
    }

    /// 处理收到的响应（路由到 pending 请求）
    pub async fn handle_incoming(&self, response: BridgeResponse) {
        let mut client = self.client.lock().await;
        if let Some(sender) = client.pending_requests.remove(&response.id) {
            let _ = sender.send(response);
        } else {
            log::warn!("收到未知请求 ID 的响应: {}", response.id);
        }
    }
}
