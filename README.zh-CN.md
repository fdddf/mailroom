# Mailroom（中文说明）

部署在你自己 Cloudflare 账号上的邮件中心。一次部署可以管理任意多个域名，每个域名有自己的邮箱地址、收件箱、联系人、群发、API key 和 webhook。完整英文文档见 [README.md](README.md)。

## 能做什么

- **收信**：经 Cloudflare Email Routing 收到的邮件存进 D1（附件进 R2），后台可读、回复、归档、搜索
- **发信**：用任意邮箱地址撰写和回复，经 Cloudflare Email Sending 发出，显示投递状态
- **群发**：按域名分开的联系人和分组，定时分批发送，每封带独立退订链接（含一键退订），硬退信和投诉自动退订
- **编辑器**：纯文本 / HTML 可视化编辑、图片库、模板、可选的 AI 写作助手（Claude 或任何 OpenAI 兼容接口）
- **对接 API**：每个域名独立的 API key，其它系统可以调用 `/v1` 发信、管理联系人；收到邮件或投递状态变化时回调签名的 webhook

## 部署

```bash
npm install
npx wrangler login
npx wrangler d1 create mailroom          # 把 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create mailroom
npx wrangler queues create mailroom-events
```

在 `wrangler.jsonc` 里把 `PUBLIC_URL` 改成 Worker 的公开地址（退订链接和邮件图片指向这里）。然后：

```bash
npm run db:migrate
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

建议在后台前面加 Cloudflare Access（保护 `/` 和 `/api/admin/*`，`/v1/*`、`/u/*`、`/media/*` 保持公开）。

## 接入一个新域名

1. 后台 **Domains** → Add a domain，填域名、品牌名、第一个邮箱（如 `hello`）
2. 域名页面会列出三条现成的命令，复制运行即可：
   - `npx wrangler email sending enable example.com`（开通发信）
   - `npx wrangler email routing enable example.com` 并把 catch-all 指向 Worker `mailroom`（开通收信）
   - 给 `mailroom-events` 队列订阅该域名的投递事件（显示投递状态）
3. 页面上的 DNS 检查变绿后，点 **Send test** 发一封测试信

详见 [docs/domains.md](docs/domains.md)。

## 其它系统怎么对接

在域名页面创建 API key（只显示一次），然后：

```bash
curl https://mailroom.example.com/v1/send \
  -H "Authorization: Bearer mr_…" -H "Content-Type: application/json" \
  -d '{"to": "ann@gmail.com", "subject": "欢迎", "html": "<p>你好</p>"}'
```

需要处理来信的系统（例如客服工单）在域名页面添加 webhook，收信时会收到带 HMAC 签名的 `mail.received` 事件，里面有 `messageId`、`inReplyTo`、`references`，可以据此把回信归到对应的工单。完整说明见 [docs/api.md](docs/api.md)。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev        # http://localhost:5173
npm test
```
