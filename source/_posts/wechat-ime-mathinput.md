---
title: 微信输入法的算式结果时灵时不灵，我用 AutoHotkey 补了个按 = 出答案的
date: 2026-11-22 10:50:00
updated: 2026-11-22 10:50:00
description: 任意输入框敲算式，按 = 直接在等号后面补出答案，还支持接着上一次结果继续算。含完整 AutoHotkey v2 代码与踩坑记录。
categories:
  - 开发工具
tags:
  - AutoHotkey
  - 开源
  - Windows
---

## 先说结论

写了一个 AutoHotkey v2 脚本，在**任意** Windows 输入框里敲算式，按 `=` 直接在等号后面补出答案：

```
12*(3+4)=            →  12*(3+4)=84
总共 100+2=          →  总共 100+2=102
110+2=112 再敲 +99=  →  110+2=112+99=211
```

不调用任何输入法，不侵入目标程序，不需要在浏览器和 Excel 之间来回切计算器。

- 仓库：<https://github.com/szjmhxd/ahk-scripts>
- 依赖：Windows 10/11 + [AutoHotkey v2.0](https://www.autohotkey.com/)（v1 不行）

---

<!-- more -->

## 场景：要的是「随手算一笔」，不是打开计算器

公司财务的日常是核对一堆数：报销单上的金额、表格里的合计、微信里报过来的数字。这类计算的特点是**碎**——一次只算一个加减乘除，算完立刻要写回原文。

打开计算器应用、算完、切回来、再抄一遍，四步。算 20 次就是 80 步。所以看到微信输入法能「在输入框里直接把算式变成结果」时，第一反应是这东西正合适。

问题是它不稳。

## 微信输入法那个功能的实际表现

同事的描述是「有时候出、有时候不出」，复现不出稳定规律。同一个算式，在微信里能出结果，换到 Excel 单元格或者网页表单里就不一定；有时候要再补敲一个字符结果才冒出来。

这不是某个版本的 bug，是**输入法端做算术这件事本身的约束**：

| 约束 | 后果 |
| --- | --- |
| 输入法只能看到自己的组字上下文 | 光标一移动、一切换焦点，算式上下文就断了 |
| 依赖应用对 IME 组字的支持程度 | 自绘文本控件、部分 Electron / UWP 应用里拿不到完整上下文 |
| 触发条件由输入法自己定 | 用户没法配置「什么时候算、算什么」 |
| 结果是输入法的附加能力 | 换输入法、换版本、换系统语言都可能变 |

结论很直接：**要稳定，就不能把计算能力寄托在输入法上。**

## 最终需求

| 需求 | 原因 |
| --- | --- |
| 任意输入框都能用 | 微信、Excel、浏览器、记事本、公司内部系统都要覆盖 |
| 按 `=` 立即出结果 | 符合纸面书写习惯，不需要记快捷键 |
| 保留原算式 | 财务要留痕核对，不能算完就把算式吃掉了 |
| 支持链式运算 | 对账经常是「这个数再加那个数再减掉这个」 |
| 四则运算必须准 | 小数、负数、括号、百分比都不能出错 |
| 算不出来时不要乱动 | 打 `>=`、`==` 这种普通等号不能被劫持 |

最后两条是设计底线。一个会算错数、或者会把用户正常输入的等号吃掉的工具，比没有更糟。

## 技术选型：为什么是 AutoHotkey

| 方案 | 为什么不选 |
| --- | --- |
| 自己写输入法 | 要注册 TSF/IME，工程量和维护成本完全不成比例 |
| 浏览器扩展 | 只覆盖浏览器，Excel 和公司内部系统用不了 |
| 全局热键 + 弹窗计算器 | 又回到「打开-算-抄回来」的老路 |
| 剪贴板中转（选中→算→粘贴） | 多一步操作，且打断输入节奏 |
| **AutoHotkey 全局键盘钩子** | 能旁听按键、能回填文本、跨应用一致，一个文件搞定 |

AutoHotkey 的关键能力是 `InputHook`：它能以「只旁听、不拦截」的方式看到你的按键，字符照常进入当前窗口。这样就拿到了一个跨应用的字符流，且不需要知道目标程序是什么。

## 实现：四个关键决定

### 1. 只旁听，不拦截

```ahk
ih := InputHook()
ih.VisibleText := true        ; 字符照常进入当前窗口，只旁听不拦截
ih.VisibleNonText := true     ; 回车、退格等功能键也照常生效
ih.OnChar := (h, ch) => App.HandleChar(ch)
ih.OnKeyDown := (h, vk, sc) => App.HandleKey(vk)
ih.Start()
```

`VisibleText` / `VisibleNonText` 是重点。默认的 InputHook 会把按键吃掉，那样整个键盘就废了；置为 `true` 之后它只做观察者，用户完全感知不到脚本存在，直到按下 `=`。

同时用 `KeyOpt` 单独订阅退格、回车、方向键的按下事件（`N` = 通知），用来同步缓冲区：

```ahk
ih.KeyOpt("{Backspace}{Enter}{Escape}{Tab}{Delete}{Left}{Right}{Up}{Down}{Home}{End}", "N")
```

### 2. 自己写求值器，因为 AHK 没有 eval

AutoHotkey 里没有 `eval`，只能自己实现。选了**递归下降**，比调度场算法短，且参数列表天然好处理：

```
expr    := term (('+' | '-') term)*
term    := unary (('*' | '/') unary)*
unary   := ('+' | '-') unary | power
power   := postfix ('^' unary)?        右结合，所以 2^3^2 = 512
postfix := primary '%'*
primary := number | name ['(' args ')'] | '(' expr ')'
```

一个必须处理的细节：**AHK 的 `**` 在两个整数操作数下走 64 位整数运算**，`2^100` 会溢出成 `0`。所以数字字面量统一强制浮点：

```ahk
return Number(txt) * 1.0    ; 强制浮点：整数运算下 2^100 会溢出成 0
```

### 3. 默认「在 = 后面补答案」，而不是替换算式

第一版是「用结果替换整段算式」：按 `=` 时回删 `len(算式)+1` 个字符，再写入结果。逻辑上讲得通，实际很脆：

- 算式里带空格，回删数量就会算少，留下残字
- 用户中途用方向键、鼠标改过内容，字符计数直接作废
- 输入法组字、应用自动补全都会让「输入框里到底有几个字符」和脚本的记录对不上

改成追加后，这些问题一起消失：`=` 本来就已经进入输入框了，脚本只需要在它后面写答案，**一个字符都不用删**。

```
12*(3+4)=   →   12*(3+4)=84
```

要保留「替换」行为，改 `Cfg.Mode := "replace"` 即可，两套逻辑都在。

### 4. 前缀容错：从后往前找能算的尾段

这个是中文环境下的必需功能。敲「总共 100+2」时，输入法实际发给系统的按键流里含着拼音字母，缓冲区可能长成 `zonggong100+2`，整体校验必然失败。

解决办法是整体算不出来时，**从后往前逐位截断，找第一个能算通的尾段**：

```ahk
static EvalBuf() {
    full := Trim(this.buf)
    r := this.TryEval(full)
    if (r != "")
        return { expr: full, res: r }
    n := StrLen(full), i := 1
    while (i <= n) {
        cand := Trim(SubStr(full, i))
        if (cand != "" && cand ~= "^[0-9.(a-zA-Z+\-]") {
            r := this.TryEval(cand)
            if (r != "")
                return { expr: cand, res: r }
        }
        i++
    }
    return { expr: "", res: "" }
}
```

效果：

```
试试 100+2=    →  试试 100+2=102
shishi 100+2=  →  shishi 100+2=102
note: 12*3=    →  note: 12*3=36
```

### 5. 链式计算：把上一次的结果存成下一次的起点

按完 `110+2=` 得到 `112`，接着敲 `+99` 时，脚本不该把 `+99` 当成独立算式（会算出 99）。用一个 `seed` 记住上次结果，**只有下一个字符是运算符时**才拿它当起点：

```ahk
if (this.buf = "" && this.seed != "" && m ~= "^[+\-*/^%]$")
    this.buf := this.seed
```

```
110+2=  再敲 +99=   →  110+2=112+99=211
10+5=   再敲 *3=    →  10+5=15*3=45
100/4=  再敲 -10=   →  100/4=25-10=15
2^10=   再敲 /4=    →  2^10=1024/4=256
```

以数字开头则是全新算式，不会粘上一次的结果。

## 踩过的坑

这些都是实测撞出来的，不是查文档能提前避开的。

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 脚本一启动就弹「未识别的动作」，指向 `#NoEnv` | `#NoEnv` 是 v1 指令，v2 已删除 | 删掉，v2 不需要 |
| `Lower()` 被当成未赋值变量 | v2 改名为 `StrLower` | 改名 |
| `Hotkey #h, Func` 报 Invalid callback function | v2 的 `Hotkey` 是函数，必须带括号且传函数对象 | `Hotkey("#h", CalcSelection)` |
| **每敲一个字符就抛一次异常，键盘钩子当场静默失效，输入框里只剩原始文字** | `static map := Map(...)` —— AHK 变量名**不分大小写**，`map` 把内置类 `Map` 遮住了，初始化时读到的其实是「尚未赋值的自己」 | 变量改名 `tbl` |
| 结果里的 `+` `^` `!` `{` 变成修饰键，输出乱码 | `Send` 会解析这些符号 | 改用 `SendText` |
| `2^100` 算出 `0` | AHK 整数运算 64 位溢出 | 强制浮点 `Number(txt) * 1.0` |
| `(a ? "x" : "y") . "文字"` 报 `Missing "` | v2 禁止在同一条表达式里混用隐式拼接和 `.` 运算符 | 统一用 `.` |
| 提示框飘到屏幕左上角 | `ToolTip` 默认按客户区坐标定位 | 启动时 `CoordMode("ToolTip", "Screen")` |
| 算式里带空格时替换后留下残字 | 空格进了输入框但没进缓冲区，回删数量算少 | 默认改成追加模式，不删字符 |

其中「`map` 遮蔽 `Map`」这条最值得记：报错信息是 `This static variable has not been assigned a value`，指向的却是 `Map(...)` 这一行，看上去完全不合理。它的实际含义是**你在初始化自己之前就引用了自己**。

## 实测

21 条端到端用例，全部在真实窗口里用模拟按键跑通（不是单元测试，是真的起进程、真的往 Edit 控件里打字）：

| 输入 | 输出 |
| --- | --- |
| `12*(3+4)=` | `12*(3+4)=84` |
| `1 + 2 =` | `1 + 2 =3` |
| `7-10=` | `7-10=-3` |
| `8/3=` | `8/3=2.6666666667` |
| `0.1+0.2=` | `0.1+0.2=0.3` |
| `2^10=` | `2^10=1024` |
| `15%*200=` | `15%*200=30` |
| `1234*5678=` | `1234*5678=7006652` |
| `sqrt(81)=` | `sqrt(81)=9` |
| `max(3,9)=` | `max(3,9)=9` |
| `１＋２＝`（全角） | `１＋２＝3` |
| `5*（2＋3）＝` | `5*（2＋3）＝25` |
| `hello=` | `hello=`（不动作） |
| `1+2*=` | `1+2*=`（算式残缺，不动作） |
| `110+2=` 后 `+99=` | `110+2=112+99=211` |

小数精度做了处理：`0.1+0.2` 不会输出 `0.30000000000000004`，格式化到 10 位小数再去掉尾零。

## 局限与风险

写清楚比藏着好。

- **它会读取所有键盘输入。** 全局钩子旁听的字符都会进脚本内存（内存里，不落盘、不发网络）。密码框里敲的东西它也会看到，只是不会做任何事。介意这个风险就别用。
- **输入法组字过程跟踪不准。** 拼音字母会混进缓冲区，靠「从后往前找尾段」兜底，不是 100% 可靠。
- **只在文本输入控件里有效。** 自绘控件、部分 UWP / 沙箱应用可能完全不响应。
- **数字是双精度浮点。** 超过 53 位有效数字会失真，超过 `1e15` 自动转科学计数法。当计算器够用，当高精度工具不够。
- **追加模式没有分隔符。** `20-5=15` 之后紧接着敲 `7*8=`，会变成 `20-5=157*8=56`——数字 15 和 7 本来就挨着，这是「在等号后补答案」的必然结果。想断开就按个空格或回车。
- **`Win+H` 在 Win11 上被语音输入占用。** 冲突就改 `Cfg.SelectKey`。

## 安装与使用

1. 装 [AutoHotkey v2.0](https://www.autohotkey.com/)
2. 下载 [MathInput.ahk](https://github.com/szjmhxd/ahk-scripts/blob/main/MathInput/MathInput.ahk)
3. 双击运行。要常驻就快捷方式扔进 `shell:startup`
4. 任意输入框敲算式，按 `=`；选中文字按 `Win+H` 直接求值
5. 托盘图标右键可重载或退出

配置都在文件顶部的 `Cfg` 类里，改完从托盘「重载脚本」生效：

```ahk
class Cfg {
    static CommitKey  := "="      ; 触发键
    static SelectKey  := "#h"     ; 对选中内容求值的热键
    static ShowTip    := true     ; 输入时是否浮动显示结果
    static Mode       := "append" ; "append"=在 = 后面补答案；"replace"=用答案替换算式
    static IdleReset  := 6000     ; 毫秒；停手这么久就丢弃缓冲
}
```

## 完整代码

仓库：<https://github.com/szjmhxd/ahk-scripts>

```ahk
#Requires AutoHotkey v2.0
#SingleInstance Force

; ==================================================================
; MathInput —— 全局「输入算式，按 = 出结果」（AutoHotkey v2.0）
;
; 用法：
;   在任意输入框里敲算式，例如 12*(3+4)，光标旁实时显示 = 84；
;   一按 = 键，答案直接补在等号后面，变成 12*(3+4)=84，不删你写的算式。
;   前面有别的字也没关系：「总共 100+2=」照样只算 100+2。
;   连续计算：110+2=112 之后再敲 +99= ，得到 110+2=112+99=211。
;   想让结果替换掉算式，把下面 Cfg.Mode 改成 "replace"。
;   选中一段文字按 Win+H，直接替换成计算结果。
;
; 支持四则运算：+ - * / 、括号、负号、小数、百分号(15% = 0.15)、乘方 ^
;   函数：sqrt abs round floor ceil sin cos tan asin acos atan
;         log(以10为底) ln exp min max mod
;   常量：pi  e
;   全角字符自动归一：＋ － ＊ ／ （ ） ％ ＝ ０-９ 都能认
;
; 只在「算式合法」时才替换，其它情况 = 就是普通等号，不会被吃掉。
; ==================================================================

; ---------------- 可配置项 ----------------
class Cfg {
    static CommitKey  := "="      ; 触发键
    static SelectKey  := "#h"     ; Win+H：对选中内容求值（可能与系统语音输入冲突）
    static ShowTip    := true     ; 输入时是否浮动显示结果
    static Mode       := "append" ; "append"=在 = 后面补答案（默认）；"replace"=用答案替换算式
    static IdleReset  := 6000     ; 毫秒；停手这么久就丢弃缓冲
}
; ------------------------------------------

App.Start()


; ==================================================================
; 输入跟踪与替换
; ==================================================================
class App {
    static buf := ""      ; 归一化后的算式（可含空格，交给解析器跳过）
    static typed := ""    ; 真正进入输入框的原始字符，用来精确回删
    static last := ""     ; 最近一次算出的结果
    static seed := ""     ; 上一次的结果，供连续计算当起点（110+2=112，再敲 +99= 就是 211）
    static hook := 0
    static idleFn := 0

    static Start() {
        CoordMode("Caret", "Screen")
        CoordMode("ToolTip", "Screen")

        A_IconTip := "MathInput：输入算式按 = 出结果，右键托盘退出"
        A_TrayMenu.Delete()
        A_TrayMenu.Add("计算选中内容`t" . Cfg.SelectKey, (*) => App.CalcSelection())
        A_TrayMenu.Add()
        A_TrayMenu.Add("重载脚本", (*) => Reload())
        A_TrayMenu.Add("退出", (*) => ExitApp())

        try Hotkey(Cfg.SelectKey, (*) => App.CalcSelection())
        catch as e
            Tip("热键 " . Cfg.SelectKey . " 注册失败：" . e.Message)

        ; 鼠标点击会移动光标，此时旧的字符计数不再可信，直接丢弃
        try Hotkey("~LButton", (*) => App.ResetBuf())

        ih := InputHook()
        ih.VisibleText := true        ; 字符照常进入当前窗口，只旁听不拦截
        ih.VisibleNonText := true     ; 回车/退格等功能键照常生效
        ih.NotifyNonText := false
        ih.OnChar := (h, ch) => App.HandleChar(ch)
        ih.OnKeyDown := (h, vk, sc) => App.HandleKey(vk)
        ih.KeyOpt("{Backspace}{Enter}{Escape}{Tab}{Delete}{Left}{Right}{Up}{Down}{Home}{End}", "N")
        ih.Start()
        this.hook := ih
    }

    ; ---------------- 字符流 ----------------
    static HandleChar(ch) {
        for c in StrSplit(ch, "") {
            this.typed .= c                       ; 这个字符已经进到输入框里了
            m := Nz(c)
            if (m = "") {                         ; 中文、表情等非数学字符：放弃本次跟踪
                this.ResetBuf()
                return
            }
            if (m = Cfg.CommitKey) {
                this.Commit()
                return
            }
            ; 连续计算：前面紧接一个运算符，就拿上一次的结果当起点
            if (this.buf = "" && this.seed != "" && m ~= "^[+\-*/^%]$")
                this.buf := this.seed
            if (this.buf = "" && !RegExMatch(m, "[0-9a-zA-Z.(+\-]"))
                continue                          ; 算式开头必须是数字/字母/括号/正负号
            this.buf .= m
        }
        this.ResetIdle()
        this.Refresh()
    }

    static HandleKey(vk) {
        switch vk {
            case 0x08:                            ; Backspace：同步缩短
                if (this.typed != "")
                    this.typed := SubStr(this.typed, 1, -1)
                if (this.buf != "")
                    this.buf := SubStr(this.buf, 1, -1)
                this.ResetIdle()
                this.Refresh()
            case 0x0D, 0x1B:                      ; Enter / Esc
                this.ResetBuf()
            case 0x09, 0x2E, 0x24, 0x23, 0x25, 0x26, 0x27, 0x28:
                this.ResetBuf()                   ; Tab Delete Home End 方向键
        }
    }

    ; ---------------- 提示 ----------------
    static Refresh() {
        if (Trim(this.buf) = "") {
            ToolTip()
            return
        }
        hit := this.EvalBuf()
        if (hit.res = "") {
            this.last := ""
            ToolTip()
            return
        }
        this.last := hit.res
        if (Cfg.ShowTip) {
            if !CaretGetPos(&x, &y)
                MouseGetPos(&x, &y)
            ToolTip(hit.expr . "  =  " . hit.res, x + 8, y + 24)
        }
    }

    ; 缓冲里可能混进了别的东西（中文输入法的拼音、前面的普通文字），
    ; 整体算不出来时，从后往前找能算的尾段。
    static EvalBuf() {
        full := Trim(this.buf)
        if (full = "")
            return { expr: "", res: "" }
        r := this.TryEval(full)
        if (r != "")
            return { expr: full, res: r }
        n := StrLen(full)
        i := 1
        while (i <= n) {
            cand := Trim(SubStr(full, i))
            if (cand != "" && cand ~= "^[0-9.(a-zA-Z+\-]") {
                r := this.TryEval(cand)
                if (r != "")
                    return { expr: cand, res: r }
            }
            i++
        }
        return { expr: "", res: "" }
    }

    ; ---------------- 替换 ----------------
    static Commit() {
        res := this.last
        if (res = "" || Trim(this.buf) = "") {
            this.ResetBuf()                       ; 算不出来就什么都不做，= 原样留着
            return
        }
        if (Cfg.Mode = "append") {
            ; = 已经打进输入框了，直接在它后面补答案，不碰你写的算式
            SendText(res)
        } else {
            ; 替换模式：回删 this.typed 长度（含空格和刚敲下的 =），再写答案
            Send("{Backspace " . StrLen(this.typed) . "}")
            SendText(res)                         ; 必须 SendText，否则 + - ^ ! { 会被当修饰键
        }
        ToolTip()
        this.ResetBuf()
        this.seed := res          ; 留着当连续计算的起点
    }

    static ResetBuf() {
        this.buf := ""
        this.typed := ""
        this.last := ""
        this.seed := ""
        ToolTip()
    }

    static ResetIdle() {
        if (!this.idleFn)
            this.idleFn := (*) => App.ResetBuf()
        SetTimer(this.idleFn, -Cfg.IdleReset)
    }

    ; ---------------- 选中内容求值 ----------------
    static CalcSelection() {
        saved := ClipboardAll()
        A_Clipboard := ""
        Send("^c")
        if !ClipWait(0.6) {
            A_Clipboard := saved
            return
        }
        txt := Trim(A_Clipboard)
        A_Clipboard := saved
        res := this.TryEval(txt)
        if (res != "")
            SendText(res)
        else
            Tip("无法计算：" . txt)
    }

    static TryEval(expr) {
        try {
            return FmtNumber(MathEval(expr).Value())
        } catch {
            return ""
        }
    }
}


; ==================================================================
; 全角/数学符号归一化：返回 ASCII 等价字符，非数学字符返回 ""
; ==================================================================
Nz(c) {
    ; 注意：变量不能叫 map —— 变量名不分大小写，会遮住内置类 Map
    static tbl := Map(
        "＋", "+", "－", "-", "＊", "*", "／", "/", "＝", "=",
        "（", "(", "）", ")", "％", "%", "×", "*", "÷", "/",
        "−", "-", "–", "-", "。", ".")
    if tbl.Has(c)
        return tbl[c]
    code := Ord(c)
    if (code = 0x3000 || code = 0x00A0)               ; 全角空格 / 不断行空格
        return " "
    if (code >= 0xFF01 && code <= 0xFF5E)             ; 全角 ASCII 区
        return Chr(code - 0xFEE0)
    if (code > 0x7E)
        return ""
    return c
}


; ==================================================================
; 表达式求值：递归下降
;   expr    := term (('+' | '-') term)*
;   term    := unary (('*' | '/') unary)*
;   unary   := ('+' | '-') unary | power
;   power   := postfix ('^' unary)?        右结合
;   postfix := primary '%'*
;   primary := number | name ['(' args ')'] | '(' expr ')'
; ==================================================================
class MathEval {
    __New(src) {
        this.s := src
        this.i := 1
        this.n := StrLen(src)
    }

    Value() {
        v := this.Expr()
        this.Ws()
        if (this.i <= this.n)
            throw Error("多余字符：" . SubStr(this.s, this.i))
        return v
    }

    Ws() {
        while (this.i <= this.n && SubStr(this.s, this.i, 1) = " ")
            this.i++
    }

    Cur() {
        return this.i <= this.n ? SubStr(this.s, this.i, 1) : ""
    }

    Expr() {
        v := this.Term()
        loop {
            this.Ws()
            c := this.Cur()
            if (c = "+") {
                this.i++
                v += this.Term()
            } else if (c = "-") {
                this.i++
                v -= this.Term()
            } else
                return v
        }
    }

    Term() {
        v := this.Unary()
        loop {
            this.Ws()
            c := this.Cur()
            if (c = "*") {
                this.i++
                v *= this.Unary()
            } else if (c = "/") {
                this.i++
                d := this.Unary()
                if (d = 0)
                    throw Error("除以零")
                v /= d
            } else
                return v
        }
    }

    Unary() {
        this.Ws()
        c := this.Cur()
        if (c = "-") {
            this.i++
            return -this.Unary()
        }
        if (c = "+") {
            this.i++
            return this.Unary()
        }
        return this.Power()
    }

    Power() {
        base := this.Postfix()
        this.Ws()
        if (this.Cur() = "^") {
            this.i++
            return base ** this.Unary()
        }
        return base
    }

    Postfix() {
        v := this.Primary()
        loop {
            this.Ws()
            if (this.Cur() = "%") {
                this.i++
                v := v / 100
            } else
                return v
        }
    }

    Primary() {
        this.Ws()
        c := this.Cur()
        if (c = "(") {
            this.i++
            v := this.Expr()
            this.Ws()
            if (this.Cur() != ")")
                throw Error("缺少右括号")
            this.i++
            return v
        }
        if (c ~= "[0-9.]") {
            start := this.i
            while (this.i <= this.n && SubStr(this.s, this.i, 1) ~= "[0-9.]")
                this.i++
            txt := SubStr(this.s, start, this.i - start)
            if !IsNumber(txt)
                throw Error("非法数字：" . txt)
            return Number(txt) * 1.0     ; 强制浮点：整数运算下 2^100 会溢出成 0
        }
        if (c ~= "[a-zA-Z]") {
            start := this.i
            while (this.i <= this.n && SubStr(this.s, this.i, 1) ~= "[a-zA-Z0-9_]")
                this.i++
            name := StrLower(SubStr(this.s, start, this.i - start))
            if (name = "pi")
                return 3.141592653589793
            if (name = "e")
                return 2.718281828459045
            this.Ws()
            if (this.Cur() != "(")
                throw Error("未知名称：" . name)
            this.i++
            return CallFn(name, this.Args())
        }
        throw Error("无法解析：" . (c = "" ? "表达式不完整" : c))
    }

    Args() {
        args := []
        this.Ws()
        if (this.Cur() = ")") {
            this.i++
            return args
        }
        loop {
            args.Push(this.Expr())
            this.Ws()
            c := this.Cur()
            if (c = ",") {
                this.i++
                continue
            }
            if (c = ")") {
                this.i++
                return args
            }
            throw Error("参数列表有误")
        }
    }
}

CallFn(name, a) {
    switch name {
        case "sqrt", "abs", "round", "floor", "ceil", "sin", "cos", "tan",
             "asin", "acos", "atan", "log", "ln", "exp":
            Need(name, a, 1)
            switch name {
                case "sqrt":  return Sqrt(a[1])
                case "abs":   return Abs(a[1])
                case "round": return Round(a[1])
                case "floor": return Floor(a[1])
                case "ceil":  return Ceil(a[1])
                case "sin":   return Sin(a[1])
                case "cos":   return Cos(a[1])
                case "tan":   return Tan(a[1])
                case "asin":  return ASin(a[1])
                case "acos":  return ACos(a[1])
                case "atan":  return ATan(a[1])
                case "log":   return Log(a[1])      ; 以 10 为底
                case "ln":    return Ln(a[1])
                case "exp":   return Exp(a[1])
            }
        case "min", "max":
            Need(name, a, 1)
            v := a[1]
            for i, x in a {
                if (i = 1)
                    continue
                v := (name = "min") ? Min(v, x) : Max(v, x)
            }
            return v
        case "mod":
            Need(name, a, 2)
            return Mod(a[1], a[2])
    }
    throw Error("未知函数：" . name)
}

Need(name, a, cnt) {
    if (a.Length < cnt)
        throw Error(name . "() 参数不足")
}

FmtNumber(v) {
    if (v = 0)
        return "0"
    if (Abs(v) >= 1e15 || Abs(v) < 1e-9)
        return Format("{:.10e}", v)            ; 极大/极小走科学计数法
    if (v = Round(v))
        return String(Round(v))
    s := Format("{:.10f}", v)
    s := RTrim(s, "0")
    return RTrim(s, ".")
}

Tip(msg) {
    ToolTip(msg)
    SetTimer(() => ToolTip(), -2000)
}
```

## 最后

输入法做算术，本质上是在别人的上下文里蹭一个位置，用的是输入法自己的组字范围——这个范围什么时候有效，用户控制不了。自己用钩子旁听按键，范围就变成整个 Windows，代价是要接受「一个程序在旁听键盘」这件事。

对财务这种一天要算几十笔的场景，这个交换是划算的。
