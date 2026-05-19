/**
 * 健康检测 SSE 客户端
 * 替代轮询 health check，通过 SSE 实时感知后端状态
 */

import { BASE_URL } from "./api";

type HealthCallback = (connected: boolean) => void;

class HealthSSEClient {
  private eventSource: EventSource | null = null;
  private callback: HealthCallback | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private readonly BASE_RECONNECT_DELAY = 1000;
  private readonly MAX_RECONNECT_DELAY = 30000;

  private getReconnectDelay(): number {
    const delay = Math.min(
      this.BASE_RECONNECT_DELAY * Math.pow(2, this.retryCount),
      this.MAX_RECONNECT_DELAY,
    );
    this.retryCount++;
    return delay;
  }

  private resetRetry(): void {
    this.retryCount = 0;
  }

  connect(callback: HealthCallback): void {
    this.callback = callback;
    this.doConnect();
  }

  private doConnect(): void {
    this.close();

    try {
      const es = new EventSource(`${BASE_URL}/api/health/stream`);
      this.eventSource = es;

      es.onopen = () => {
        this.resetRetry();
        this.callback?.(true);
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'connected' || data.type === 'heartbeat') {
            this.resetRetry();
            this.callback?.(true);
          }
        } catch {
          // 解析失败忽略
        }
      };

      es.onerror = () => {
        this.callback?.(false);
        es.close();
        this.eventSource = null;
        const delay = this.getReconnectDelay();
        this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
      };
    } catch {
      this.callback?.(false);
      const delay = this.getReconnectDelay();
      this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
    }
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.retryCount = 0;
  }
}

export const healthSSEClient = new HealthSSEClient();