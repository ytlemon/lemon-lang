# Lemon Language for VS Code

为 Lemon 编程语言（源文件后缀 `.lemon1`）提供编辑器支持。

Lemon 是一门 C 风格命令式语言：程序以 `__init__` 为必需外壳，`main()` 声明主程序入口，
变量声明带静态类型（`int` / `double` / `text`），支持不加引号的裸文本字面量，
语句用换行分隔（分号可选），内置 `say()` 输出。

## 功能

| 能力 | 说明 |
| --- | --- |
| 语法高亮 | 关键字、类型、内置函数、注释、字符串与转义、数字、标识符 |
| 代码片段 | `init` / `main` / `int` / `double` / `text` / `def` / `say` |
| 括号与引号 | `{}`、`()` 自动配对，`"` 自动闭合，`//` 与 `/* */` 快捷注释 |
| 实时诊断 | 打开 / 编辑 / 保存时调用 `lemon check --json --stdin`，错误与警告直接下划线标注 |
| **一键运行** | 代码里的 ▶ 运行、底部状态栏的 ▶ 运行 Lemon、标题栏 ▷、右键菜单、`Ctrl+Alt+R` |
| 一键检查 | 代码里的 ✓ 检查、标题栏 ✓、右键菜单 |
| 打开 REPL | 标题栏终端按钮、命令面板，或 `Ctrl+Alt+L` |

运行入口一览（`Ctrl+Alt+R` 为 Windows/Linux；macOS 为 `Cmd+Alt+R`）：

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| **▶ 运行** | **代码中 `main()` 那一行的上方** | CodeLens 内嵌按钮，打开就能看见 |
| **▶ 运行 Lemon** | **窗口底部状态栏** | 常驻按钮，打开 `.lemon1` 文件即出现 |
| ▷ 播放按钮 | 编辑器右上角标题栏 | 由 `editor/title/run` 提供 |
| 右键菜单 | 编辑器内右键 | 「Lemon: 运行当前文件」 |
| 资源管理器 | `.lemon1` 文件上右键 | 「Lemon: 运行当前文件」 |
| 快捷键 | `Ctrl+Alt+R` | 仅在 `.lemon1` 文件内生效 |
| 命令面板 | `Ctrl+Shift+P` → `Lemon` | 全部命令 |

若看不到代码里的 ▶ 按钮，请确认设置 `editor.codeLens` 未被关闭（默认开启）；
状态栏与标题栏入口不受该设置影响。

运行与 REPL 各自复用一个终端，不会每次点击都新开一个。源文件未保存时会先自动保存再运行。

## 前置条件

扩展需要一个 `lemon` 可执行文件。按以下顺序查找：

1. 设置项 `lemon.executablePath` 指定的路径（若填写了非默认值）；
2. 当前工作区 `dist/` 目录下的 `lemon.exe`（Windows）或 `lemon`；
3. 系统 `PATH` 中的 `lemon`。

若使用本仓库，先生成可执行文件即可被自动识别：

```bash
npm install
npm run exe        # 产出 dist/lemon.exe（Windows）
```

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `lemon.executablePath` | `lemon` | lemon 可执行文件路径 |
| `lemon.diagnostics.enable` | `true` | 是否自动检查 |
| `lemon.diagnostics.debounceMs` | `300` | 自动检查的防抖延迟（毫秒） |

## 关于"裸文本"的显示说明

Lemon 允许不加引号直接书写文本，但 **`say` 里的文本要加引号**：写 `say("你好")`，不要写 `say(你好)`（会报 E0344）。
**某个词究竟是变量还是裸文本，要经过静态检查才能确定**，因此语法高亮层面无法区分二者，
扩展统一按"标识符"着色。实际语义以诊断结果与运行输出为准。

## 安装（本地 .vsix）

```bash
npm run ext:package
code --install-extension vscode-lemon/lemon-language.vsix
```

## 许可

MIT
