/**
 * Sync Client - WebSocket transport for the v3 record protocol.
 *
 * Handles connection, authentication, reconnection, and message routing.
 * All sync semantics (diffing, applying, baselines) live chrome-side in the
 * zenInternals experiment; this class only moves records.
 */

class SyncClient {
  constructor({
    onAuthState,
    onRecordsUpdate,
    onRecordsAccepted,
    onPutRejected,
    onStateRecords,
    onReplaceAccepted,
    onReplaceConflict,
    onDeviceEvent,
    onStatusChange,
    onForceDisable,
  }) {
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

    this.onAuthState = onAuthState;
    this.onRecordsUpdate = onRecordsUpdate;
    this.onRecordsAccepted = onRecordsAccepted;
    this.onPutRejected = onPutRejected;
    this.onStateRecords = onStateRecords;
    this.onReplaceAccepted = onReplaceAccepted;
    this.onReplaceConflict = onReplaceConflict;
    this.onDeviceEvent = onDeviceEvent;
    this.onStatusChange = onStatusChange;
    this.onForceDisable = onForceDisable;
  }

  async connect(serverUrl, token, deviceName) {
    this.serverUrl = serverUrl;
    this.token = token;
    this.deviceName = deviceName || `Zen-${Date.now().toString(36)}`;
    this.reconnectAttempts = 0;

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

    this.ws.onerror = () => {
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
        this.onAuthState?.({
          schemaVersion: msg.schemaVersion,
          generation: msg.generation,
          version: msg.version,
          records: msg.records || [],
          connectedDevices: msg.connectedDevices || [],
        });
        break;

      case 'records_update':
        if (msg.sourceDevice !== this.deviceId) {
          this.onRecordsUpdate?.(msg.records || [], msg.deleted || [], msg.sourceDevice, msg.version);
        }
        break;

      case 'records_accepted':
        this.onRecordsAccepted?.(msg.ids || [], msg.rejected || [], msg.version, msg.reqId);
        break;

      case 'put_rejected':
        this.onPutRejected?.(msg.reqId, { reason: msg.reason, wouldDelete: msg.wouldDelete, current: msg.current });
        break;

      case 'state_records':
        if (msg.sourceDevice && msg.sourceDevice === this.deviceId) {
          break;
        }
        this.onStateRecords?.({
          generation: msg.generation,
          version: msg.version,
          records: msg.records || [],
          sourceDevice: msg.sourceDevice,
        });
        break;

      case 'replace_accepted':
        this.onReplaceAccepted?.(msg.ids || [], msg.generation, msg.version);
        break;

      case 'replace_conflict':
        this.onReplaceConflict?.(msg.version, msg.counts || {});
        break;

      case 'device_connected':
      case 'device_disconnected':
        this.onDeviceEvent?.(msg);
        break;

      case 'pong':
        break;

      case 'force_disable':
        this.onForceDisable?.(msg.reason);
        break;

      case 'admin_ok':
        break;

      case 'error':
        console.error('[SyncClient] Server error:', msg.message);
        if (msg.message === 'Invalid token') {
          this.onStatusChange?.('auth_failed');
        }
        break;
    }
  }

  putRecords(records, deleted, { reqId, force } = {}) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify({
      type: 'put_records',
      records,
      deleted,
      reqId,
      force: !!force,
      deviceId: this.deviceId,
    }));
    return true;
  }

  requestState() {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'request_state' }));
  }

  replaceState(records, baseVersion) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify({
      type: 'replace_state',
      records,
      baseVersion,
      deviceId: this.deviceId,
    }));
    return true;
  }

  sendAdminResetState() {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'admin_reset_state', deviceId: this.deviceId }));
  }

  sendAdminDisableAll() {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'admin_disable_all', deviceId: this.deviceId }));
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
