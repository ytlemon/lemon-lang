/**
 * 环境链：变量绑定存储。
 *
 * 查找沿 parent 指针向上，复杂度 O(作用域深度)。
 * v1 没有重新赋值语法，但 Map 本身可变，供 REPL 逐行累积绑定。
 */
import type { Value } from './value';

export class Env {
  private readonly vars = new Map<string, Value>();
  readonly parent: Env | null;

  constructor(parent: Env | null = null) {
    this.parent = parent;
  }

  define(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  /**
   * 删除**本层**的绑定，返回是否真的删掉了。
   *
   * 只删当前层：不去祖先作用域里翻找。`del list(1)` 要的就是这个语义——
   * 编号槽定义在根环境，删掉之后 `list(1)` 会重新变回一个空槽。
   */
  undefine(name: string): boolean {
    return this.vars.delete(name);
  }

  /** 仅在当前层定义（用于 REPL 覆盖同名绑定） */
  hasOwn(name: string): boolean {
    return this.vars.has(name);
  }

  lookup(name: string): Value | undefined {
    let env: Env | null = this;
    while (env !== null) {
      const found = env.vars.get(name);
      if (found !== undefined) return found;
      env = env.parent;
    }
    return undefined;
  }

  /** 当前层已有绑定快照（供 REPL 的 :symbols 使用） */
  ownEntries(): Array<[string, Value]> {
    return [...this.vars.entries()];
  }
}
