import { normalizeOptions } from './options.js';
import type { ConnectionOptions } from './options.js';
import { requestStatus } from './transport.js';
import type { MCServerOptions, MCServerStatus, MCServerStatusWithPing, MCServerVersion } from './types.js';

/** 保存服务器地址与配置；构造时不联网，每个方法独立发起一次实时请求。 */
export class MCServerConnect {
  readonly #options: ConnectionOptions;

  /** 省略端口时自动查询 SRV；显式端口（包括 25565）始终直接连接。 */
  constructor(host: string, port?: number | string, options: MCServerOptions = {}) {
    this.#options = normalizeOptions(host, port, options);
  }

  get host(): string {
    return this.#options.host;
  }

  get port(): number {
    return this.#options.port;
  }

  /** 获取一次完整状态。多个字段请优先使用此方法，避免重复连接。 */
  getStatus(): Promise<MCServerStatus> {
    return requestStatus(this.#options, false);
  }

  /** 在同一连接上获取状态，随后发送 0x01 Ping 并等待匹配的 Pong。 */
  getStatusWithPing(): Promise<MCServerStatusWithPing> {
    return requestStatus(this.#options, true);
  }

  async getVersion(): Promise<MCServerVersion> {
    return (await this.getStatus()).version;
  }

  async getOnlinePlayerCount(): Promise<number> {
    return (await this.getStatus()).players.online;
  }

  async getMaxPlayerCount(): Promise<number> {
    return (await this.getStatus()).players.max;
  }

  async getMOTD(): Promise<string> {
    return (await this.getStatus()).motd;
  }

  /** 返回纯 Base64；服务器未提供图标时返回 undefined。 */
  async getIcon(): Promise<string | undefined> {
    return (await this.getStatus()).icon;
  }

  /** 返回 0x01 Ping/Pong 往返时间，单位毫秒，可含小数。 */
  async ping(): Promise<number> {
    return (await this.getStatusWithPing()).latency;
  }
}

/** 无需持有实例，直接获取最新状态。 */
export async function queryStatus(
  host: string,
  port?: number | string,
  options: MCServerOptions = {},
): Promise<MCServerStatus> {
  return new MCServerConnect(host, port, options).getStatus();
}

/** 一次连接获取最新状态及 Ping 延迟。 */
export async function queryStatusWithPing(
  host: string,
  port?: number | string,
  options: MCServerOptions = {},
): Promise<MCServerStatusWithPing> {
  return new MCServerConnect(host, port, options).getStatusWithPing();
}

/** 通过 0x01 Ping/Pong 测量往返时间（毫秒）。 */
export async function pingServer(
  host: string,
  port?: number | string,
  options: MCServerOptions = {},
): Promise<number> {
  return new MCServerConnect(host, port, options).ping();
}
