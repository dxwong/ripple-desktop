use std::sync::Arc;
use tokio::sync::{Mutex, mpsc, oneshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
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

// ==================== 事件循环命令 ====================

/// 发送给事件循环的命令
pub enum EventLoopCommand {
    /// 发送请求并等待响应
    SendAndWait {
        request: BridgeRequest,
        /// 发送成功后将此 sender 存入 pending_requests，响应到来时通过它传回
        sender: oneshot::Sender<Result<BridgeResponse, String>>,
    },
    /// 发送请求不等待响应
    SendNoWait {
        request: BridgeRequest,
    },
}

// ==================== WebSocket 客户端状态 ====================

/// 客户端状态（不含 stream，stream 由事件循环独占）
pub struct WebSocketClient {
    pub state: WsConnectionState,
    pub(crate) pending_requests: HashMap<String, oneshot::Sender<Result<BridgeResponse, String>>>,
}

impl WebSocketClient {
    pub fn new() -> Self {
        Self {
            state: WsConnectionState::Disconnected,
            pending_requests: HashMap::new(),
        }
    }
}

// ==================== 共享客户端 ====================

/// 共享客户端（线程安全）
///
/// 事件循环独占 WebSocket 流，通过 command_tx channel 接收发送请求。
/// 事件循环用 select! 同时处理：收 WebSocket 消息 + 收发送命令。
///
/// 关键优势：发送方不需要碰 WebSocket 流锁，事件循环持流期间不阻塞任何操作。
#[derive(Clone)]
pub struct SharedWsClient {
    pub command_tx: Arc<Mutex<mpsc::UnboundedSender<EventLoopCommand>>>,
    pub client: Arc<Mutex<WebSocketClient>>,
    bridge_url: String,
}

impl SharedWsClient {
    pub fn new(bridge_url: &str) -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        Self {
            command_tx: Arc::new(Mutex::new(tx)),
            client: Arc::new(Mutex::new(WebSocketClient::new())),
            bridge_url: bridge_url.to_string(),
        }
    }

    /// 连接桥接服务，返回 (WebSocket流, 命令接收端)
    /// 调用方负责将 stream 和 rx 传给事件循环
    pub async fn connect(
        &self,
    ) -> Result<
        (
            WebSocketStream<MaybeTlsStream<TcpStream>>,
            mpsc::UnboundedReceiver<EventLoopCommand>,
        ),
        String,
    > {
        {
            let mut client = self.client.lock().await;
            if client.state == WsConnectionState::Connected {
                return Err("已经连接".to_string());
            }
            client.state = WsConnectionState::Connecting;
        }

        let (stream, _) = tokio_tungstenite::connect_async(&self.bridge_url)
            .await
            .map_err(|e| format!("连接桥接服务失败: {}", e))?;

        // 创建新通道（旧通道已废弃）
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut cmd_tx = self.command_tx.lock().await;
            *cmd_tx = tx;
        }

        {
            let mut client = self.client.lock().await;
            client.state = WsConnectionState::Connected;
        }

        log::info!("WebSocket 已连接到桥接服务: {}", self.bridge_url);
        Ok((stream, rx))
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        {
            let mut client = self.client.lock().await;
            client.state = WsConnectionState::Disconnected;
            client.pending_requests.clear();
        }
        // 清空 command_tx 使其失效
        let (tx, _rx) = mpsc::unbounded_channel();
        {
            let mut cmd_tx = self.command_tx.lock().await;
            *cmd_tx = tx;
        }
        log::info!("WebSocket 已断开连接");
    }

    /// 发送消息并等待响应（通过 channel 传给事件循环）
    pub async fn send_request(&self, request: BridgeRequest) -> Result<BridgeResponse, String> {
        let (tx, rx) = oneshot::channel();

        {
            let cmd_tx = self.command_tx.lock().await;
            cmd_tx
                .send(EventLoopCommand::SendAndWait {
                    request,
                    sender: tx,
                })
                .map_err(|_| "事件循环已停止".to_string())?;
        }

        // 无锁等待响应
        let result = tokio::time::timeout(std::time::Duration::from_secs(120), rx)
            .await
            .map_err(|_| "等待响应超时（120秒）".to_string())?
            .map_err(|_| "响应通道已关闭".to_string())?;

        result
    }

    /// 发送消息不等待响应（通过 channel 传给事件循环）
    pub async fn send_no_wait(&self, request: BridgeRequest) -> Result<(), String> {
        let cmd_tx = self.command_tx.lock().await;
        cmd_tx
            .send(EventLoopCommand::SendNoWait { request })
            .map_err(|_| "事件循环已停止".to_string())
    }
}
