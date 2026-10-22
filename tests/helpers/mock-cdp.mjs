// 本地模拟 CDP 服务：仅监听 127.0.0.1，用于故障注入测试。
// 提供 /json/version、/json/list HTTP 端点与最小 WebSocket 帧收发。
import http from "node:http";
import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class MockCdpServer {
  /**
   * @param {object} [opts]
   * @param {Array<object>} [opts.targets]  /json/list 返回的目标列表
   * @param {object} [opts.version]         /json/version 返回内容
   * @param {boolean} [opts.rejectUpgrade]  升级请求直接回 400（握手失败注入）
   * @param {string} [opts.badAccept]       握手返回错误的 Sec-WebSocket-Accept
   */
  constructor(opts = {}) {
    this.targets = opts.targets ?? [];
    this.version = opts.version ?? { Browser: "Mock/1.0", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/x" };
    this.rejectUpgrade = opts.rejectUpgrade ?? false;
    this.badAccept = opts.badAccept ?? false;
    // 可注入的命令处理器：(msg) => result | { error } ；抛异常/挂起均可注入
    this.onCommand = () => ({ ok: true });
    // 可注入的主动行为：conn => {...}，测试里用来主动关连接/发垃圾帧
    this.onConnection = () => {};
    this.connections = new Set();
    this.received = [];

    this.server = http.createServer((req, res) => {
      const send = (code, body) => {
        const s = JSON.stringify(body);
        res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
        res.end(s);
      };
      if (req.url === "/json/version") return send(200, this.version);
      if (req.url === "/json/list") return send(200, this.targets);
      send(404, { error: "not found" });
    });
    this.server.on("upgrade", (req, socket) => {
      if (this.rejectUpgrade) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      const key = req.headers["sec-websocket-key"];
      const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${this.badAccept ? "definitely-wrong" : accept}\r\n\r\n`);
      this._attachSocket(socket, req.url);
    });
  }

  listen(port = 0) {
    return new Promise((resolve) => {
      this.server.listen(port, "127.0.0.1", () => resolve(this.server.address().port));
    });
  }
  close() {
    for (const c of this.connections) c.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  _attachSocket(socket, reqUrl) {
    // /devtools/page/<id> → conn.pageId，供测试校验"连到的就是选中的目标"
    const pageId = /\/devtools\/page\/([^/?]+)/.exec(reqUrl || "")?.[1] ?? null;
    const conn = {
      socket, pageId,
      sendObj: (obj) => this._sendFrame(socket, Buffer.from(JSON.stringify(obj))),
      sendTextFrame: (payload, { fin = true, opcode = 0x1 } = {}) => this._sendRawFrame(socket, payload, fin, opcode),
      sendBytes: (buf) => socket.write(buf),
      destroy: () => socket.destroy(),
    };
    this.connections.add(conn);
    socket.on("close", () => this.connections.delete(conn));
    socket.on("data", (chunk) => this._pump(socket, chunk, conn));
    this.onConnection(conn);
  }

  // 解析客户端（带掩码）帧；只取完整文本消息，回调 onCommand(msg, conn)
  _buf = Buffer.alloc(0);
  _pump(socket, chunk, conn) {
    this._buf = Buffer.concat([this._buf, chunk]);
    for (;;) {
      if (this._buf.length < 2) return;
      const b1 = this._buf[1];
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this._buf.length < 4) return; len = this._buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this._buf.length < 10) return; len = Number(this._buf.readBigUInt64BE(2)); off = 10; }
      if (this._buf.length < off + (masked ? 4 : 0) + len) return;
      const op = this._buf[0] & 0x0f; // 先取本帧 opcode，再推进缓冲
      let payload = Buffer.from(this._buf.slice(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len));
      const mask = masked ? this._buf.slice(off, off + 4) : null;
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this._buf = this._buf.slice(off + (masked ? 4 : 0) + len);
      if (op === 8) { socket.end(); return; }
      if (op === 9) { this._sendRawFrame(socket, payload, true, 0xA); continue; }
      try {
        const msg = JSON.parse(payload.toString());
        this.received.push(msg);
        Promise.resolve(this.onCommand(msg, conn)).then((r) => {
          if (!msg.id) return; // 事件推送（无 id）不回包
          if (r && r.__error) connReply(this, msg.id, undefined, r.__error);
          else connReply(this, msg.id, r ?? {});
        }).catch(() => {});
      } catch { /* 非 JSON 帧忽略 */ }
    }
  }

  _sendFrame(socket, payload) { this._sendRawFrame(socket, payload, true, 0x1); }
  _sendRawFrame(socket, payload, fin, opcode) {
    const head = [ (fin ? 0x80 : 0x00) | opcode ];
    if (payload.length < 126) head.push(payload.length);
    else if (payload.length < 65536) { head.push(126); head.push(payload.length >> 8, payload.length & 0xff); }
    else {
      head.push(127);
      const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length));
      head.push(...b);
    }
    socket.write(Buffer.concat([Buffer.from(head), payload]));
  }
  // 向活动连接按 id 回包
  reply(id, result, error) {
    const c = [...this.connections][0];
    if (c) c.sendObj(error ? { id, error } : { id, result });
  }
  // 向活动连接推送事件
  emit(method, params) {
    const c = [...this.connections][0];
    if (c) c.sendObj({ method, params });
  }
}
function connReply(server, id, result, error) {
  const c = [...server.connections][0];
  if (c) c.sendObj(error ? { id, error: { message: error } } : { id, result });
}
