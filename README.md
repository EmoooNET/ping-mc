# PingMC

用于查询 Minecraft Java Edition 服务器的 Node.js 库。源码使用 TypeScript，发布为 ESM，附带自动生成的 `.d.ts`、声明映射及源码映射，无运行时依赖。

支持 Java Edition 1.7+ 的 TCP Server List Ping；不包含 Bedrock、旧版 Legacy Ping 或 DNS SRV 自动发现。`host` 传入主机名或 IP，`port` 是实际连接端口。运行环境为 Node.js 22+。

## 构建和本地安装

```sh
pnpm install
pnpm test
pnpm pack
```

`pnpm pack` 会先构建，再生成 `pingmc-1.0.0.tgz`。在需要使用此库的项目中安装这个文件：

```sh
pnpm add /path/to/pingmc-1.0.0.tgz
```

库入口为 `dist/index.js`，类型入口为 `dist/index.d.ts`。导入库不会自动联网或执行示例程序。此项目已配置打包入口，尚未发布到 npm。

## 使用实例

```ts
import { MCServerConnect, MCServerError } from 'pingmc';

const server = new MCServerConnect('localhost', '25565', {
  timeout: 5000,
});

try {
  // 一次连接获取状态，再通过 0x01 Ping/Pong 测量往返延迟。
  const status = await server.getStatusWithPing();

  console.log(status.version.name, status.version.protocol);
  console.log(`${status.players.online}/${status.players.max}`);
  console.log(status.motd);    // 解析后的正文，保留换行
  console.log(status.latency); // 毫秒，可含小数

  if (status.icon) {
    const imageDataURI = `data:image/png;base64,${status.icon}`;
    console.log(imageDataURI);
  }
} catch (error) {
  if (error instanceof MCServerError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

也可以逐项查询。**每次方法调用都会建立独立连接并获取最新数据，不读取缓存，也不自动轮询。** 同时需要多个字段时，使用 `getStatus()` 或 `getStatusWithPing()`，即可避免多次连接，并得到同一份状态快照。构造函数只验证和保存参数，无需手动关闭实例；每次请求结束后会释放连接。

```ts
const version = await server.getVersion();          // { name, protocol }
const online = await server.getOnlinePlayerCount(); // number
const max = await server.getMaxPlayerCount();       // number
const motd = await server.getMOTD();                // string
const icon = await server.getIcon();                // string | undefined
const latency = await server.ping();                // number，毫秒
```

## 函数式 API

不需要持有实例时，可以直接调用导出的函数：

```ts
import { queryStatus, queryStatusWithPing, pingServer, parseMOTD } from 'pingmc';

const status = await queryStatus('localhost', 25565);
const statusWithPing = await queryStatusWithPing('localhost', '25565', { timeout: 3000 });
const milliseconds = await pingServer('localhost', 25565);

// 纯函数，不联网；也可用于解析已有的 MOTD 聊天组件。
const text = parseMOTD({ text: '§a欢迎', extra: [{ text: '\n来到服务器' }] });
// "欢迎\n来到服务器"
```

## API 签名

```ts
new MCServerConnect(host: string, port?: number | string, options?: MCServerOptions)

queryStatus(host: string, port?: number | string, options?: MCServerOptions): Promise<MCServerStatus>
queryStatusWithPing(host: string, port?: number | string, options?: MCServerOptions): Promise<MCServerStatusWithPing>
pingServer(host: string, port?: number | string, options?: MCServerOptions): Promise<number>
parseMOTD(description: MCChatComponent): string
```

`port` 默认 `25565`，接受 `1–65535` 的整数或仅包含十进制数字的字符串（例如 `'25565'`）。`host` 不接受 URL、空字符串或空白字符；IPv6 地址使用不带方括号的形式，例如 `::1`。

| 实例方法 / 属性 | 返回类型 | 用途 |
| --- | --- | --- |
| `host` | `string`（只读） | 服务器主机名或 IP |
| `port` | `number`（只读） | 转换后的端口 |
| `getStatus()` | `Promise<MCServerStatus>` | 获取完整状态，不发送 Ping |
| `getStatusWithPing()` | `Promise<MCServerStatusWithPing>` | 同一连接获取状态和延迟 |
| `getVersion()` | `Promise<MCServerVersion>` | 版本名与协议版本 |
| `getOnlinePlayerCount()` | `Promise<number>` | 当前在线人数 |
| `getMaxPlayerCount()` | `Promise<number>` | 最大玩家人数 |
| `getMOTD()` | `Promise<string>` | MOTD 正文 |
| `getIcon()` | `Promise<string \| undefined>` | PNG Base64，无图标时为 `undefined` |
| `ping()` | `Promise<number>` | 0x01 Ping/Pong 延迟，单位毫秒 |

### 配置与返回值

以下接口均可通过 `import type { ... } from 'pingmc'` 导入。

```ts
interface MCServerOptions {
  timeout?: number;         // 默认 5000；整次查询的超时时间，单位毫秒
  protocolVersion?: number; // 默认 -1；握手使用的有符号 32 位协议版本
}

interface MCServerVersion {
  name: string;
  protocol: number;
}

interface MCServerPlayer {
  name: string;
  id: string;
}

interface MCServerPlayers {
  online: number;
  max: number;
  sample?: MCServerPlayer[];
}

interface MCServerStatus {
  version: MCServerVersion;
  players: MCServerPlayers;
  motd: string;
  icon?: string;
}

interface MCServerStatusWithPing extends MCServerStatus {
  latency: number;
}
```

`sample` 仅表示服务器返回的玩家样本，不保证是完整在线列表。图标不存在时不设置 `icon`；图标存在时移除 `data:image/png;base64,` 前缀。版本、人数和 MOTD 等必需字段缺失，或图标格式不合法时，查询会报告协议错误，而不会编造默认数值。

`timeout` 接受 `1–2147483647` 的整数，覆盖 DNS、TCP 连接、状态获取及可选 Ping 的总耗时。`latency` 使用单调时钟，仅计算发送 `0x01` Ping 到接收到匹配 Pong 的时间，不包含 DNS、握手和状态查询；它不是 ICMP ping。

### MOTD 解析

`parseMOTD()` 支持字符串、数组、嵌套 `text` / `extra`，会移除 `§` 颜色及格式代码并保留换行。翻译组件使用 `fallback`，支持 `%s`、`%1$s`、`%%`。未提供 fallback 时显示翻译键；库不内置 Minecraft 语言资源。记分板、按键、选择器及 NBT 等动态组件只能显示已有值或标识符，不能在服务器之外求值。

解析器最多处理 64 层、10,000 个组件及 1,048,576 个 UTF-16 码元，超过部分截断。单个网络数据包上限为 2 MiB。

### 错误处理

构造函数的参数错误同步抛出 `TypeError` / `RangeError`；独立异步函数的参数错误通过 Promise 拒绝返回。网络与协议错误使用 `MCServerError`：

| `error.code` | 含义 |
| --- | --- |
| `TIMEOUT` | 整次查询超过时限 |
| `CONNECTION_CLOSED` | 完整响应到达前连接关闭 |
| `NETWORK_ERROR` | DNS、连接失败或底层 socket 错误 |
| `PROTOCOL_ERROR` | 无效帧、JSON、状态字段或不匹配的 Pong |

底层错误保留在 `error.cause` 中。`MCServerErrorCode` 也作为类型导出。

## 开发

```sh
pnpm build          # 生成 ESM、.d.ts 及映射文件
pnpm typecheck      # 仅检查源码类型
pnpm test           # 构建、验证公开类型、运行本地 TCP 模拟服务器测试
pnpm start localhost 25565
```

测试使用本地模拟服务器，不依赖公网 Minecraft 服务器。协议参考：[Minecraft Java Edition Server List Ping](https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping)。

```text
src/
  index.ts            公开导出
  client.ts           实例方法与函数式 API
  types.ts            配置及返回值接口
  errors.ts           可识别的错误类型
  options.ts          参数验证
  transport.ts        TCP 生命周期、超时和 Ping/Pong
  status.ts           响应结构验证与字段转换
  motd.ts             纯文本 MOTD 解析
  protocol/
    codec.ts          VarInt、字符串和 TCP 分帧
    packets.ts        协议数据包编码与解码
```
