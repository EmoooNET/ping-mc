// 从包名导入，验证 exports/types 指向的发布声明，而不是直接引用源码。
import { MCServerConnect, MCServerError, parseMOTD, pingServer, queryStatus, queryStatusWithPing } from 'ping-mc';
import type {
  MCChatComponent,
  MCChatComponentObject,
  MCServerErrorCode,
  MCServerOptions,
  MCServerPlayer,
  MCServerPlayers,
  MCServerStatus,
  MCServerStatusWithPing,
  MCServerVersion,
} from 'ping-mc';

const options: MCServerOptions = { timeout: 1000, protocolVersion: -1 };
const server = new MCServerConnect('localhost', '25565', options);
// 传入 undefined 可在自动 SRV 解析时继续配置超时与协议版本。
const srvServer = new MCServerConnect('play.example.com', undefined, options);
const srvStatus: Promise<MCServerStatus> = queryStatus('play.example.com', undefined, options);
const srvPingStatus: Promise<MCServerStatusWithPing> = queryStatusWithPing('play.example.com', undefined, options);
const srvLatency: Promise<number> = pingServer('play.example.com', undefined, options);
const status: Promise<MCServerStatus> = server.getStatus();
const pingStatus: Promise<MCServerStatusWithPing> = server.getStatusWithPing();
const version: Promise<MCServerVersion> = server.getVersion();
const online: Promise<number> = server.getOnlinePlayerCount();
const max: Promise<number> = server.getMaxPlayerCount();
const motd: Promise<string> = server.getMOTD();
const icon: Promise<string | undefined> = server.getIcon();
const latency: Promise<number> = server.ping();

const functionalStatus: Promise<MCServerStatus> = queryStatus('localhost');
const functionalPingStatus: Promise<MCServerStatusWithPing> = queryStatusWithPing('localhost', 25565, options);
const functionalLatency: Promise<number> = pingServer('localhost', '25565');
const component: MCChatComponentObject = { text: 'Hello', extra: [' world'] };
const description: MCChatComponent = [component, '\n', { translate: 'example', fallback: '%s', with: ['MOTD'] }];
const text: string = parseMOTD(description);
const players: MCServerPlayers = { online: 1, max: 20 };
const player: MCServerPlayer = { name: 'Alex', id: 'uuid' };
players.sample = [player];
const code: MCServerErrorCode = new MCServerError('TIMEOUT', 'Timed out').code;

// @ts-expect-error 端口不能是布尔值。
new MCServerConnect('localhost', true);
// @ts-expect-error 请求超时使用数值毫秒。
queryStatus('localhost', 25565, { timeout: '1000' });
// @ts-expect-error 属性只读，修改地址应新建实例。
server.host = 'example.com';
// @ts-expect-error 图标可能不存在，调用方必须处理 undefined。
const requiredIcon: Promise<string> = server.getIcon();

void [status, pingStatus, version, online, max, motd, icon, latency,
  functionalStatus, functionalPingStatus, functionalLatency, srvServer, srvStatus, srvPingStatus, srvLatency,
  text, players, code, requiredIcon];
