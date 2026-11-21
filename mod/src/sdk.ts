/**
 * lemonmod 内置游戏 SDK 模块。
 *
 * `#incloud gamemodmake` 会把这里的函数注册进运行器，供 mod 在 modmain 里调用。
 * 这些都是「示例实现」：在 lemonmod 直接跑时，它们把动作写到输出并记进
 * `interp.gameState`；将来你用 lemon1 打包、交给真实游戏时，可在游戏侧把
 * `BUILTIN_MODULES` 换成真正的实现。
 *
 * 扩展方式：
 *   - 新增一个模块：在 BUILTIN_MODULES 里加一项；
 *   - 给 gamemodmake 加函数：在下面再写一个键值对即可。
 */
import type { ModValue } from './ast';
import type { Interpreter } from './interpreter';

/** 内置函数签名：拿到运行器与已求值的实参，返回结果值（也可只做副作用） */
export type BuiltinFn = (interp: Interpreter, args: ModValue[]) => ModValue;

export const BUILTIN_MODULES: Record<string, Record<string, BuiltinFn>> = {
  gamemodmake: {
    /** spawnEnemy(类型, 数量=1) —— 生成敌人 */
    spawnEnemy(interp, args) {
      const type = args[0] !== undefined ? interp.toText(args[0]) : 'enemy';
      const count = args[1]?.kind === 'number' ? args[1].value : 1;
      const enemies = (Number(interp.gameState.enemies) || 0) + count;
      interp.gameState.enemies = enemies;
      interp.emit(`[gamemodmake] spawnEnemy: ${type} x${count}\n`);
      return { kind: 'number', value: count };
    },

    /** setLevel(关卡名) —— 设定关卡 */
    setLevel(interp, args) {
      const name = args[0] !== undefined ? interp.toText(args[0]) : '';
      interp.gameState.level = name;
      interp.emit(`[gamemodmake] setLevel: ${name}\n`);
      return { kind: 'text', value: name };
    },

    /** setDifficulty(难度=1) —— 设定难度 */
    setDifficulty(interp, args) {
      const level = args[0]?.kind === 'number' ? args[0].value : 1;
      interp.gameState.difficulty = level;
      interp.emit(`[gamemodmake] setDifficulty: ${level}\n`);
      return { kind: 'number', value: level };
    },

    /** addItem(物品名) —— 添加物品到背包 */
    addItem(interp, args) {
      const name = args[0] !== undefined ? interp.toText(args[0]) : '';
      const items = Array.isArray(interp.gameState.items)
        ? (interp.gameState.items as string[])
        : [];
      items.push(name);
      interp.gameState.items = items;
      interp.emit(`[gamemodmake] addItem: ${name}\n`);
      return { kind: 'text', value: name };
    },

    /** log(任意内容...) —— 调试日志 */
    log(interp, args) {
      const msg = args.map((a) => interp.toText(a)).join(' ');
      interp.emit(`[gamemodmake] ${msg}\n`);
      return { kind: 'text', value: msg };
    },
  },
};
