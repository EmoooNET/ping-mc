import { MCServerConnect } from '../dist/index.js';

const host = process.argv[2] ?? 'localhost';
const port = process.argv[3] ?? 25565;

try {
  const server = new MCServerConnect(host, port);
  const status = await server.getStatusWithPing();
  console.log('版本:', status.version.name, `(协议 ${status.version.protocol})`);
  console.log('玩家:', `${status.players.online}/${status.players.max}`);
  console.log('MOTD:', status.motd);
  console.log('延迟:', `${status.latency.toFixed(2)} ms`);
  console.log('图标:', status.icon ? `Base64 (${status.icon.length} 字符)` : '无');
} catch (error) {
  console.error('查询失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
