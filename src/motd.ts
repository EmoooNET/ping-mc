/** Minecraft Java 版状态响应中的 JSON 文本组件。 */
export type MCChatComponent =
  | string
  | number
  | boolean
  | null
  | MCChatComponentObject
  | MCChatComponent[];

/** 样式会被纯文本解析器忽略；动态组件仅保留服务器提供的值或标识符。 */
export interface MCChatComponentObject {
  text?: string | number | boolean;
  extra?: MCChatComponent[];
  translate?: string;
  fallback?: string;
  with?: MCChatComponent[];
  keybind?: string;
  score?: { name: string; objective: string; value?: string | number };
  selector?: string;
  separator?: MCChatComponent;
  nbt?: string;
  interpret?: boolean;
  block?: string;
  entity?: string;
  storage?: string;
  color?: string;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
  insertion?: string;
  clickEvent?: Record<string, unknown>;
  hoverEvent?: Record<string, unknown>;
}

const MAX_DEPTH = 64;
const MAX_COMPONENTS = 10_000;
const MAX_TEXT_LENGTH = 1_048_576;

// 同时移除旧版颜色/样式和 §x§R§R§G§G§B§B、§#RRGGBB 十六进制颜色。
const LEGACY_FORMATTING = /§(?:#[0-9a-f]{6}|[0-9a-fk-orx])/gi;

function primitiveText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).slice(0, MAX_TEXT_LENGTH)
    : '';
}

/** 支持 Minecraft 使用的 %s、%1$s 及 %%；缺失参数时保留占位符。 */
function formatTranslation(template: string, parameters: string[]): string {
  let text = '';
  let position = 0;
  let parameterIndex = 0;

  for (const match of template.matchAll(/%%|%(?:(\d+)\$)?s/g)) {
    const prefix = template.slice(position, match.index);
    text += prefix.slice(0, MAX_TEXT_LENGTH - text.length);
    if (text.length >= MAX_TEXT_LENGTH) return text;

    const replacement = match[0] === '%%'
      ? '%'
      : parameters[match[1] === undefined ? parameterIndex++ : Number(match[1]) - 1] ?? match[0];
    text += replacement.slice(0, MAX_TEXT_LENGTH - text.length);
    position = match.index + match[0].length;
    if (text.length >= MAX_TEXT_LENGTH) return text;
  }

  return text + template.slice(position, position + MAX_TEXT_LENGTH - text.length);
}

/**
 * 将 MOTD 转成保留换行的纯文本，并移除 § 颜色和格式代码。
 * 翻译组件使用 fallback；没有语言资源及 fallback 时显示 translate 键。
 * 不解析游戏内记分板、选择器或 NBT，只显示已有值或标识符。
 * 为防止恶意输入，最多处理 64 层、10,000 个组件及 1,048,576 个 UTF-16 码元。
 */
export function parseMOTD(description: MCChatComponent): string {
  let visited = 0;

  function renderList(components: unknown[], depth: number): string {
    let text = '';
    for (const component of components) {
      if (visited >= MAX_COMPONENTS || text.length >= MAX_TEXT_LENGTH) break;
      text += render(component, depth).slice(0, MAX_TEXT_LENGTH - text.length);
    }
    return text;
  }

  function render(component: unknown, depth: number): string {
    if (depth >= MAX_DEPTH || visited >= MAX_COMPONENTS) return '';
    visited += 1;

    if (component === null || typeof component !== 'object') return primitiveText(component);
    if (Array.isArray(component)) return renderList(component, depth + 1);

    const content = component as Record<string, unknown>;
    let text = primitiveText(content.text);

    if (content.text === undefined) {
      if (typeof content.translate === 'string') {
        const template = typeof content.fallback === 'string' ? content.fallback : content.translate;
        const parameters: string[] = [];
        if (Array.isArray(content.with)) {
          for (const parameter of content.with) {
            if (visited >= MAX_COMPONENTS) break;
            parameters.push(render(parameter, depth + 1));
          }
        }
        text = formatTranslation(template.slice(0, MAX_TEXT_LENGTH), parameters);
      } else if (typeof content.keybind === 'string') {
        text = primitiveText(content.keybind);
      } else if (content.score !== null && typeof content.score === 'object') {
        const score = content.score as Record<string, unknown>;
        text = primitiveText(score.value ?? score.name);
      } else {
        text = primitiveText(content.selector ?? content.nbt);
      }
    }

    if (Array.isArray(content.extra) && text.length < MAX_TEXT_LENGTH) {
      text += renderList(content.extra, depth + 1).slice(0, MAX_TEXT_LENGTH - text.length);
    }
    return text;
  }

  return render(description, 0).replace(LEGACY_FORMATTING, '');
}
