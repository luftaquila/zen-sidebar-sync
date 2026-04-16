/**
 * Sync Client - WebSocket client for real-time sync with server
 *
 * Handles connection, authentication, reconnection, and message routing.
 */

class SyncClient {
  constructor({ onStateUpdate, onPatch, onDeviceEvent, onStatusChange }) {
    this.ws = null;
    this.serverUrl = null;
    this.token = null;
    this.deviceId = null;
    this.deviceName = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.connected = false;

    this.onStateUpdate = onStateUpdate;
    this.onPatch = onPatch;
    this.onDeviceEvent = onDeviceEvent;
    this.onStatusChange = onStatusChange;
  }

  async connect(serverUrl, token, deviceName) {
    this.serverUrl = serverUrl;
    this.token = token;
    this.deviceName = deviceName || `Zen-${Date.now().toString(36)}`;
    this.reconnectAttempts = 0; // [L3] Reset on manual connect

    // Load or generate device ID
    const stored = await browser.storage.local.get('deviceId');
    this.deviceId = stored.deviceId || `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await browser.storage.local.set({ deviceId: this.deviceId });

    this._connect();
  }

  _connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.onStatusChange?.('connecting');

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (err) {
      console.error('[SyncClient] Connection error:', err);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[SyncClient] Connected, authenticating...');
      this.ws.send(JSON.stringify({
        type: 'auth',
        token: this.token,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
      }));
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this._handleMessage(msg);
    };

    this.ws.onclose = (event) => {
      console.log(`[SyncClient] Disconnected: ${event.code} ${event.reason}`);
      this.connected = false;
      this._clearPing();
      this.onStatusChange?.('disconnected');

      if (event.code !== 4001 && event.code !== 1000) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('[SyncClient] WebSocket error');
      this.onStatusChange?.('error');
    };
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        this.connected = true;
        this.reconnectAttempts = 0;
        this.deviceId = msg.deviceId;
        this.onStatusChange?.('connected');
        this._startPing();
        // Process initial state from server
        if (msg.state) {
          this.onStateUpdate?.(msg.state, 'server');
        }
        break;

      case 'state_update':
        this.onStateUpdate?.(msg.state, msg.sourceDevice);
        break;

      case 'patch':
        this.onPatch?.(msg.patch, msg.sourceDevice, msg.version);
        break;

      case 'state_accepted':
      case 'patch_accepted':
        // Server acknowledged our update
        break;

      case 'device_connected':
      case 'device_disconnected':
        this.onDeviceEvent?.(msg);
        break;

      case 'pong':
        // Latency = Date.now() - msg.timestamp (from our ping)
        break;

      case 'error':
        console.error('[SyncClient] Server error:', msg.message);
        if (msg.message === 'Invalid token') {
          this.onStatusChange?.('auth_failed');
        }
        break;
    }
  }

  sendFullState(state, { replace = false } = {}) {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({
      type: 'full_state',
      state,
      replace,
      deviceId: this.deviceId,
    }));
  }

  sendPatch(patch) {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({
      type: 'patch',
      patch,
      deviceId: this.deviceId,
    }));
  }

  requestState() {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'request_state' }));
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this._clearPing();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connected = false;
    this.onStatusChange?.('disconnected');
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[SyncClient] Max reconnect attempts reached');
      this.onStatusChange?.('failed');
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[SyncClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.onStatusChange?.('reconnecting');

    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _startPing() {
    this._clearPing();
    this.pingInterval = setInterval(() => {
      if (this.connected) {
        this.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }, 30000);
  }

  _clearPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  get isConnected() {
    return this.connected;
  }
}

export default SyncClient;
