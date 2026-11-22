---
title: 使用Docker部署RustDesk服务器
categories:
  - 技术教程
tags:
  - Docker
  - RustDesk
  - 远程桌面
abbrlink: a4aa3bb4
date: 2025-12-23 10:57:29
updated: 2025-12-23 10:58:20
alias: 2025/12/23/使用Docker部署RustDesk服务器/index.html
cover: cover.svg
top_img: banner.svg
---
RustDesk是一款开源远程桌面软件，本文将详细介绍如何使用Docker部署RustDesk服务器及其API服务。

## 一、准备工作

### 1. 环境要求

- Docker 和 Docker Compose
- 服务器一台
- 域名或公网IP地址

### 2. 相关资源

- RustDesk API项目：[lejianwen/rustdesk-api](https://github.com/lejianwen/rustdesk-api) (官方免费版不支持web api，无法登录和管理)
- 官方文档：[Use Docker With Rustdesk-Server-S6](https://github.com/lejianwen/rustdesk-api/wiki/Use-Docker-With-Rustdesk-Server-S6)

## 二、部署步骤

### 1. 创建Docker Compose文件

提供了直接自定义key的方法，还需要修改一些配置。我选择`直接替换key文件`的方式：

```yaml
networks:
  rustdesk-net:
    external: false

services:
  rustdesk-server:
    container_name: rustdesk-server
    ports:
      - 21115:21115
      - 21116:21116
      - 21116:21116/udp
      - 21117:21117
      - 21118:21118
      - 21119:21119
    image: rustdesk/rustdesk-server-s6:latest
    environment:
      - RELAY=<server[:21117]>
      - ENCRYPTED_ONLY=1
    volumes:
      - /data/rustdesk/server:/data
    restart: unless-stopped

  rustdesk-api:
    container_name: rustdesk-api
    ports:
      - 21114:21114
    image: lejianwen/rustdesk-api
    environment:
      - TZ=Asia/Shanghai
      - RUSTDESK_API_RUSTDESK_ID_SERVER=<server[:21116]> # 21116端口
      - RUSTDESK_API_RUSTDESK_RELAY_SERVER=<server[:21117]> # 21117端口
      - RUSTDESK_API_RUSTDESK_API_SERVER=http://<server[:21114]> # 21114端口
      #- RUSTDESK_API_RUSTDESK_KEY=<key> # 可选：直接指定key
    volumes:
      - /data/rustdesk/api:/app/data # 将数据库挂载
      - /data/rustdesk/server:/app/conf/data # 挂载key文件到api容器，可不用设置RUSTDESK_API_RUSTDESK_KEY
    networks:
      - rustdesk-net
    restart: unless-stopped
    depends_on:
      - rustdesk-server
```

## 三、使用指南

### 1. 客户端连接

启动服务后，可以在日志中看到生成的`key`

{% asset_img image-20251223105729175.png image-20251223105729175.png %}

#### 客户端设置

直接使用官方客户端就行

高手可以试试用github生成自己的客户端(可以把配置信息写进入)

- id服务器/中继服务器  直接使用IP即可
- api服务器  需要使用 http+ip+端口的格式
- key  就是刚才日志里显示的key

{% asset_img image-20251223105820499.png image-20251223105820499.png %}

### 2. 登录

这个镜像的默认密码是 admin admin

可以访问 `ip:21114` 端口登录web界面，也可以在客户端登录

### 3. CLI设置

比较重要的设置是重置admin密码：

```bash
# 查看帮助
./apimain -h
```

#### 重置管理员密码

```bash
./apimain reset-admin-pwd <pwd>
```

#### 帮助信息

```bash
/app # ./apimain -h
RUSTDESK API SERVER

Usage:
  apimain [flags]
  apimain [command]

Available Commands:
  completion      Generate the autocompletion script for the specified shell
  help            Help about any command
  reset-admin-pwd Reset Admin Password
  reset-pwd       Reset User Password

Flags:
  -c, --config string   choose config file (default "./conf/config.yaml")
  -h, --help            help for apimain

Use "apimain [command] --help" for more information about a command.
/app # ./apimain reset-admin-pwd --help
Reset Admin Password

Usage:
  apimain reset-admin-pwd [pwd] [flags]

Examples:
reset-admin-pwd 123456

Flags:
  -h, --help   help for reset-admin-pwd

Global Flags:
  -c, --config string   choose config file (default "./conf/config.yaml")
/app #
```

## 四、备份策略

如果之前设置了文件映射，可以直接备份映射目录，比如我的文件位置在 `/data/rustdesk/server`

```yaml
volumes:
  - /data/rustdesk/server:/data
```

如果之前没有备份过，可以在宿主机使用以下命令从容器中复制数据，然后在新服务器上恢复：

```bash
# 基础命令：将rustdesk容器的/data目录备份到宿主机/root/rustdesk_backup/目录（自动创建目录）
mkdir -p /root/rustdesk_backup &&
docker cp <你的容器名称>:/data /root/rustdesk_backup/
```

## 五、总结

通过Docker部署RustDesk服务器和API服务，可以快速搭建一个安全可靠的远程桌面解决方案。Docker容器化部署使得管理和扩展变得更加简单，适合个人和企业使用。

---

**参考资料：**

- [rustdesk-api GitHub仓库](https://github.com/lejianwen/rustdesk-api)
- [使用Docker部署文档](https://github.com/lejianwen/rustdesk-api/wiki/Use-Docker-With-Rustdesk-Server-S6)
