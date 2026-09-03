// Minimal Marionette client (protocol 3), no dependencies.
// Enough for the e2e harness: chrome-context script execution and
// temporary add-on installation.
import net from 'net';

export class Marionette {
  #socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();

  static async connect(port, { timeoutMs = 120000, host = '127.0.0.1' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await Marionette.#connectOnce(port, host);
      } catch (e) {
        if (Date.now() > deadline) {
          throw new Error(`marionette :${port} not reachable: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  static #connectOnce(port, host) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host });
      const client = new Marionette();
      client.#socket = socket;
      let handshaken = false;
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        client.#buffer = Buffer.concat([client.#buffer, chunk]);
        for (;;) {
          const msg = client.#tryRead();
          if (msg === null) break;
          if (!handshaken) {
            // First message is the {applicationType, marionetteProtocol} hello.
            handshaken = true;
            socket.removeListener('error', reject);
            socket.on('error', () => client.#failAll(new Error('socket error')));
            resolve(client);
            continue;
          }
          client.#dispatch(msg);
        }
      });
      socket.on('close', () => client.#failAll(new Error('marionette socket closed')));
      setTimeout(() => reject(new Error('handshake timeout')), 5000);
    });
  }

  #tryRead() {
    const colon = this.#buffer.indexOf(0x3a); // ':'
    if (colon === -1) return null;
    const len = parseInt(this.#buffer.slice(0, colon).toString(), 10);
    if (!Number.isFinite(len)) throw new Error('bad marionette frame');
    if (this.#buffer.length < colon + 1 + len) return null;
    const body = this.#buffer.slice(colon + 1, colon + 1 + len).toString('utf-8');
    this.#buffer = this.#buffer.slice(colon + 1 + len);
    return JSON.parse(body);
  }

  #dispatch(msg) {
    // Response: [1, messageId, error, result]
    if (!Array.isArray(msg) || msg[0] !== 1) return;
    const waiter = this.#pending.get(msg[1]);
    if (!waiter) return;
    this.#pending.delete(msg[1]);
    if (msg[2]) {
      waiter.reject(new Error(`${msg[2].error}: ${msg[2].message}`));
    } else {
      waiter.resolve(msg[3]);
    }
  }

  #failAll(err) {
    for (const [, waiter] of this.#pending) waiter.reject(err);
    this.#pending.clear();
  }

  send(name, params = {}) {
    const id = this.#nextId++;
    const frame = JSON.stringify([0, id, name, params]);
    this.#socket.write(`${Buffer.byteLength(frame)}:${frame}`);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  async newSession(capabilities = {}) {
    const result = await this.send('WebDriver:NewSession', capabilities);
    await this.send('WebDriver:SetTimeouts', { script: 60000 });
    return result;
  }

  async alertText() {
    try {
      const result = await this.send('WebDriver:GetAlertText', {});
      return result?.value ?? null;
    } catch (e) {
      return null;
    }
  }

  async dismissAlert() {
    try {
      await this.send('WebDriver:DismissAlert', {});
      return true;
    } catch (e) {
      return false;
    }
  }

  async acceptAlert() {
    try {
      await this.send('WebDriver:AcceptAlert', {});
      return true;
    } catch (e) {
      return false;
    }
  }

  setContext(value) {
    return this.send('Marionette:SetContext', { value });
  }

  // Chrome-context script. `window` is the current chrome window; destructure
  // gBrowser & friends from it inside the script.
  async executeScript(script, args = []) {
    const result = await this.send('WebDriver:ExecuteScript', { script, args });
    return result?.value;
  }

  async executeAsyncScript(script, args = []) {
    const result = await this.send('WebDriver:ExecuteAsyncScript', { script, args });
    return result?.value;
  }

  installAddon(path, temporary = true) {
    return this.send('Addon:Install', { path, temporary });
  }

  close() {
    try { this.#socket.destroy(); } catch {}
  }
}
