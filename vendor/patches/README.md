# @patimweb/pi-email 1.4.1 — 本地补丁

上游包有三个会挂死整轮的问题，已在 vendor/pi-email 内修复。
升级上游版本时必须重新套用，否则 bug 复活。

## 1. `new Promise(async …)` 反模式（7 处，最严重）
`src/clients/imap-client.ts` 的 6 个导出函数，以及 `src/tools/email-flag.ts` 的内部 `setFlags()` 都曾经是：

    return new Promise(async (resolve, reject) => {
      const imap = await connectImap(config);   // 抛异常时外层 Promise 永不 settle

执行器里 await 抛出的异常不被该 Promise 捕获 → 同时造成
unhandled rejection **和** 永久挂起，调用方的整轮任务卡死。
修复：用 try/catch 包住 IMAP 连接，失败时 `return reject(err)`。

## 2. TLS 缺少 SNI
`tlsOptions: { rejectUnauthorized: true }` 没有 servername，
ClientHello 不带 SNI，Gmail 前端回一张通用自签证书 →
DEPTH_ZERO_SELF_SIGNED_CERT。实测：带 SNI 认证成功，不带必失败。
修复：`servername: config.imap.host`。

## 3. 超时过长
connTimeout 30s → 15s，authTimeout 30s → 10s。
撞 Gmail 登录限流时快速失败，而不是让调用方干等半分钟。
