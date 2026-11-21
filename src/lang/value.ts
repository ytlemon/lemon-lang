/**
 * 运行期值系统。
 *
 * v1 只有三种用户可见类型（int / double / text）加上 Unit（无返回值）与函数值。
 * 所有值都是不可变的普通对象，标准库实现不得原地修改入参。
 */
import type { FuncDecl } from './ast';
import type { Env } from './env';

export interface IntValue {
  kind: 'int';
  value: number;
}

export interface DoubleValue {
  kind: 'double';
  value: number;
}

export interface TextValue {
  kind: 'text';
  value: string;
}

export interface BoolValue {
  kind: 'bool';
  value: boolean;
}

export interface UnitValue {
  kind: 'unit';
}

export interface FuncValue {
  kind: 'func';
  decl: FuncDecl;
  /** 声明时的环境（闭包） */
  closure: Env;
}

/**
 * 列表值。
 *
 * `items` 按 `list(名字) { ... }` 里的书写顺序排列，元素可以是任意值
 * （包括另一个列表，因此嵌套是自然支持的）。
 * 与其它值一样不可变：类库实现不得原地修改 items。
 */
export interface ListValue {
  kind: 'list';
  items: Value[];
}

/**
 * catch 捕获到的错误值。
 * 字段只读：code（错误码，text）、line（出错行号，int）、message（说明，text）。
 */
export interface ErrorValue {
  kind: 'error';
  code: string;
  message: string;
  line: number;
}

/**
 * 类实例。`fields` 按类里字段的书写顺序保存，构造时把实参按顺序打包进来。
 * 对象是**只读**的：没有字段赋值，也没有方法挂在值上（方法调用在求值器里按
 * 类名 + 方法名即时解析）。
 */
export interface ObjectValue {
  kind: 'object';
  className: string;
  fields: Map<string, Value>;
}

export type Value =
  | IntValue
  | DoubleValue
  | TextValue
  | BoolValue
  | UnitValue
  | FuncValue
  | ErrorValue
  | ListValue
  | ObjectValue;

export const UNIT: UnitValue = { kind: 'unit' };

/** 值的类型名（用于报错展示） */
export function typeNameOf(value: Value): string {
  return value.kind;
}

/** 值的用户可见文本形式 */
export function displayValue(value: Value): string {
  switch (value.kind) {
    case 'int':
      return String(value.value);
    case 'double': {
      // 整数值的 double 保留 .0 后缀，让"类型"在输出中依然可辨；
      // 但科学计数法（如 1e21）不能再追加后缀，否则会变成 "1e+21.0"
      const text = String(value.value);
      if (Number.isInteger(value.value) && !/[eE]/.test(text)) return `${text}.0`;
      return text;
    }
    case 'text':
      return value.value;
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'unit':
      return 'unit';
    case 'error':
      // 与诊断输出的首行保持一致：错误码 + 说明
      return `${value.code} ${value.message}`;
    case 'func':
      return `<函数 ${value.decl.name}>`;
    case 'list':
      // 元素用 displayValue 递归渲染，所以嵌套列表自然能看到结构；
      // 文本元素不加引号，保持与 say(文本) 一致的观感
      return `[${value.items.map(displayValue).join(', ')}]`;
    case 'object':
      return `${value.className}(${[...value.fields.values()].map(displayValue).join(', ')})`;
    default:
      return '<未知值>';
  }
}
