# LifeUp 跨网 MCP 操作手册

> **无公网 IP、无 sudo 的家用 Linux + 手机 LifeUp（人升）App，在任意网络下（家中 WiFi / 蜂窝流量 / 异地）通过 AI Agent 调用 LifeUp MCP 的完整方案。**
>
> 基于官方 Tailscale 客户端 + 免 root 的 userspace tailscaled + 本地 TCP 中继，全程加密、不向公网暴露任何 LifeUp 端口。

---

## 1. 问题背景

[LifeUp（人升）](https://lifeupapp.fun/) 的 MCP 接口（`@lifeup/mcp`）依赖手机端开启「LifeUp Cloud」HTTP 服务（默认端口 `13276`）。该服务**只监听局域网**，因此 MCP 客户端（跑在家用服务器上的 AI Agent）必须与手机处于同一局域网。

手机一离开家（蜂窝流量 / 外出），家用服务器就再也找不到手机，AI 无法继续操作 LifeUp。

```
手机(流量) ──✗──> 家用服务器上的 Agent ──MCP──> 手机 LifeUp:13276   ← 断点
```

**核心认知**：Agent 服务本身可通过 Cloudflare Tunnel 等暴露公网、从任何网络访问——真正断掉的只有「服务器 → 手机」这最后一跳。本手册解决的就是这一跳。

## 2. 方案选型

| 方案 | 结论 |
|---|---|
| **Tailscale 私有虚拟网** ✅ 采用 | 手机官方 App（Android VPN 服务，常驻稳定）；服务器端免 root userspace 模式；全程 WireGuard 加密；LifeUp 无鉴权端口**不暴露公网** |
| nginx 反向代理 | ❌ 反向代理前提是「代理能主动连上上游」，无法创造网络可达性，解决不了"找到手机"的问题 |
| Termux + 第二条 Cloudflare 隧道 | ⚠️ 可行但 Termux 常驻不可靠（Android 杀后台），且 LifeUp API 无鉴权挂公网需再叠 Cloudflare Access，链路复杂 |
| 蜂窝 IPv6 直连手机 | ❌ 运营商防火墙拦入站、IP 随时轮换、手机端无法 DDNS |
| frp / 自建 WireGuard | ❌ 需要公网 VPS |

## 3. 架构

```
LifeUp Cloud :13276（手机，无需任何改动，监听 0.0.0.0）
   ▲
   │ Android VPN 接口（Tailscale App，建议设为「始终开启」）
100.x.y.z（手机 tailnet IP，入网后永久固定）
   ▲
   │ WireGuard 加密（优先 P2P 直连，打洞失败自动 DERP 中继兜底）
100.a.b.c（服务器 tailnet IP）
   ▲
   │ SOCKS5 127.0.0.1:1055（tailscaled userspace 模式内置出口）
lifeup_relay.mjs：监听 127.0.0.1:13276，TCP 双向转发（systemd --user 常驻）
   ▲  自动选路：tailnet 目标走 SOCKS5；局域网 IP 直接连接（手机忘开 VPN 但在家时自动回落）
   │
@lifeup/mcp（connect host 固定填 127.0.0.1:13276）
   ▲
AI Agent（pi / Claude / 任意 MCP 宿主）← 可经 Cloudflare Tunnel 从公网访问
```

**成立的唯一硬假设**：LifeUp Cloud 监听时绑定 `0.0.0.0`（接受从 VPN 接口进入的连接）。Android 应用监听端口基本都是绑全部接口，实测通过；部署时第一步就验证它。

## 4. 前提条件

**服务器端**（任意 Linux，无需 sudo / 公网 IP / 端口转发）：

- systemd 用户服务可用（`systemctl --user`）
- Node.js（跑 MCP 与中继脚本）
- 能访问 `pkgs.tailscale.com`（国内直连一般可达，不通时挂代理）

**手机端**：

- Android，安装 [Tailscale App](https://tailscale.com/download)（Google Play 或官网 APK，国内下载慢可用 `https://ghproxy.net/` 前缀代理 GitHub releases）
- LifeUp（人升）App，已开启「LifeUp Cloud」局域网服务

**账号**：一个 Tailscale 账号（GitHub / Google / 微软登录均可），免费版足够。

## 5. 部署步骤

以下命令中：
- `<手机局域网IP>`：手机 LifeUp Cloud 界面显示的地址，如 `192.168.1.23`
- `<手机tailnetIP>`：手机入网后 `tailscale status` 显示的 `100.x.y.z`
- `$XDG_RUNTIME_DIR`：systemd 用户运行时目录（通常 `/run/user/<uid>`）

### 5.1 服务器端：安装 tailscaled（userspace 模式）

```bash
# 获取最新版本号并下载静态二进制（免 root、免安装）
VER=$(curl -s 'https://pkgs.tailscale.com/stable/?mode=json' | grep -oP '(?<="TarballsVersion": ")[^"]+')
curl -sL -o /tmp/tailscale.tgz "https://pkgs.tailscale.com/stable/tailscale_${VER}_amd64.tgz"
tar xzf /tmp/tailscale.tgz -C /tmp
cp /tmp/tailscale_${VER}_amd64/tailscale{,d} ~/bin/ && chmod +x ~/bin/tailscale{,d}
```

> arm 设备把 `amd64` 换成 `arm64`/`arm`。

systemd 用户服务 `~/.config/systemd/user/tailscaled.service`：

```ini
[Unit]
Description=Tailscale daemon (userspace networking, no root)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/bin/tailscaled \
  --tun=userspace-networking \
  --socket=%t/tailscaled.sock \
  --statedir=%h/.local/share/tailscale \
  --socks5-server=localhost:1055
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

启动并登录（浏览器打开输出的 URL，用你的账号授权）：

```bash
systemctl --user daemon-reload && systemctl --user enable --now tailscaled.service
~/bin/tailscale --socket=$XDG_RUNTIME_DIR/tailscaled.sock up --hostname=myserver --accept-dns=false
# → 输出 https://login.tailscale.com/a/xxxx ，浏览器打开登录授权
```

> 关键参数：`--tun=userspace-networking` 免 root（不创建 TUN 设备，出站走内置 SOCKS5）；`--accept-dns=false` 避免动系统 DNS。
> 若希望开机不登录也自启，配合 `loginctl enable-linger <用户>`。

### 5.2 手机端

1. 安装 Tailscale App → 同一账号登录 → 打开 VPN
2. 系统设置 → 网络 → VPN → Tailscale → **「始终开启的 VPN」**（这是跨网可靠性的关键）
3. LifeUp 保持后台运行（电池优化设为"不限制"），开启「LifeUp Cloud」服务

### 5.3 验证硬假设 + 拿到手机 tailnet IP

```bash
~/bin/tailscale --socket=$XDG_RUNTIME_DIR/tailscaled.sock status
# 记下手机的 100.x.y.z，形如：
# 100.98.x.x  my-phone  user@  android  -

# 硬假设验证：LifeUp 是否接受 VPN 接口入站连接（应返回 JSON 版本信息）
curl -s -m 10 --socks5-hostname 127.0.0.1:1055 http://<手机tailnetIP>:13276/info
```

> 若这一步失败（LifeUp 只绑了 WiFi 接口——实测未遇到），本方案不可用，转 Termux + Cloudflare Tunnel 路线。

### 5.4 服务器端：本地中继 lifeup_relay

中继作用：`@lifeup/mcp` 只会普通 TCP 连接，不会 SOCKS5；中继把 `127.0.0.1:13276` 的流量按目标自动分流（tailnet 地址走 SOCKS5 出隧道，局域网地址直连），实现主备选路。

```bash
mkdir -p ~/.local/share/lifeup-relay && cd ~/.local/share/lifeup-relay
npm init -y && npm i socks
```

`lifeup_relay.mjs`（本仓库 [`scripts/lifeup_relay.mjs`](scripts/lifeup_relay.mjs)）：

```bash
cp /path/to/repo/scripts/lifeup_relay.mjs .
```

systemd 用户服务 `~/.config/systemd/user/lifeup-relay.service`：

```ini
[Unit]
Description=LifeUp MCP relay (127.0.0.1:13276 -> SOCKS5 -> phone LifeUp Cloud)
After=tailscaled.service network-online.target
Wants=tailscaled.service

[Service]
# 主目标：手机 tailnet IP（跨网走 Tailscale）；回落：局域网 IP（在家且 VPN 关闭时）
Environment=LIFEUP_TARGETS=<手机tailnetIP>,<手机局域网IP>
ExecStart=/usr/bin/node %h/.local/share/lifeup-relay/lifeup_relay.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

> `ExecStart` 的 node 路径按实际改（`which node`；用 nvm 等装的要写绝对路径）。

```bash
systemctl --user daemon-reload && systemctl --user enable --now lifeup-relay.service

# 验证：以下两条都应返回 {"code":200,...}
curl -s -m 8 http://127.0.0.1:13276/info
journalctl --user -u lifeup-relay -n 2 -o cat   # 应看到 OK ... -> 100.x.y.z
```

### 5.5 接入 MCP

`@lifeup/mcp` 的 `connect` 工具固定填 **`127.0.0.1:13276`**（不要直连手机 IP，让中继自动选路）：

```jsonc
{"name":"connect","arguments":{"host":"127.0.0.1:13276"}}
```

手机流量下实测读 / 写 / 完成任务 / 快照导出全链路等效局域网，P2P 直连时单次请求 ~1s。

## 6. 故障排查（分层定位）

| 层 | 命令 | 看什么 |
|---|---|---|
| ① 中继本身 | `curl -m 8 http://127.0.0.1:13276/info` | 返回 JSON = 全链路通，问题在 MCP 侧 |
| ② 中继日志 | `journalctl --user -u lifeup-relay -n 10 -o cat` | `FAIL <目标>` 连到哪个目标挂了；两个目标都 FAIL = 手机侧掉线 |
| ③ Tailscale | `~/bin/tailscale --socket=$XDG_RUNTIME_DIR/tailscaled.sock status` | 手机是否 `online`；不在线 = 手机 VPN 被杀或断网 |
| ④ 局域网兜底 | `curl -m 8 http://<手机局域网IP>:13276/info` | 通 = 手机在家但 VPN 关了（中继已自动回落，无需处理） |
| ⑤ 手机侧 | 手机屏幕 | Tailscale App 是否在连；LifeUp 是否存活、Cloud 服务是否开启 |

**手机侧最常见掉线原因**：Tailscale VPN 被系统杀（重开 App / 检查"始终开启"）、LifeUp 后台被杀（重开 App）、手机断网。服务器端两个 systemd 服务均 `Restart=on-failure` 自愈。

## 7. 踩坑记录（实测）

| 坑 | 现象 | 解法 |
|---|---|---|
| socks npm 库 API 变更 | `SocksClient.createConnection` 报 `An invalid destination host was provided.`（本地校验错误，毫秒级失败） | socks 2.x 参数名是 `destination` 而非 `target`：`{proxy, command:'connect', destination:{host,port}}` |
| tailscaled SOCKS5 只放行 tailnet 目标 | 经 SOCKS5 连局域网 IP 报同上错误 | 中继按目标分流：`100.64.0.0/10` 与 `*.ts.net` 走 SOCKS5，其余直连 |
| tailscaled 默认 socket 路径需要 root | `tailscale` CLI 连不上 daemon | 显式 `--socket=$XDG_RUNTIME_DIR/tailscaled.sock`（服务端与 CLI 两侧都要） |
| userspace 模式默认 state 目录不可写 | 启动失败 | 显式 `--statedir=~/.local/share/tailscale` |
| 打洞失败绕海外 DERP | 延迟升到数百 ms | 属预期兜底行为，MCP 小 JSON 无感；同 LAN 时通常 P2P 直连 ~1s 内 |
| MCP `call_api_batch` 参数包错层 | `Input validation error: expected array` | `tools/call` 的键是 `arguments`（不是 `params`），batch 的 calls 才在其内 |

## 8. 安全要点

- LifeUp Cloud API **没有任何鉴权**——这正是本方案不把它挂公网（Cloudflare Tunnel 直暴）的原因；Tailscale 私有网内 WireGuard 加密，等价于"随身局域网"
- tailnet 默认同账号设备互通；如需收紧，在 Tailscale 管理台配 ACL
- 服务器端若同时跑公网 Agent 服务（如 Cloudflare Tunnel 后的 Web Agent），确保其自身有 Bearer Token 等鉴权——否则等于把 LifeUp 控制权间接暴露
- tailnet IP / 内网 IP / 账号名不要提交到公开仓库

## 9. 环境清单（实测）

- 服务器：Ubuntu 26.04，无 sudo，systemd --user，Tailscale 1.104.1（userspace 模式）
- 手机：Android（Nothing Phone 2 Pro），Tailscale App + 始终开启 VPN，LifeUp 1.106.0（Cloud 3.0.2，API v7）
- MCP：`@lifeup/mcp`，中继为 Node 22 原生脚本（依赖仅 `socks`）
- 效果：蜂窝流量下 `connect` / 建任务 / 完成结算 / `get_coin` / 快照导出全通，单请求 ~1s（P2P 直连）

---

## License

MIT
