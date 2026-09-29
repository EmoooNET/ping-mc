/** 每次请求的连接配置。 */
export interface MCServerOptions {
  /** 整次查询的超时时间（毫秒），包含 DNS、连接、状态和 Ping。默认 5000。 */
  timeout?: number;
  /** 握手中的协议版本，默认 -1，表示探测服务器版本。 */
  protocolVersion?: number;
}

export interface MCServerVersion {
  name: string;
  protocol: number;
}

export interface MCServerPlayer {
  name: string;
  id: string;
}

export interface MCServerPlayers {
  online: number;
  max: number;
  /** 服务器提供的玩家样本，不保证包含全部在线玩家。 */
  sample?: MCServerPlayer[];
}

export interface MCServerStatus {
  version: MCServerVersion;
  players: MCServerPlayers;
  /** 已展开聊天组件并移除颜色代码的正文，保留换行。 */
  motd: string;
  /** PNG 的纯 Base64 字符串，不含 data URI 前缀；未提供图标时省略。 */
  icon?: string;
}

export interface MCServerStatusWithPing extends MCServerStatus {
  /** 0x01 Ping/Pong 往返时间（毫秒，可含小数），不包含握手和状态查询。 */
  latency: number;
}
