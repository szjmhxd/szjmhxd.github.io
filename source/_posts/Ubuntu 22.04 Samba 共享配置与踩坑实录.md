---
title: Ubuntu 22.04 Samba 共享配置与踩坑实录
categories:
  - Linux
  - Samba
tags:
  - Samba
  - SMB
  - Windows
  - 文件共享
  - 排错
abbrlink: 425b83a5
date: 2026-10-21 11:51:25
alias: 2026/10/21/Ubuntu 22.04 Samba 共享配置与踩坑实录/index.html
cover: cover.svg
top_img: banner.svg
---

> 场景：在 VMware 虚拟机 `szjm-ubu22`（Ubuntu 22.04，IP 192.168.2.46）上开启 SMB 共享，把 `~/Documents` 发布出去，Windows 端以映射盘方式访问。全程从"装个 samba"开始，一路踩了 dpkg 锁、Windows 来宾策略、1219 多重连接、匿名枚举、管理员会话盘符分裂等坑，本文按时间线记录问题、根因与解法。

---

## 一、标准配置流程（正确姿势速览）

```bash
# 1. 安装
sudo apt install -y samba

# 2. 添加 SMB 用户（SMB 密码独立于系统密码）
sudo smbpasswd -a szjm

# 3. 编辑 /etc/samba/smb.conf，末尾追加共享段
sudo nano /etc/samba/smb.conf
```

```ini
[szjmDoc]
        path = /home/szjm/Documents
        browseable = yes
        read only = No
        valid users = szjm
        create mask = 0664
        directory mask = 0775
```

```bash
# 4. 验证 + 生效
testparm                        # 语法检查，注意不要 2>/dev/null，错误都在 stderr
sudo systemctl enable --now smbd

# 5. 防火墙（本机 ufw 不活动则跳过）
sudo ufw status && sudo ufw allow Samba

# 6. 自测
smbclient -L //127.0.0.1 -U szjm
smbclient '//127.0.0.1/szjmDoc' -U szjm -c 'ls'
```

Windows 端：

```bat
net use P: \\192.168.2.46\szjmDoc /user:192.168.2.46\szjm /persistent:yes
```

**要点：权限是两层叠加** —— share 层（smb.conf 的 valid users / read only）+ 文件系统层（目录属主/权限）。文件属主就是认证用户时天然通过，不必额外 chown。

---

## 二、踩坑实录

{% asset_img samba-identity.svg 用户名三种写法：裸用户名→降级来宾被策略拦；IP\用户名→服务器身份认证通过；从网络双击→匿名 IPC$ 枚举失败但共享其实是通的 %}


### 坑 1：apt 撞 dpkg 锁 —— unattended-upgrade 批量升级

**现象**：`sudo apt install -y samba` 反复打印

```
正在等待缓存锁：无法获得锁 /var/lib/dpkg/lock-frontend。锁正由进程 70703（unattended-upgr）持有
```

**根因**：Ubuntu 默认的无人值守自动更新（`apt-daily-upgrade.timer`）正在跑一次**半个系统的大批量升级**（libc6、systemd、内核、libreoffice、thunderbird……），dpkg 全局串行，你的安装只能排队。这不是报错，apt 会自动等待。

**判断"真卡死"还是"正常干活"**（三条只读证据，都不碰锁）：

```bash
# ① CPU 时间是否增长：隔 30 秒跑两次，TIME 在涨 = 在干活
ps -o pid,stat,time -p 70703; sleep 30; ps -o time= -p 70703

# ② dpkg 实时日志是否新增行
sudo tail -5 /var/log/unattended-upgrades/unattended-upgrades-dpkg.log

# ③ 子进程是否更新（每配一个包会 fork 新的执行代理）
ps -ef | awk '$3==70703'
```

本次实测：`update-initramfs: Generating /boot/initrd...` 单步 5–10 分钟属正常；整轮大批量升级耗时约 1 小时。

**教训**：

- 千万别在 `dpkg --configure` 中途强杀，会留半损坏状态；
- 实验虚拟机建议直接关掉无人值守升级：

```bash
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer
sudo sed -i 's/Unattended-Upgrade "1"/Unattended-Upgrade "0"/' /etc/apt/apt.conf.d/20auto-upgrades
```

### 坑 2：用 flock 排队安装，结果父子自锁

**错误做法**：

```bash
sudo bash -c 'flock /var/lib/dpkg/lock-frontend apt install -y samba' &
# ❌ flock 父进程持锁后，apt 子进程再申请同一把锁 → 永远等待
```

**正确排队法**（等 unattended-upgrade 自然退出后再装）：

```bash
nohup bash -c 'while pgrep -x unattended-upgrade >/dev/null; do sleep 10; done; apt-get install -y samba' \
  > /tmp/samba-install.log 2>&1 &
```

### 坑 3：Windows 报"组织的策略阻止未经身份验证的来宾访问"

**现象**：资源管理器连 `\\192.168.2.46\documents`，凭据框输入 `szjm` + 密码，红字拒绝。

**根因**：Windows 本机登录账号恰好也叫 `szjm`。凭据框只输裸用户名时，Windows 拿**本机 NTLM 凭据**去撞 Samba → 认证失败 → Samba 的 `map to guest = Bad User` 把它降级成来宾 → 触发 Win10/11 专业版默认组策略"阻止不安全的来宾登录"。

**解法**：用户名必须带服务器前缀，强制走目标机账号：

```bat
net use \\192.168.2.46\szjmDoc /user:192.168.2.46\szjm
:: 或存凭据管理器
cmdkey /add:192.168.2.46 /user:192.168.2.46\szjm /pass:你的SMB密码
```

**不要去开"启用不安全的来宾登录"策略**——那是把门缝撬开，身份还是错的。

### 坑 4：错误 1219 —— 多重连接冲突

**现象**：`不允许一个用户使用一个以上用户名与服务器或共享资源的多重连接`。

**根因**：SMB 协议一个客户端到一台服务器只允许一条会话一个身份。Explorer 浏览网络邻居时已用 guest/本机身份悄悄建了到 192.168.2.46 的会话，再用 szjm 认证就撞车。

**解法**：

```bat
net use * /delete /y
net use \\192.168.2.46\szjmDoc /user:192.168.2.46\szjm
```

**治本**：把 `map to guest = Bad User` 改成 `map to guest = never`，杜绝错误凭据生成幽灵来宾会话（局域网设备每 12 分钟探测一次产生的 nobody 会话即源于此）。

### 坑 5：never 模式的副作用 —— Explorer 双击打不开

**现象**：`net use` 显示 OK，但资源管理器报"Windows 无法访问 \\192.168.2.46\szjmDoc，请检查名称拼写"。

**根因**：Explorer 打开 UNC 路径前会先向服务器 IPC$ 做匿名枚举校验；`never` 模式下匿名 IPC$ 被拒 → Explorer 报"找不到路径"，**尽管已认证的共享会话就在旁边**（`dir \\192.168.2.46\szjmDoc` 命令行完全正常）。

**解法**：绕开枚举，直接走已认证会话——

```bat
net use P: \\192.168.2.46\szjmDoc /user:192.168.2.46\szjm /persistent:yes
```

盘符在 Explorer 里双击打开不触发匿名枚举。日常从盘符进，别从"网络"节点双击服务器图标。

> 折中方案：如果怀念双击浏览，可改回 `map to guest = Bad User`，靠 `valid users = szjm` 守住共享本体（能浏览列表 ≠ 能进共享），安全性不损失。

### 坑 6：映射盘命令行可见、资源管理器不可见（UAC 双会话）

**现象**：`dir P:` 正常列出文件，"此电脑"里却没有 P: 盘。

**根因**：PowerShell 是**以管理员身份运行**的。管理员会话建立的映射盘属于提权登录会话，普通权限的 Explorer 看不见（UAC 双会话隔离）。

**验证**：

```powershell
whoami /groups | findstr /i "S-1-16-12288"   # 有输出 = High Mandatory = 提权会话
```

**解法**：在**普通权限** PowerShell 里 `net use P: /delete /y` 后重新映射，Explorer 立刻显示。

### 坑 7：Webmin 管理 Samba 的两个注意点

装了 Webmin（`https://192.168.2.46:10000`）可视化管理后：

1. **不需要卸载已有 samba**——Webmin 管的就是同一份 `/etc/samba/smb.conf` 和同一个 smbd；
2. **Webmin 保存共享时可能丢失手写的参数**：本次改名 `documents → szjmDoc` 后，`valid users` 和 create/directory mask 全丢了，且一度产生**重复段**（两个 `[szjmDoc]`）。改完务必 `testparm -s | sed -n '/szjmDoc/,/^$/p'` 核对；
3. Webmin 页面上的 "Restart/Stop Samba Servers" 按钮与 systemd 容易互相踩，建议统一用 `sudo systemctl restart smbd`。

---

## 三、最终交付状态

| 项 | 值 |
|---|---|
| 服务器 | szjm-ubu22 (192.168.2.46)，Samba 4.15.13 |
| 共享 | `[szjmDoc]` → `/home/szjm/Documents`，读写，`valid users = szjm` |
| 认证 | `map to guest = never`，仅 SMB2/3 |
| 客户端 | Windows 映射盘 `P:`（`/persistent:yes` 开机自动重连） |
| 管理 | Webmin Samba 模块 + 终端 testparm 核对 |

## 四、排错命令备忘

```bash
# 服务端三连
systemctl is-active smbd
sudo ss -tlnp | grep -E ':(445|139)'
testparm -s | sed -n '/szjmDoc/,/^$/p'

# 会话审计（journalctl 比 log.smbd 全，后者按 log.%m 分文件）
sudo journalctl -u smbd -n 20 --no-pager
sudo tail -20 /var/log/samba/log.<客户端名>

# 客户端
net use                      # 查看现有会话
cmdkey /list | findstr /i "192.168.2.46"   # 检查存储的凭据
```

**一句话总结**：Samba 本身五分钟能配完，剩下的时间全花在 Windows 客户端的身份语义上——**裸用户名 = 本机身份；`IP\用户名` = 服务器身份；来宾降级 = 策略雷区；管理员会话 = 盘符孤岛。**
