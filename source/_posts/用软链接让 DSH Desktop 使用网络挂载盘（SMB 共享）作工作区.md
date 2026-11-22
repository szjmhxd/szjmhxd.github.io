---
title: 用软链接让 DSH Desktop 使用网络挂载盘（SMB 共享）作工作区
categories:
  - 工具
  - DSH
tags:
  - DSH Desktop
  - 符号链接
  - SMB
  - 沙箱
  - Windows
  - mklink
abbrlink: dcc80514
date: 2026-10-20 11:39:24
alias: 2026/10/20/用软链接让 DSH Desktop 使用网络挂载盘（SMB 共享）作工作区/index.html
cover: cover.svg
top_img: banner.svg
---

> 适用场景：工程代码放在局域网另一台机器的共享盘上（如 `\\192.168.2.46\szjm-doc`，映射为 `P:`），
> DSH Desktop 选工作区时弹「**NTFS 不能安全用作 DSH Desktop 工作区**」拒绝登记。
> 本文方法已在 Windows 11 + DSH Desktop 2.0.17 实测走通。

---

## 一、快速使用（三步）

```bat
:: ① 建目录符号链接（普通权限即可，需已开启"开发者模式"）
mklink /D "E:\ws\jypt_worker" "P:\jypt_laravel_server_2.0_python_worker"

:: ② DSH 设置 → 文件访问策略 → 切到 Full access（danger-full-access）

:: ③ DSH「选择工作区目录」→ 定位到 E:\ws → 单击选中 jypt_worker（不要双击进入！）→ 选择文件夹
```

第 ③ 步是**最容易做错的一步**：双击进入链接后，Windows 文件夹对话框返回的是解析后的真实路径 `P:\...`，DSH 会再次拒绝。必须在链接的**父目录**里单击选中链接本身。

{% asset_img dsh-select-symlink.png 在 E:\work\07_jianzhu_mall 下单击选中符号链接 246_bgpt_python（图标带快捷方式箭头），不要双击进入 %}


---

## 二、为什么要这样做（原理：两道独立的墙）

DSH 拒绝网络盘不是单一检查，而是两道**互相独立**的关卡：

{% asset_img dsh-two-walls.svg 两道独立的墙：墙 A 卷校验只看字面路径卷根（软链接可绕过），墙 B ACL 沙箱与路径无关（必须关沙箱） %}


### 墙 A：工作区卷校验（决定"能不能登记为工作区"）

DSH 源码（`resources\app\lib\electron-runtime-*.js`，`windows-volume-diagnostics.ts`）的判定逻辑：

| 检查 | 通过条件 | P: 盘实况 |
|---|---|---|
| `GetVolumeInformationW` 文件系统名 | ∈ {NTFS, REFS} | ✅ NTFS（SMB 透传服务端名） |
| `GetDriveTypeW` 盘类型 | = DRIVE_FIXED(3) | ❌ **DRIVE_REMOTE(4)** → 直接 block |

关键点：**这个校验只做字符串路径运算**（取路径的卷根），**不解析符号链接/junction 的真实目标**。
所以把链接放在本地 NTFS 盘上（`E:\ws\jypt_worker`），DSH 看到的卷根是 `E:\` → NTFS + FIXED → **ALLOW**。

### 墙 B：ACL 沙箱（决定"登记后能不能真的读写"）

DSH 的命令沙箱（`workspace-write` 模式）把子进程令牌降为 **Low 完整性 + WRITE_RESTRICTED 受限令牌**。实测在这种令牌下 **SMB 网络盘连读都被 OS 拒绝**：

```
Directory.GetDirectories('P:\')   → 对路径的访问被拒绝
node fs.readdirSync('P:\\')       → EPERM
net use \\server\share            → System error 1223
```

墙 B 与文件策略绑定、与路径写法无关——**软链接骗不过它**。唯一解法是把文件访问策略切到 **Full access**（沙箱整体关闭）。

> ⚠️ **安全警告**：Full access 意味着 agent 执行的命令可以读写你机器上的任何位置（含 `C:\`、凭据文件），这是真实的安全降级。请只在你信任的模型/任务下开启，用完可切回。

### 为什么快捷方式（.lnk）不行

用户实测：DSH 自带的文件夹选择器**根本发现不了快捷方式**。`.lnk` 只是一个存了目标路径的普通文件，需要资源管理器去"解释"；而符号链接是 NTFS reparse point，由**内核直接解析**，所有程序（node、git、DSH）都把它透明当成真实目录。

### 为什么 rclone mount 不行

rclone 挂载卷上报的文件系统名是 `FUSE-rclone`，过不了墙 A 的 {NTFS, REFS} 白名单；即使改名骗过，其 chmod/chown 全是 no-op，DSH 依赖的 NTFS ACL 语义（capability SID、完整性标签）是空壳——骗过检查反而制造"以为有沙箱实际没有"的更危险状态。

---

## 三、前置条件核对

| 条件 | 检查命令 | 期望值 |
|---|---|---|
| 链接所在盘是本地 NTFS | `fsutil fsinfo drivetype E:` | `E: - Fixed Drive` |
| 开发者模式已开（建符号链接免管理员） | `reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense` | `0x1` |
| 网络盘已映射且在线 | `net use P:` | `Status OK` |
| 目标目录存在 | `dir P:\jypt_laravel_server_2.0_python_worker` | 正常列出 |

> 若开发者模式未开：设置 → 系统 → 开发者选项 → 开启"程序包安装"旁的**开发人员模式**。
> 或以管理员身份运行 cmd 再执行 `mklink /D`。

---

## 四、详细步骤

### 1. 建链接

```bat
:: 语法：mklink /D <链接路径> <网络盘上的真实目录>
:: 链接路径必须在本地 NTFS 盘；父目录不存在会自动建
mklink /D "E:\ws\jypt_worker" "P:\jypt_laravel_server_2.0_python_worker"
```

注意事项：
- **不要用 `mklink /J`（junction）**：junction 不支持远程目标，会报 `Local volumes are required to complete the operation.`
- 一个链接对应一个工程目录；建议统一放 `E:\ws\` 下管理。
- 链接目标写 `P:\...` 盘符形式或 `\\IP\share\...` UNC 形式都可以。

### 2. 验证链接可用（可选但推荐）

```bat
:: 用配套 CLI 工具复刻 DSH 的卷判定
python E:\learn\DSH\_symlink_tool\symlink_manager.py check "E:\ws\jypt_worker"
```

期望输出：
```
[DSH 收到该字面路径时]
  ALLOW  root=E:\ fs=NTFS type=DRIVE_FIXED(3) — fixed local NTFS/ReFS
```

再做功能穿透测试（需网络盘在线）：

```bat
dir E:\ws\jypt_worker /b
git -C E:\ws\jypt_worker status
echo test> E:\ws\jypt_worker\_probe.txt & del E:\ws\jypt_worker\_probe.txt
```

### 3. 切换 DSH 文件策略

DSH Desktop → 设置 → **文件访问策略 → Full access**（danger-full-access）。

### 4. 选工作区

打开 DSH「选择工作区目录」对话框：

1. 地址栏输入或逐级导航到 `E:\ws`
2. **单击**选中 `jypt_worker`（图标带快捷方式小箭头是正常的，符号链接在资源管理器里就长这样）
3. 点「选择文件夹」

✅ 成功标志：工作区列表出现 `E:\ws\jypt_worker`，不再弹窗。

❌ 失败自查：如果又弹「NTFS 不能安全用作…」，看弹窗里的路径——若显示的是 `P:\...` 说明你双击进入了链接。重选，这次只单击。也可查 DSH 日志确认：
```
C:\Users\szjm\AppData\Roaming\DSH Desktop\logs\dsh-YYYY-MM-DD.error.log
  → unsafe workspace volume ... path=P:\... driveType=4   （说明收到的是真实路径）
```

{% asset_img dsh-ntfs-blocked.png 未通过卷校验时 DSH 的拒绝弹窗，注意弹窗底部显示的 P:\ ——说明收到的是网络盘真实路径而非本地符号链接 %}


---

## 五、日常维护

| 操作 | 命令 |
|---|---|
| 列出所有链接 | `dir E:\ws /al` 或 `python symlink_manager.py ls E:\ws` |
| 重建失效链接 | `cmd /c rmdir "E:\ws\jypt_worker"` 后重新 `mklink /D` |
| 删除链接 | `cmd /c rmdir "E:\ws\jypt_worker"` （**只删链接，P: 上真实文件不受影响**；绝不要用资源管理器 Shift+Del 或 `rmdir /s`） |
| 一键建工作区链接 | `python E:\learn\DSH\_symlink_tool\symlink_manager.py ws "P:\jypt_laravel_server_2.0_python_worker"` |

配套工具（本仓库 [szjmhxd/symlink-explorer](https://github.com/szjmhxd/symlink-explorer) 也提供）：
- `symlink_manager.py` — CLI：ls / add / rm / check / ws
- `symlink_explorer.py` — GUI：全盘扫描符号链接、DSH 卷校验着色、分类显隐

---

## 六、已知限制

1. **网络盘离线时链接即失效**：`E:\ws\jypt_worker` 的内容完全依赖 `P:`（或底层 SMB 主机）在线。VM 没开机时读写会报 `网络路径不存在`（error 53/67），DSH 会话里表现为命令报错——先 `net use P:` 确认 Status OK。
2. **SMB 断连恢复**：长时间休眠/断网后映射盘可能变 Disconnected，`net use P: /delete /y` 后重新 `net use P: \\<IP>\<share> /persistent:yes`。
3. **性能**：所有文件操作走网络，大仓 git 操作、node_modules 类海量小文件场景明显慢于本地盘。
4. **无沙箱**：Full access 下 agent 命令不受任何文件系统限制（见第二节安全警告）。
5. **换机/改共享名**：链接记录的是目标路径字符串，共享从 `Documents` 改名（如改成 `szjm-doc`）或盘符重映射后，链接会悬空，需按第五节重建。

## 七、更干净的替代方案（不用关沙箱）

| 方案 | 说明 |
|---|---|
| 在共享主机上直接跑 DSH | 如目标机是 Ubuntu VM（Samba 服务端），在其上装 DSH，工程就是本地文件，沙箱完整可用 |
| 本地工作副本 + 单向同步 | 工程放本地 NTFS，`rclone bisync` / `robocopy /MIR` 定时同步回共享（牺牲实时性） |
| iSCSI 块级挂载 | 让 Windows 把远端存储当真硬盘格式化 NTFS，两墙全过且保沙箱；但需独占 LUN、改造存储，重 |

---

*整理：2026-10-20 · 实测环境：Windows 11 (26200) + DSH Desktop 2.0.17 + Samba (Ubuntu szjm-ubu22)*
