# LemonMod

Lemon 的**实验性第二版实现**，源文件后缀 `.lemon2`。

它在主语言（`.lemon1`）之外另起炉灶：语法更轻、变量**动态类型**、输出同时支持裸文本与字符串。当前版本 **v0.2**，适合做原型与体验，尚未对齐 v1 的全部能力。

```
set demo public{
    class public{
        a = 1          // 变量赋值（动态类型，可重复赋值）
        a = a + 1
        say(a)         // 2
        printf("你好")
    }
}
```

## 与主语言（.lemon1）的区别

| 维度 | Lemon v1（`.lemon1`） | LemonMod v2（`.lemon2`） |
| --- | --- | --- |
| 入口外壳 | `__init__ { ... }` + `main()` | `set 名字 public { class public { ... } }` |
| 变量类型 | 静态类型，必须声明：`int a = 1` | 动态类型，免声明：`a = 1` |
| 输出 | `say(裸文本)` | `say(表达式)` / `printf("字符串")` 等价 |
| 字符串 | 无引号裸文本为主 | 支持 `"..."` 字符串字面量（含转义） |
| 类型检查 | 编译期静态检查 | 运行期按值检查（`+` 文本拼接，其余仅数字） |
| 控制流 / 函数 | `if` / `elif` / `else`、`cycle`、列表、`def` | 暂无（v0.2 只有赋值与输出） |

未定义的裸词变量会**回退成其名字本身当文本**，所以 `say(hello)` 在没赋值时仍按字面量输出 `hello` —— 这是为兼容 v0.1 裸文本语义刻意的取舍。

## 项目结构

```
mod/
├── src/               解释器（TypeScript，8 个文件）
│   ├── lexer.ts       词法分析（v0.1 起步，含字符串 / 数字 / 裸词）
│   ├── parser.ts      递归下降语法分析（v0.2 文法）
│   ├── ast.ts         语法树节点 + 值系统
│   ├── interpreter.ts 树遍历求值（变量环境 + 输出）
│   ├── token.ts       Token 定义
│   ├── errors.ts      错误码（M01xx~M03xx）与诊断渲染
│   ├── index.ts       对外 API（runModSource / checkModSource）
│   └── cli.ts         命令行入口
├── bin/lemonmod.js    可执行入口（转发到 build 产物）
├── build/             tsc 编译产物（mod:build 生成，含 .js / .map）
├── examples/          示例（hello.lemon2）
├── tests/             node --test 用例（157 行，覆盖语法 / 运行 / 错误）
├── vscode-lemonmod/   VS Code 扩展（高亮 + 代码片段 + 语法定义）
└── tsconfig.json      继承根 tsconfig，outDir=build
```

## 快速开始

需要先编译（源码是 TS，运行时是 `build/` 下的 JS）：

```bash
npm run mod:build      # tsc -p mod/tsconfig.json → mod/build
```

直接跑示例（先构建再执行）：

```bash
npm run mod:run -- examples/hello.lemon2
# 等价于：
#   npm run mod:build
#   node mod/build/src/cli.js examples/hello.lemon2
```

也可以走 `bin` 入口（产物缺失时会提示先 `npm run mod:build`）：

```bash
node mod/bin/lemonmod.js examples/hello.lemon2
```

运行结果：

```
hello
hello
```

## 命令行

```
lemonmod <文件.lemon2>       运行脚本
lemonmod --help | -h         帮助
```

- 正常输出走 **stdout**，每行自动换行；
- 诊断（错误）走 **stderr**，带文件名、行列与源码片段；
- 退出码：`0` 成功、`1` 用法错误 / 语言错误。

## 语言速览（v0.2）

| 项目 | 规定 |
| --- | --- |
| 源文件 | 后缀 `.lemon2`，UTF-8（自动剥 BOM），LF / CRLF 都认 |
| 文件外壳 | 必须以 `set <文件名> public {` 开头，内部一个 `class public { ... }` 初始化块，结尾 `}`；一个文件只能有一个文件声明 |
| 文件名 | 任意裸词，可含汉字 |
| 语句 | 两种：`name = 表达式`（赋值）与 `say(表达式)` / `printf(表达式)`（输出）；二者可混排 |
| 断句 | **换行或分号**都可，可任意混用；同行多条语句需 `;` |
| 注释 | `//` 行注释（`/* */` 块注释尚未支持） |
| 变量 | 动态类型，免声明、可重复赋值；未定义裸词回退成名字文本 |
| 值 | 只有两种：`number`（数字，整数 / 小数）与 `text`（文本） |
| 运算 | `+ - * /` 与括号；`*` `/` 优先于 `+` `-`，同级左结合；一元 `+` / `-` |
| 拼接 | `+` 任一侧是文本即做拼接（数字也转文本）；`- * /` 只接受数字，否则类型错误 |
| 字符串 | `"..."`，支持 `\n \t \r \" \' \\` 转义 |
| 裸文本 | 不加引号的裸词直接当文本/变量名：`say(你好)` 等价于 `say("你好")` |
| 布尔 | 运行期值 `true` / `false`，由比较运算产生 |
| 比较 | `== != < <= > >=`：结果恒为 `bool`；`==`/`!=` 可比较任意值，`<`/`<=`/`>`/`>=` 仅数字 |
| 逻辑非 | 一元 `!`：对真值取反，结果为 `bool` |
| 条件分支 | `if 条件 { ... } [elif 条件 { ... }]* [else { ... }]`；条件按真值判定（数字非零 / 文本非空 / 布尔本身） |

## 错误码

按来源分组（详见 `src/errors.ts`）：

| 区间 | 含义 |
| --- | --- |
| `M01xx` | 文件外壳（`set` / `class` / `public` / 花括号 / 收尾） |
| `M02xx` | 语句（`say`/`printf` 形状、参数个数、断句） |
| `M03xx` | 词法（未闭合字符串、非法字符） |
| `M04xx` | 求值（类型不匹配、除零、表达式残缺） |

部分错误码：

| 码 | 触发 |
| --- | --- |
| `M0101` | 文件不以 `set <文件名> public{` 开头 |
| `M0103` | 文件名后缺 `public` |
| `M0105` | 文件体内缺 `class public{` |
| `M0109` | 文件声明结束后还有多余内容 |
| `M0201` | 不认识的语句（非 `say`/`printf`/赋值） |
| `M0203` | 输出语句缺参数：`say()` |
| `M0205` | 输出语句参数过多：`say(a, b)` |
| `M0206` | 语句之间缺换行或分号 |
| `M0208` | `if` 条件后缺 `{` |
| `M0209` | 块（then/elif/else）缺收尾 `}` |
| `M0211` | `elif` 条件后缺 `{` |
| `M0212` | `else` 后缺 `{` |
| `M0301` | 字符串未闭合 |
| `M0302` | 非法字符 |
| `M0401` | 求值：类型不匹配（文本参与 `- * /` 或关系运算、非数字比较） |
| `M0402` | 求值：除数为 0 |
| `M0403` | 求值：表达式残缺（条件 / 运算子缺操作数） |

## 构建与测试

| 命令 | 作用 |
| --- | --- |
| `npm run mod:typecheck` | 仅类型检查 |
| `npm run mod:build` | tsc 编译到 `mod/build` |
| `npm run mod:test` | 构建并跑 `node --test mod/build/tests/**` |
| `npm run mod:run -- <文件>` | 构建并运行指定 `.lemon2` |
| `npm run mod:ext:build` | 构建 VS Code 扩展 |
| `npm run mod:ext:package` | 打包 `lemonmod-language.vsix` |

## 已知限制（v0.2）

- **无类型声明、无静态检查**：变量动态类型，运行期才按值判断。
- **无函数 / 列表 / 循环**：条件分支（`if`/`elif`/`else`）已支持，但 `def`、`while`/`for`、`cycle`、列表尚未实现。
- **未定义变量不报错**，回退成文本（见上文取舍）—— 若希望"未定义即报错"需改语义。
- **花括号不做深度匹配**：未闭合的 `if` 块会"借用"外层 `}` 而不报错（写代码时请保证每个块都闭合）。
- **块注释、`#incloud`、网页界面** 尚未实现。
- 错误码 `M04xx` 暂未登记（见上）。

## 许可

MIT（与主项目一致）。
