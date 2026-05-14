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

    /// WebSocket 客户端
pub struct WebSocketClient {
    /// WebSocket 流（连接后才有值）
    pub(crate) stream: Option<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    /// 连接状态
    pub state: WsConnectionState,
    /// 桥接服务地址
    bridge_url: String,
    /// 挂起的请求映射（lib.rs 中需要访问）
    pub(crate) pending_requests: HashMap<String, tokio::sync::oneshot::Sender<BridgeResponse>>,
}

impl WebSocketClient {
    pub fn new(bridge_url: &str) -> Self {
        Self {
            stream: None,
            state: WsConnectionState::Disconnected,
            bridge_url: bridge_url.to_string(),
            pending_requests: HashMap::new(),
        }
    }

    /// 连接到 Python 桥接服务
    pub async fn connect(&mut self) -> Result<(), String> {
        if self.state == WsConnectionState::Connected {
            return Ok(());
        }

        self.state = WsConnectionState::Connecting;

        let (stream, _) = tokio_tungstenite::connect_async(&self.bridge_url)
            .await
            .map_err(|e| format!("连接桥接服务失败: {}", e))?;

        self.stream = Some(stream);
        self.state = WsConnectionState::Connected;
        log::info!("WebSocket 已连接到桥接服务: {}", self.bridge_url);
        Ok(())
    }

    /// 断开连接
    pub async fn disconnect(&mut self) {
        if let Some(mut stream) = self.stream.take() {
            let _ = stream.close(None).await;
        }
        self.state = WsConnectionState::Disconnected;
        self.pending_requests.clear();
        log::info!("WebSocket 已断开连接");
    }

    /// 发送消息并等待响应
    /// 注意：此方法持有锁等待，不适用于需要保持锁可用性的场景。
    /// 建议改用 `send_to_bridge` 的分阶段模式。
    #[allow(dead_code)]
    pub async fn send_request(&mut self, request: BridgeRequest) -> Result<BridgeResponse, String> {
        let stream = self.stream.as_mut()
            .ok_or_else(|| "未连接到桥接服务".to_string())?;

        // 创建 oneshot channel 用于等待响应
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_requests.insert(request.id.clone(), tx);

        // 序列化并发送请求
        let json = serde_json::to_string(&request)
            .map_err(|e| format!("序列化请求失败: {}", e))?;
        
        stream.send(Message::Text(json.into()))
            .await
            .map_err(|e| format!("发送消息失败: {}", e))?;

        // 等待响应（带超时）
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            rx,
        )
        .await
        .map_err(|_| "等待响应超时（120秒）".to_string())?
        .map_err(|_| "响应通道已关闭".to_string())?;

        self.pending_requests.remove(&request.id);
        Ok(response)
    }

    /// 发送消息但不等待响应（用于流式输出）
    pub async fn send_no_wait(&mut self, request: BridgeRequest) -> Result<(), String> {
        let stream = self.stream.as_mut()
            .ok_or_else(|| "未连接到桥接服务".to_string())?;

        // 序列化并发送请求
        let json = serde_json::to_string(&request)
            .map_err(|e| format!("序列化请求失败: {}", e))?;
        
        stream.send(Message::Text(json.into()))
            .await
            .map_err(|e| format!("发送消息失败: {}", e))?;
        
        log::info!("已发送消息（不等待响应）: {}", request.msg_type);
        Ok(())
    }

    /// 处理从桥接服务收到的消息（由事件循环调用）
    pub async fn handle_incoming(&mut self, response: BridgeResponse) {
        if let Some(sender) = self.pending_requests.remove(&response.id) {
            let _ = sender.send(response);
        } else {
            log::warn!("收到未知请求 ID 的响应: {}", response.id);
        }
    }

    /// 读取 WebSocket 流的下一条消息（用于事件循环）
    pub async fn read_message(&mut self) -> Option<Result<BridgeResponse, String>> {
        let stream = self.stream.as_mut()?;
        let msg = stream.next().await?;
        
        match msg {
            Ok(Message::Text(text)) => {
                match serde_json::from_str::<BridgeResponse>(&text) {
                    Ok(response) => Some(Ok(response)),
                    Err(e) => Some(Err(format!("解析响应失败: {}", e))),
                }
            }
            Ok(Message::Close(_)) => {
                self.state = WsConnectionState::Disconnected;
                Some(Err("连接已关闭".to_string()))
            }
            Ok(Message::Ping(data)) => {
                let _ = stream.send(Message::Pong(data)).await;
                None // Ping 不需要响应
            }
            Err(e) => {
                self.state = WsConnectionState::Error(e.to_string());
                Some(Err(format!("WebSocket 错误: {}", e)))
            }
            _ => None,
        }
    }
}

/// 线程安全的 WebSocket 客户端包装器
pub type SharedWsClient = Arc<Mutex<WebSocketClient>>;

/// 创建共享的 WebSocket 客户端
pub fn create_shared_client(bridge_url: &str) -> SharedWsClient {
    Arc::new(Mutex::new(WebSocketClient::new(bridge_url)))
}
