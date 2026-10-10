#!/usr/bin/env node
/**
 * LifeUp MCP 跨网中继（Tailscale userspace 配套）
 * 监听 127.0.0.1:13276，通过 tailscaled 的 SOCKS5（userspace 模式内置，1055）
 * 把 TCP 流量转发到手机上的 LifeUp Cloud。
 *
 * 目标主备策略：依次尝试 LIFEUP_TARGETS（逗号分隔，host[:port]），
 *   全部失败则立即断开客户端连接（让 MCP connect 快速失败）。
 * 目标写 MagicDNS 名（如 phone.xxx.ts.net）时由 SOCKS5 远端解析，
 *   写 tailnet IP（100.x.y.z）则直连——两种都支持。
 *
 * 环境变量：
 *   LIFEUP_TARGETS  主备目标列表，默认 "192.168.1.100"（纯局域网回落）
 *   LIFEUP_SOCKS    SOCKS5 地址，默认 "127.0.0.1:1055"
 *   LIFEUP_LISTEN   本地监听端口，默认 13276
 */
import net from 'node:net'
import { SocksClient } from 'socks'

const LISTEN = Number(process.env.LIFEUP_LISTEN || 13276)
const [SOCKS_HOST, SOCKS_PORT] = (process.env.LIFEUP_SOCKS || '127.0.0.1:1055').split(':')
const TARGETS = (process.env.LIFEUP_TARGETS || '192.168.1.100')
  .split(',').map(s => s.trim()).filter(Boolean)

const log = (...a) => console.log(new Date().toISOString(), ...a)

async function dial(target) {
  const [host, port] = target.includes(':') && !target.startsWith('[')
    ? target.split(':') : [target.replace(/^\[|\]$/g, ''), 13276]
  const viaSocks = isTailnetHost(host) // tailscaled 的 SOCKS5 只放行 tailnet 目标，LAN 地址必须直连
  if (!viaSocks) {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port: Number(port) })
      s.setTimeout(8000, () => { s.destroy(); reject(new Error('direct connect timeout')) })
      s.once('connect', () => { s.setTimeout(0); resolve(s) })
      s.once('error', reject)
    })
  }
  return SocksClient.createConnection({
    proxy: { host: SOCKS_HOST, port: Number(SOCKS_PORT), type: 5 },
    destination: { host, port: Number(port) },
    command: 'connect',
    timeout: 8000,
  }).then(info => info.socket)
}

// 100.64.0.0/10 (CGNAT) 或 MagicDNS 域名视为 tailnet 目标
function isTailnetHost(h) {
  const m = h.match(/^100\.(\d+)\./)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127 || /\.(ts\.net|beta\.tailscale\.net)$/.test(h)
}

const server = net.createServer(client => {
  let idx = 0
  const tryNext = async () => {
    if (idx >= TARGETS.length) {
      log('ERR all targets unreachable:', TARGETS.join(', '))
      client.destroy()
      return
    }
    const t = TARGETS[idx++]
    try {
      const upstream = await dial(t)
      log('OK', client.remotePort, '->', t)
      client.pipe(upstream)
      upstream.pipe(client)
      const cleanup = () => { client.destroy(); upstream.destroy() }
      client.on('error', cleanup); upstream.on('error', cleanup)
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
    } catch (e) {
      log('FAIL', t, e.message)
      await tryNext()
    }
  }
  tryNext()
})

server.on('error', e => { log('FATAL', e.message); process.exit(1) })
server.listen(LISTEN, '127.0.0.1', () =>
  log(`lifeup-relay up on 127.0.0.1:${LISTEN}, socks5=${SOCKS_HOST}:${SOCKS_PORT}, targets=[${TARGETS.join(' -> ')}]`))
