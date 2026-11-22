---
title: jypt-server-php 部署排障记录（Docker/1Panel/OpenResty）
categories:
  - 部署运维
  - Laravel
tags:
  - Laravel
  - Docker
  - 1Panel
  - OpenResty
  - PHP
  - 排错
abbrlink: 5cd620c1
date: 2026-10-21 16:00:37
alias: 2026/10/21/jypt-server-php 部署排障记录（Docker-1Panel-OpenResty）/index.html
cover: cover.svg
top_img: banner.svg
---

> 环境：1Panel 面板 + Docker「php8335」（`1panel-php-fpm:8.3.35`）+ OpenResty（`1Panel-openresty-gw6h`）
> 站点目录（同一套代码，两处部署）：
> - `bgpt_python/index/jypt_laravel_server_2.0`（原始部署）
> - `bgpt_laravel/index/jypt_laravel_server_2.0`（复制部署，8900 端口，⑧⑨⑩ 三轮排障都在这套）
>
> Laravel 11.46 / PHP 8.3.35 / Composer 2.10.3。
> artisan/openresty 命令都在 **docker 容器**里执行，宿主机（szjm-ubu22）无 php、无 `/www/sites` 目录。

---

## 一、结论速览（问题的完整链条）

{% asset_img jypt-arch.svg 部署架构：宿主机只有 Docker，OpenResty 与 PHP-FPM 两个容器都挂载 /opt/1panel/www → /www %}


| 阶段 | 报错 | 根因 | 解法 ✅ |
|---|---|---|---|
| ① composer install | 平台不兼容，缺扩展 | PHP 容器缺 `bcmath/gd/sockets/sodium` | 逐个补扩展（sodium 需重建镜像） |
| ② composer install | vendor 装到一半 | 依赖下载/autoload | 补扩展后正常 |
| ③ post-autoload-dump | `artisan package:discover` 退出码 1 | `bootstrap/cache` 目录缺失 | `mkdir -p bootstrap/cache` |
| ④ 访问首页 | `/api/...` 全 404、`GET /` 200 | OpenResty 伪静态缺 `try_files` | 补 `location / { try_files ... }` |
| ⑤ OAuth 登录 | `Invalid key supplied / key path does not exist` | Passport 密钥缺失 | `php artisan passport:keys --force` |
| ⑥ OAuth 登录 | key 仍 `does not exist or is not readable` | 密钥 owner 是 root，FPM 以 www-data 读不了 | `chown www-data` + 600/644 |
| ⑦ 网站根挪到 Documents | 软链后 OpenResty 循环崩溃 | 容器挂载点内软链在容器命名空间断链 | 弃软链，改 bind mount + fstab |
| ⑧ 新站点 bgpt_laravel:8900 全 500（5 字节裸响应），日志却是 `Target class [view] does not exist` | 站点目录复制部署丢了 `bootstrap/cache`（git 不跟踪空目录） | PackageManifest 写缓存失败 → 服务提供者注册阶段抛异常 → 错误处理器渲染响应时 view 尚未注册，级联出**假线索**，连错误页都渲染不出 | `mkdir -p bootstrap/cache` + `package:discover`（见二·7） |
| ⑨ 10-21 复发：同站又全 500，日志仍是 `Class "view" does not exist` | 代码重新拷贝覆盖，空目录又丢；且 `docker exec` 默认 root，root 验证通过掩盖 FPM(www-data) 无写权限 | 重做二·7 修复；验证一律 `-u www-data` 复现 FPM 身份（见二·8） |
| ⑩ 10-21 第二轮：500 消失后登录报 `Invalid key supplied`，`Wrong file:` **后面为空** | `storage/oauth-private.key`/`oauth-public.key` 整个不存在（复制部署一起丢，git 忽略） | 路径是空串 → CryptKey 直接抛异常（权限问题会带出路径报 `not readable`） | `passport:keys --force` + `chown www-data` 600/644（见二·9） |

---

## 二、详细步骤与关键命令

### 1. 补 PHP 扩展（bcmath / gd / sockets / sodium）

`composer install` 报：
- `ext-bcmath` missing
- `lcobucci/jwt 5.5.0 requires ext-sodium`
- `php-amqplib requires ext-sockets`
- `phpspreadsheet requires ext-gd`

进容器补（Debian 系 1Panel 镜像通用）：

```bash
# 宿主机：进 php 容器
sudo docker exec -it php8335 bash
apt-get update
apt-get install -y libpng-dev libjpeg-dev libfreetype6-dev libsodium-dev
# gd 需显式配 freetype/jpeg
docker-php-ext-configure gd --with-freetype --with-jpeg
docker-php-ext-install gd bcmath sockets sodium
php -m | grep -iE "bcmath|gd|sockets|sodium"   # 验证
exit
```

**注意**：若 PHP 是「镜像重建」型（1Panel 面板重建 PHP 镜像），`docker-php-ext-install` 是**一次性容器内生效**，容器重建后会丢——那种情况应把扩展写进 **Dockerfile 构建脚本**再重建镜像。
装完**重启 PHP 容器**。

> 本次 `sodium` 缺失是因为 conf.d 里其它都有了独缺它，走重建镜像补上。

### 2. post-autoload-dump 失败 → 补 bootstrap/cache

`composer install` 到 `Generating optimized autoload files` 后报：

```
Script @php artisan package:discover --ansi handling the post-autoload-dump event returned with error code 1
```

单独跑 `php artisan package:discover --ansi` 得到真实原因：

```
The /www/sites/.../bootstrap/cache directory must be present and writable.
```

**根因**：`bootstrap/cache` 是 Laravel「运行时生成」目录，常在 git 仓库外，全新部署不会自动出现。修复：

```bash
mkdir -p bootstrap/cache
mkdir -p storage/framework/{sessions,views,cache}
chown -R www-data:www-data bootstrap/cache storage/framework
chmod -R ug+w bootstrap/cache storage/framework
php artisan package:discover --ansi   # 应全程 DONE
```

### 3. `/api/xxx` 全 404（首页能开）→ 补 OpenResty 伪静态

症状：`GET /` 返回 200，但 `POST /api/login` 返回 404。
查 `bgpt_python.conf`：

```nginx
# /usr/local/openresty/nginx/conf/conf.d/bgpt_python.conf
index index.php index.html ...;
location ~ [^/]\.php(/|$) { ... }        # 只匹配 .php，没有兜底
```

**根因**：只有 `.php` 的 location，无 `location /` 兜底，所以 `/api/..."` 这类非 .php 路径不匹配任何规则 → 404。
**修复**：在 `.php` location 前加：

```nginx
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
```

重载：`sudo docker exec 1Panel-openresty-gw6h nginx -s reload`
> 1Panel 面板「网站 → 伪静态 → 选 Laravel/ThinkPHP 模板」等效，更省事。

### 4. OAuth Passport 密钥缺失 → 生成

`/api/login` 报：

```
"Invalid key supplied. && Wrong file: .../CryptKey.php"
```

**根因**：Passport 的 `storage/oauth-private.key` / `oauth-public.key` 未生成。在容器内项目目录执行：

```bash
sudo docker exec -it php8335 bash -c \
  'cd /www/sites/bgpt_python/index/jypt_laravel_server_2.0 && php artisan passport:keys --force'
```

> ⚠️ 必须进**项目目录**跑，否则密钥会生成到错误工作目录。
> 首次部署一般用 `php artisan passport:install --force`（生成 key + OAuth 客户端 + 迁移）；若只差 key 用 `passport:keys --force`。

### 5. 密钥生成了仍不可读 → 权限（关键）

key 生成后 `storage/oauth-private.key` owner 是 **root:root 且 600**，而 PHP-FPM 以 **www-data** 运行 → FPM 读不了 → 报 `does not exist or is not readable`。

修复：

```bash
sudo docker exec -it php8335 bash -c '
  cd /www/sites/bgpt_python/index/jypt_laravel_server_2.0
  chown www-data:www-data storage/oauth-private.key storage/oauth-public.key
  chmod 600 storage/oauth-private.key
  chmod 644 storage/oauth-public.key'
```

验证 FPM 用户确实是 www-data：

```bash
sudo docker exec php8335 sh -c 'id www-data; grep -E "^(user|group)" /usr/local/etc/php-fpm.d/www.conf'
```

{% asset_img jypt-passport-perm.svg Passport 密钥权限对比：root 生成(左)时 FPM 读不了 600 私钥报 not readable；chown 给 www-data(右)后正常颁发 token %}


### 6. 网站根软链到 Documents → 容器内断链（OpenResty 循环重启）

需求：把 1Panel 网站根 `/opt/1panel/www/sites` 挪到 `/home/szjm/Documents` 方便直接编辑。宿主机做 `ln -s` 后宿主机一切正常，**但容器里全崩**：

```
nginx: [emerg] open() "/www/sites/bgpt_python/rewrite/bgpt_python.conf" failed (2: No such file or directory)
```
（OpenResty 容器反复 restarting；php 容器 `ls /www/sites` 报不存在。）

**根因**：php/openresty 容器挂载的是整个 `/opt/1panel/www -> /www`（用 `docker inspect <容器> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'` 可确认）。软链存的是**目标路径字符串**，容器进入后在自己的命名空间解析 `/home/szjm/Documents`——容器里根本没有这个路径 → 断链。**结论：容器挂载点内放软链指向挂载范围外的目录，必然失效，必须用 bind mount（宿主机内核解析，容器看到真实目录树）。**

{% asset_img jypt-bind-vs-symlink.svg 软链 vs bind mount：软链在宿主机解析，容器命名空间内看不到挂载范围外的目标 %}


修复（站点文件此前已 `mv` 进 Documents，此处只需替换链接本身）：

```bash
# 1. 删软链、建回空目录（rm 不带尾斜杠，只删链接，不动 Documents 内容）
sudo rm /opt/1panel/www/sites
sudo mkdir /opt/1panel/www/sites

# 2. bind 挂载
sudo mount --bind /home/szjm/Documents /opt/1panel/www/sites

# 3. 持久化（重启不丢）
echo '/home/szjm/Documents /opt/1panel/www/sites none bind 0 0' | sudo tee -a /etc/fstab
sudo mount -a    # 验证 fstab 语法，无输出即对

# 4. 重启容器重新解析 /www
sudo docker restart 1Panel-openresty-gw6h php8335

# 5. 三方验证
ls /opt/1panel/www/sites/
sudo docker exec 1Panel-openresty-gw6h ls /www/sites/
sudo docker exec php8335 ls /www/sites/bgpt_python
```

**权限附带坑**：宿主机没有 `www` 用户，`chown www:www` 报 `invalid user`——服务跑在容器里。先查容器用户：

```bash
sudo docker exec php8335 id www-data
# uid=1000(www-data) —— 恰与宿主机 szjm 的 uid 相同
```

uid 对齐时文件属主保持 `szjm:szjm` 即可（容器内 www-data 按 uid 1000 天然有读写）；无需也不存在 `www` 用户可 chown。另需 `chmod o+x /home/szjm /home/szjm/Documents` 让链路可穿透（uid 不同组成员时）。

> 若两处 uid 不一致（如容器 www-data=33 而宿主机 szjm=1000），则需把站点目录属主改成对应数字 uid，或给容器用户所属组加权限。

### 7. 新站点（复制部署）全 500，日志却报 `view does not exist` → 还是 bootstrap/cache（假线索版）

2026-10-20 部署 `bgpt_laravel/index/jypt_laravel_server_2.0`（8900 端口）复现，症状与 ③ 不同：

```
POST /api/login → 500，响应体只有 5 字节（裸 "500 "），连 Laravel 错误 JSON 都没有
GET  /          → 同样 500
```

laravel.log 里刷的是：

```
Next Illuminate\Container\BindingResolutionException: Target class [view] does not exist.
...
#14 bootstrap/app.php(62): App\Helpers\ResponseHelper::error()
#15 Illuminate\Foundation\Exceptions\Handler->renderViaCallbacks()
```

**读栈方法（关键）**：`view` 是 `ViewServiceProvider` 注册的 binding，解析不到 = **应用在"注册服务提供者"阶段就中断了**。栈里 `HandleExceptions->handleException → Handler->render → bootstrap/app.php 的 ResponseHelper::error() → response() → view 失败` 是**异常处理器渲染错误响应时的二次崩溃**——`view does not exist` 是假线索，原始异常被它盖住（这也是为什么错误页都渲染不出来、只剩 5 字节裸 500）。

**根因**：站点目录是复制/打包来的。`bootstrap/cache` 是 git 不跟踪的空目录，复制后不存在 → `PackageManifest` 写 `packages.php` 时抛 `The .../bootstrap/cache directory must be present and writable.`

{% asset_img jypt-false-clue-chain.svg 假线索级联链：cache 缺失 → PackageManifest 失败 → 注册阶段中断 → 错误页渲染时 view 未注册 → 5 字节裸 500 %}


**定位手段**：在容器里直接跑 `php artisan --version`，启动失败会把**真实根因**打屏，比翻日志快：

```bash
sudo docker exec php8335 bash -c \
  'cd /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0 && php artisan --version'
# In PackageManifest.php line 179:
# The .../bootstrap/cache directory must be present and writable.
```

**修复**（与 ③ 同一套，新站点部署时一次做完）：

```bash
sudo docker exec php8335 bash -c '
  cd /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0 &&
  mkdir -p bootstrap/cache storage/framework/{sessions,views,cache} &&
  chown -R www-data:www-data bootstrap/cache storage &&
  chmod -R ug+w bootstrap/cache storage &&
  php artisan package:discover --ansi'   # 全部包 DONE 即通
```

验证：`php artisan --version` 出 `Laravel Framework 11.46.0` ✅（17 个包全 DONE）。

> **HTTP 测试注意**：该站 8900 监听的是 **http**，用 `curl -k https://...:8900` 会得到 `HTTP 000`——那是连接层失败（https 握手不上），不是应用错误。正确姿势：
>
> ```bash
> curl -s -X POST http://192.168.2.46:8900/api/login \
>   -d "username=admin&password=888888" -w '\nHTTP %{http_code}\n'
> ```

### 8. 复发（2026-10-21）：docker exec 默认 root，别被「CLI 通过」骗了

10-20 按二·7 修复并验证后，10-21 同站再次全 500，日志签名一模一样（5 字节裸 500 + `ReflectionException: Class "view" does not exist`）。复发只有两种常见成因：

1. **代码又被拷贝/覆盖了一遍**：`bootstrap/cache` 是 git 不跟踪的空目录，从 Windows 共享或打包重新复制一次，它就再丢一次。
2. **验证身份不对**：`docker exec php8335` 默认以 **root** 进入，root 对任何目录都可写；而 PHP-FPM 以 **www-data** 运行（`uid=1000`）。若目录或密钥是 root 建的（属主 `0:0`），CLI 里 `artisan --version` 一路绿灯，网页却照样 500——上次的「验证通过」可能是假阳性。本项目的真实案例见二·5：Passport 私钥 `600 root:root`，CLI 能读、FPM 读不了，报 `does not exist or is not readable`。**所以复验时务必带上 `-u www-data` 以复现 FPM 身份。**

正确验证姿势——用 www-data 身份复现 FPM：

```bash
sudo docker exec -u www-data php8335 bash -c \
  'cd /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0 && php artisan --version'

# 看数字属主/权限（容器 www-data uid=1000）
sudo docker exec php8335 ls -ldn \
  /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0/bootstrap/cache
```

缺目录或属主是 root → 重做二·7 的 mkdir/chown/chmod/package:discover 一套，然后**仍用 `-u www-data` 复验**，并 curl 走一遍真实 HTTP。

> Windows 侧捷径：若 szjmDoc 共享就是 bind 到 sites 的那个 Documents 目录，可直接 `mkdir \\<ip>\szjmDoc\bgpt_laravel\index\jypt_laravel_server_2.0\bootstrap\cache`（SMB 建的文件属主 szjm=uid1000，容器内 www-data 天然可写），再进容器跑 `package:discover` 即可。

### 9. 第二轮（2026-10-21）：cache 修好后登录报 `Invalid key supplied` → `storage/oauth-*.key` 也丢了

⑨ 修完 `bootstrap/cache`（`package:discover` 17 包全 DONE），`POST /api/login` 换成新错误：

```json
{"success":false,"code":40000,"message":"Invalid key supplied. && Wrong file: in .../vendor/league/oauth2-server/src/CryptKey.php at 67 line","data":null}
```

**判读要点：`Wrong file:` 后面是空的** —— 说明 CryptKey 收到的 key 路径是**空串**，即文件根本不存在。（若是 ⑥ 那种权限问题，路径会原样带出来并报 `does not exist or is not readable`。）

确认：

```bash
sudo docker exec php8335 ls -l /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0/storage/oauth-*.key
# ls: cannot access '.../storage/oauth-*.key': No such file or directory
```

同一轮还确认了 `.env` **没丢**（`APP_KEY` 在、属主 www-data），所以只差 key，不需要 `key:generate`：

```bash
sudo docker exec php8335 bash -c \
  'cd /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0 && ls -l .env && grep -E "^(APP_KEY|APP_ENV|APP_DEBUG)=" .env'
```

修复：

```bash
sudo docker exec php8335 bash -c '
  cd /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0 &&
  php artisan passport:keys --force &&
  chown www-data:www-data storage/oauth-private.key storage/oauth-public.key &&
  chmod 600 storage/oauth-private.key &&
  chmod 644 storage/oauth-public.key &&
  ls -l storage/oauth-*.key'
#   INFO  Encryption keys generated successfully.
# -rw------- 1 www-data www-data 3318 Oct 21 07:53 storage/oauth-private.key
# -rw-r--r-- 1 www-data www-data  812 Oct 21 07:53 storage/oauth-public.key
```

复验（仍是 www-data 身份）：

```bash
sudo docker exec -u www-data php8335 bash -c \
  'cd /www/sites/bgpt_laravel/index/jypt_laravel_server_2.0 &&
   head -c 31 storage/oauth-private.key; echo; php artisan --version'
# -----BEGIN PRIVATE KEY-----
# Laravel Framework 11.46.0
```

> **别拿老教程的头部当校验标准**：Laravel 11 的 `passport:keys` 生成 **PKCS#8**（`-----BEGIN PRIVATE KEY-----`），不是 `-----BEGIN RSA PRIVATE KEY-----`。

修复后 curl 变成：

```json
{"success":false,"code":40000,"message":"用户名或密码错误. && Wrong file: in .../app/Services/AdminsService.php at 70 line","data":null}
HTTP 200
```

**这条尾巴怎么读（本环境专用技巧）**：`&& Wrong file: ... at N line` **不是 Passport 的报错**，是应用自己的 `ResponseHelper::error()` 在 message 后面拼的调试尾巴。用两个维度就能判断链路走到哪：

| 尾巴里的文件 | HTTP | 含义 |
|---|---|---|
| `vendor/.../CryptKey.php` | 500 或 40000 | 基础设施没通（key 缺失/不可读/空路径） |
| `app/Services/*.php` | 200 | **已进业务逻辑**，剩下的就是业务判断（本例＝账号密码不对） |

也就是说：看到尾巴换成 `Services/*.php` 且 HTTP 200，配置层面的活就干完了，别再去翻 key。

> ⚠️ `passport:keys --force` 会**重写密钥**，等于让所有旧 access_token 立即失效；已在用的线上站点别无脑跑。前端若缓存了 token，清 localStorage 重新登录即可。

---

## 三、注意事项 / 提醒

1. **路径分层**：宿主机**没有** `/www/sites`（本次 `cd` 失败已证明）。`/www/sites/...` 只看得到容器层，artisan 等命令**必须 docker exec 进 php8335**；宿主机用 `sudo docker`（szjm 不在 docker 组）。
2. **`.env` 缺失别忘了**：本次 `.env` 不存在，只差把 `.env.example` 复制并填真实 DB/Redis/APP_KEY。Passport/DB/queue 配置都靠它，上线前务必补：`cp .env.example .env && php artisan key:generate --force`，DB_/REDIS_ 按 1Panel 该站点实际配置填，再 `php artisan config:clear`。
3. **`composer install` 无 unzip 提示**：容器里没 unzip，composer 用 PHP zip 解包会丢可执行权限位；遇到 `vendor/bin/*` 权限错可 `apt-get install -y unzip` 后重跑。
4. **伪静态**：Laravel/ThinkPHP 站点必须配 `try_files`，否则只有首页通、`/api` 等子路径全 404。
5. **Passport 密钥权限**：务必 `chown www-data` + `chmod 600/644`，否则 FPM 读不了。
6. **目录迁移用 bind 不用软链**：宿主机 `ln -s` 出的软链在容器命名空间解析不到目标路径（断链）。改网站根位置一律走 `mount --bind` + fstab，并 `docker restart` 相关容器；`docker inspect` 确认挂载粒度（本环境是 `/opt/1panel/www` 整层挂载）。
7. **整个 sites = Documents 的暴露面**：Documents 下任何文件都进入 web 根可达范围，勿放敏感内容；只想挪个别站点时可改单站点软链/bind 子目录。
8. **宿主机无 www/www-data 用户**：容器化部署里 `chown www:www` 必报错；先 `docker exec <容器> id www-data` 查数字 UID，宿主机按 uid 设属主（本环境容器 www-data uid=1000 = 宿主机 szjm，属主保持 szjm:szjm 即可）。
9. **复制/打包部署的站点，首查 `bootstrap/cache`**：git 不跟踪空目录，复制必丢。缺它时 500 响应体只有几个字节、日志末尾是 `Target class [view] does not exist` 之类的**级联假线索**——别顺着 view 查，直接在容器里 `php artisan --version` 看真实报错（见二·7）。
10. **`curl` 返回 `HTTP 000` 是连接失败**（协议/端口/监听不对），与 404/500 的应用层错误是两回事；先确认站点是 http 还是 https。
11. **验证 FPM 行为一律 `docker exec -u www-data`**：`docker exec` 默认 root，root 能写不代表 www-data 能写；复制覆盖代码后 `bootstrap/cache` 会再丢，修复后须用 www-data 身份复验（见二·8）。
12. **复制部署一次会丢三样东西**：`bootstrap/cache/`、`storage/framework/{sessions,views,cache}`、`storage/oauth-*.key`——都不被 git 跟踪（前者是空目录，后者被 .gitignore）。新站上线按四节的「五步收尾」一次做完，别等报错再一个个补。
13. **`message` 里的 `Xxx.php at N line` 是应用自己拼的**（`ResponseHelper::error()` 追加），同一个 `code:40000` 可能来自框架层也可能来自业务层。用「文件在 `vendor/` 还是 `app/`」+「HTTP 状态码」两个维度判断链路走到哪一步，比盯错误码有效（见二·9）。
14. **`passport:keys` 生成的是 PKCS#8**：头部 `-----BEGIN PRIVATE KEY-----`，不是 `RSA PRIVATE KEY`；别因为头部不符就以为 generation 失败。
15. **`APP_DEBUG=true` 是把双刃剑**：本次能一眼看到 `CryptKey.php at 67 line` 全靠它（`APP_ENV=local`）。8900 若对其他同事/外网开放，上线前改 `APP_ENV=production` + `APP_DEBUG=false`，否则异常会把堆栈、路径、SQL 一起吐给浏览器。

---

## 四、最终验证清单

### 复制部署后的固定五步收尾（幂等，可重复执行）

```bash
# ①目录 ②权限 ③包发现 ④Passport key ⑤www-data 身份复验
sudo docker exec php8335 bash -c '
  cd /www/sites/<站点>/index/jypt_laravel_server_2.0 &&
  mkdir -p bootstrap/cache storage/framework/{sessions,views,cache} &&
  chown -R www-data:www-data bootstrap/cache storage &&
  chmod -R ug+w bootstrap/cache storage &&
  php artisan package:discover --ansi &&
  php artisan passport:keys --force &&
  chown www-data:www-data storage/oauth-private.key storage/oauth-public.key &&
  chmod 600 storage/oauth-private.key &&
  chmod 644 storage/oauth-public.key &&
  ls -l storage/oauth-*.key'

sudo docker exec -u www-data php8335 bash -c \
  'cd /www/sites/<站点>/index/jypt_laravel_server_2.0 && php artisan --version'
```

> 已在跑且 token 在用的站点：④ 的 `passport:keys --force` 换成 `ls -l storage/oauth-*.key` 只做检查，别重生成。

### 容器内检查

```bash
php -m | grep -iE "bcmath|gd|sockets|sodium"   # 4 扩展都在
ls -la storage/oauth-*.key                      # owner=www-data, 600/644
php artisan route:list --path=login             # 有 POST api/login
```
```http
POST /api/login        # 应返回业务 JSON，不再是 500 / CryptKey.php / 404
GET  /                 # 200 正常页面
```

### 目录迁移（bind mount）后追加

```bash
findmnt -t bind /opt/1panel/www/sites        # 应显示 /home/szjm/Documents 的 bind 挂载
mount -a && echo fstab-ok                     # fstab 无语法错误
sudo docker ps | grep -E "openresty|php"     # 两容器 Up 且无 Restarting
sudo docker exec 1Panel-openresty-gw6h ls /www/sites/   # 站点齐全
sudo docker logs --tail 5 1Panel-openresty-gw6h          # 无 [emerg]
```

---

## 五、本次排障时间线（2026-10-21）

| 时刻 | 动作 | 结果 |
|---|---|---|
| 15:23 | 8900 站全 500，日志 `Class "view" does not exist` | 判定为 ⑧ 同类问题 |
| 15:5x | `ls bootstrap/cache` → No such file | 成因 1️⃣ 实锤（覆盖丢目录） |
| 16:0x | `mkdir` + `chown www-data` + `package:discover` | 17 包全 DONE，`artisan --version` 正常 |
| 16:1x | curl 登录 → `Invalid key supplied`，`Wrong file:` 空 | 判定 `oauth-*.key` 不存在 |
| 16:2x | `passport:keys --force` + chown www-data + 600/644 | key 生成，www-data 可读 |
| 16:3x | curl 登录 → `用户名或密码错误` + `AdminsService.php at 70` | HTTP 200，**链路已通**，仅剩账号问题 |
