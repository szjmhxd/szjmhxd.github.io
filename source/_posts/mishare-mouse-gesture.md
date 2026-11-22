---
title: 小米妙享的投屏窗口没有右键返回，我用 AutoHotkey 补了一套鼠标手势
date: 2026-11-22 15:45:00
updated: 2026-11-22 15:45:00
description: 妙享桌面自带 Alt+B / Alt+H / Alt+R，但每次都要摸键盘。用 AutoHotkey v2 把手势翻译成这三个快捷键，顺带记下两个坑：快捷键是窗口级的、吞掉按键后窗口不会自己激活。
categories:
  - 开发工具
tags:
  - AutoHotkey
  - 小米妙享
  - 开源
  - Windows
cover: cover.svg
top_img: banner.svg
abbrlink: 3f7c9a21
---

手机投屏到电脑这件事，我有两套工具在轮换用：scrcpy 系（现在主要是 qtscrcpy）和小米妙享。

scrcpy 那边的操作是肌肉记忆：右键返回、中键回桌面、`Ctrl+滚轮` 捏合缩放。妙享的画面更清楚、延迟更低、连接也更省事，但它把这几个手势全丢了——鼠标在投屏窗口里只能点、能滚，想返回得把手机拿起来，或者去点窗口边缘的虚拟导航栏。

这篇记录的是怎么在不改妙享、不注入进程、不依赖 adb 的前提下，把「右键返回、中键回桌面」这套操作补回来。

## 先把需求钉死

不是「给妙享加功能」，而是三条具体要求：

| 需求 | 说明 |
| --- | --- |
| 右键短按 = 返回 | 和 scrcpy 一致，不需要看键盘 |
| 中键短按 = 回桌面 | 同上 |
| 不干扰原有操作 | 左键点击、滚轮滚动、右键在窗口外弹菜单，全部保持原样 |

「不改原程序」是硬约束。妙享是装在 `C:\Program Files\MI\` 下的商业软件，注入 DLL 或者打补丁，升级一次就失效，出问题还不好排查。

## 妙享其实已经有一半

翻「小米电脑管家 → 工具 → 妙享桌面」的设置页，会发现三个键盘快捷键：

{% asset_img mishare-shortcuts.png 妙享桌面自带的三个快捷键 %}

`Alt+B` 返回上级、`Alt+H` 回到桌面、`Alt+R` 切换到最近任务。功能是全的，缺的只是「别让我摸键盘」。

那思路就很清楚了：**让鼠标手势去模拟这三个快捷键**。不需要碰协议，不需要模拟触控，只要在正确的时候把一个键盘事件送到正确的窗口。

这件事用 AutoHotkey v2 做最省事：全局鼠标钩子 + 按键发送，一个文件，双击就跑。

{% asset_img gesture-map.png 最终的手势映射 %}

## 坑一：这三个快捷键是窗口级的

第一版脚本写完，右键按下去毫无反应。

一开始怀疑是快捷键被别的程序抢了，后来做了个对照实验：先用 adb 把手机切到设置页，再分别在有窗口焦点 / 没有窗口焦点的情况下发一次 `Alt+B`，每次都用 `screencap` 截图比对手机画面。

结果很干脆：

| 条件 | 手机反应 |
| --- | --- |
| 妙享窗口在前台 | 设置页被返回掉，回到上一个应用 |
| 妙享窗口不在前台 | 画面完全没变化 |

也就是说，妙享注册的这三个快捷键**只在它的窗口处于激活状态时才响应**。这跟「全局热键」是两回事，用 `RegisterHotKey` 注册的热键在后台也照样触发，妙享明显不是这么实现的。

## 坑二：吞掉鼠标按键，窗口就不会自己激活

知道要先激活窗口，于是加了 `WinActivate`。但接着发现，正常右键点击妙享窗口时，窗口本来应该被这次点击激活——而脚本把这个按键吞掉了，窗口收不到 `WM_MOUSEACTIVATE`，所以它一直是失焦状态。

结论：**先激活，再发键**，两步都不能省。

窗口已经在前台时直接发；不在前台时 `WinActivate` 加 `WinWaitActive` 等 250ms，还抢不到就退到 `AttachThreadInput` 的老办法，把自己挂到当前前台线程上再 `SetForegroundWindow`。

## 坑三：怎么判断鼠标在投屏画面上

不能整窗拦截，否则标题栏、工具栏上的右键菜单全废了。

妙享的窗口结构是这样的：

| 窗口 / 控件 | 类名 | 作用 |
| --- | --- | --- |
| 主窗口 | `kMiScreenShareMainWindow` | 整个投屏窗口 |
| 画面层 | `kMiChildSharedWindow` | 手机画面本体 |
| 覆盖层 | `kMiChildMessage`、`kMiChildAction` | 画在画面上的提示与操作层 |

坑在 `MouseGetPos`：它返回的窗口句柄是**顶层窗口**，覆盖在画面上的子窗口被当成「控件」处理。所以既要判断顶层窗口类名是不是妙享，又要判断光标命中的控件类名是不是 `kMiChild*`：

```ahk
OverMirror() {
    MouseGetPos(&mx, &my, &hwnd, &ctrl)
    if (ClassName(hwnd) != MAIN_CLASS)     ; 被别的窗口遮住 / 在妙享窗口外
        return false
    if (SubStr(ctrl, 1, StrLen(CHILD_PREFIX)) = CHILD_PREFIX)
        return true
    return InSharedRect(hwnd, mx, my)      ; 兜底：按画面矩形判断
}
```

最后一行是兜底：万一某个版本换了子窗口类名，就退回「点是否落在 `kMiChildSharedWindow` 的矩形里」。

顺带一个好处：`MouseGetPos` 返回的窗口本身受 z-order 影响，所以妙享被浏览器挡住时，右键会正常交给浏览器，不会误触发。

{% asset_img gesture-flow.png 一次按键的完整判定过程 %}

## 最近任务为什么用长按而不是双击

三个动作只有两个鼠标键可用，第三个必须复用。双击是最直觉的选择，但它有个绕不过去的代价：

双击要求「第一次点击」不能立刻执行动作，否则双击的第一下就已经返回了。所以返回必须推迟到双击判定窗口结束（约 250ms）才敢发出去。也就是说，**每次返回都要多等四分之一秒**，这个延迟是能明显感觉到的。

长按没有这个问题：短按立即返回，按住到 400ms 才触发最近任务，松手时不会再补发一次返回。

| 方案 | 返回延迟 | 额外代价 |
| --- | --- | --- |
| 长按触发 | 0 | 无 |
| 双击触发 | +250ms | 每次返回都变钝 |

脚本里两种模式都留着，`RECENT_MODE := "hold"` 是默认值，改成 `"dbl"` 就切到双击。

## 侧键为什么要注释掉

本来还绑了鼠标侧键（`XButton1` 后退、`XButton2` 前进），结果发现多数人的鼠标驱动里侧键已经被宏占用了，脚本和驱动会打架。这两个键在脚本里留着注释开关，谁需要谁自己打开。

## 完整代码

```ahk
#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; ============================================================================
;  小米妙享「跨屏协作」鼠标手势补丁
;
;  右键短按 = 返回上级      右键长按 = 最近任务
;  中键短按 = 回到桌面      中键长按 = 最近任务
;
;  原理：把手势翻译成妙享自带的快捷键方案，不注入进程、不改原程序。
;  妙享这三个快捷键是「窗口级」的，只有窗口处于激活状态才响应，
;  所以脚本发键前会先把妙享窗口激活（等效于你平时用鼠标点它一下）。
;
;  快捷键在 小米电脑管家 → 工具 → 妙享桌面 里可以改，
;  改了就把下面三行同步改掉（! = Alt，^ = Ctrl，# = Win，+ = Shift）。
;
;  只在光标位于投屏画面内时生效；标题栏、工具栏、被其他窗口遮住时不接管。
; ============================================================================

KEY_BACK   := "!b"     ; 返回上级
KEY_HOME   := "!h"     ; 回到桌面
KEY_RECENT := "!r"     ; 最近任务

; 最近任务的触发方式：
;   "hold" = 长按触发（默认，短按动作零延迟）
;   "dbl"  = 双击触发（短按动作要等 DBL_MS 才出手，返回会变慢）
RECENT_MODE := "hold"
HOLD_MS := 400         ; 长按判定阈值（毫秒），嫌慢就调小
DBL_MS  := 250         ; 双击间隔窗口（毫秒），仅 dbl 模式用

MAIN_CLASS   := "kMiScreenShareMainWindow"   ; 妙享主窗口类名
CHILD_PREFIX := "kMiChild"                   ; 画面子窗口类名前缀
SHARED_CLASS := "kMiChildSharedWindow"       ; 投屏画面层

; ---------------------------------------------------------------- 鼠标映射
; 侧键（XButton1/XButton2）已被鼠标宏占用，这里不接管。
; 想让脚本接管，把下面两行前面的分号去掉：
;   XButton1::Fire(KEY_BACK)
;   XButton2::Fire(KEY_RECENT)

#HotIf OverMirror()
RButton::PressOrHold(KEY_BACK, KEY_RECENT)
MButton::PressOrHold(KEY_HOME, KEY_RECENT)
#HotIf

; ---------------------------------------------------------------- 手势判定
PressOrHold(shortKey, longKey) {
    global RECENT_MODE, HOLD_MS, DBL_MS
    btn := A_ThisHotkey
    ; 按下那一刻就被吞掉了，这里靠物理按键状态自己计时

    if (RECENT_MODE = "dbl") {
        KeyWait btn
        t0 := A_TickCount
        while (A_TickCount - t0 < DBL_MS) {
            if GetKeyState(btn, "P") {
                KeyWait btn
                Fire(longKey)
                return
            }
            Sleep 10
        }
        Fire(shortKey)
        return
    }

    t0 := A_TickCount
    while GetKeyState(btn, "P") {
        if (A_TickCount - t0 >= HOLD_MS) {
            Fire(longKey)      ; 到阈值立刻出手，不等松手
            KeyWait btn
            return
        }
        Sleep 10
    }
    Fire(shortKey)
}

; ---------------------------------------------------------------- 核心逻辑
Fire(key) {
    global MAIN_CLASS
    h := WinExist("ahk_class " MAIN_CLASS)
    if !h
        return
    EnsureActive(h)
    Send(key)
}

EnsureActive(h) {
    if WinActive("ahk_id " h)
        return
    ; 鼠标按键被吞掉了，窗口收不到 WM_MOUSEACTIVATE，得手动激活
    WinActivate "ahk_id " h
    if WinWaitActive("ahk_id " h, , 0.25)
        return
    ; 前台锁兜底：挂到当前前台线程上再抢
    fg := DllCall("GetForegroundWindow", "Ptr")
    tidFg := DllCall("GetWindowThreadProcessId", "Ptr", fg, "Ptr", 0, "UInt")
    tidMe := DllCall("GetCurrentThreadId", "UInt")
    DllCall("AttachThreadInput", "UInt", tidFg, "UInt", tidMe, "Int", 1)
    DllCall("SetForegroundWindow", "Ptr", h)
    DllCall("AttachThreadInput", "UInt", tidFg, "UInt", tidMe, "Int", 0)
    Sleep 30
}

; 光标是否在投屏画面上
OverMirror() {
    global MAIN_CLASS, CHILD_PREFIX
    MouseGetPos(&mx, &my, &hwnd, &ctrl)
    if (ClassName(hwnd) != MAIN_CLASS)     ; 被别的窗口遮住 / 在妙享窗口外
        return false
    if (SubStr(ctrl, 1, StrLen(CHILD_PREFIX)) = CHILD_PREFIX)
        return true
    return InSharedRect(hwnd, mx, my)      ; 兜底：按画面矩形判断
}

InSharedRect(hMain, x, y) {
    global SHARED_CLASS
    hChild := DllCall("FindWindowExW", "Ptr", hMain, "Ptr", 0, "Str", SHARED_CLASS, "Ptr", 0, "Ptr")
    if !hChild
        return false
    r := Buffer(16, 0)
    DllCall("GetWindowRect", "Ptr", hChild, "Ptr", r)
    left := NumGet(r, 0, "Int"), top := NumGet(r, 4, "Int")
    right := NumGet(r, 8, "Int"), bottom := NumGet(r, 12, "Int")
    return (x >= left && x < right && y >= top && y < bottom)
}

ClassName(h) {
    buf := Buffer(256, 0)
    DllCall("GetClassNameW", "Ptr", h, "Ptr", buf, "Int", 128)
    return StrGet(buf, "UTF-16")
}

; ---------------------------------------------------------------- 托盘菜单
Paused := false

A_TrayMenu.Delete()
A_TrayMenu.Add("启用/暂停", (*) => TogglePause())
A_TrayMenu.Add("重载脚本", (*) => Reload())
A_TrayMenu.Add()
A_TrayMenu.Add("退出", (*) => ExitApp())

TogglePause() {
    global Paused
    Paused := !Paused
    Suspend(Paused)
    A_TrayMenu.ToggleCheck("启用/暂停")
    TrayTip(Paused ? "鼠标手势已暂停" : "鼠标手势已启用", "小米妙享")
}

TrayTip("妙享鼠标手势：右键返回 / 右键长按最近任务 / 中键桌面", "小米妙享")
```

## 用法

1. 装 [AutoHotkey v2.0](https://www.autohotkey.com/)（**不是 v1**，脚本第一行有 `#Requires AutoHotkey v2.0`）
2. 双击 `MiShareGesture.ahk`
3. 打开妙享桌面，鼠标移到投屏画面上，右键试试

要常驻就按 `Win+R` 输入 `shell:startup`，把脚本的快捷方式丢进去。托盘图标右键可以暂停、重载、退出。

代码和说明都放在这里：

- 仓库：<https://github.com/szjmhxd/ahk-scripts>
- 脚本目录：[`MiShareGesture/`](https://github.com/szjmhxd/ahk-scripts/tree/main/MiShareGesture)

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `RECENT_MODE` | `"hold"` | `hold` 长按触发；`dbl` 双击触发 |
| `HOLD_MS` | `400` | 长按阈值，嫌迟钝就改小 |
| `DBL_MS` | `250` | 双击间隔窗口，仅 `dbl` 模式用 |

## 还没做到的那件事

scrcpy 上我还常用 `Ctrl+滚轮` 做捏合缩放。这套手势在妙享上**做不出来**——查下来妙享的输入协议里只有一个指针的坐标，没有第二个触点的位置可放。

试过的思路和最终卡在哪，另开一篇写。
