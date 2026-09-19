# 微信群聊室 · WeChat-Style Live Chat

一个模仿微信群风格的**在线临时聊天室**：打开网页即来即聊，**不保存任何聊天记录**。

基于 Cloudflare Workers + Durable Objects（WebSocket 实时通信），前端零框架、零依赖，单页面即开即用。

## 功能特性

- **即开即聊**：普通用户自动分配随机昵称（形容词 + 动物 + 3 位数字，如 `温柔的柯基357`），无需注册
- **不保存聊天记录**：所有消息仅存于 Durable Object 内存中（最近 50 条，供新加入者同步），服务器重启即清空，不落任何数据库/存储
- **管理员模式**：输入管理员账号密码（通过 Cloudflare Secrets 配置，见下文）后：
  - 昵称显示为「管理员」，带专属徽章与橙色头像
  - 可**置顶任意消息**（顶部置顶条展示，点击定位，可取消）
  - 可**一键关闭群聊**：关闭后普通用户禁言，仅管理员可以发言
- **长消息折叠**：超过 100 字的消息自动折叠，可「展开全文 / 收起」
- **复制消息**：悬浮任意消息可**复制单条**；顶栏「复制记录」可**一键复制全部聊天记录**
- **体验细节**：日期分隔、加入/退出系统提示、在线人数、掉线自动重连、新消息提示、Enter 发送（兼容中文输入法）、移动端自适应、Toast 反馈、消息入场动画

## 技术架构

```
浏览器 ──WSS──> Worker (/api/ws) ──> Durable Object「ChatRoom」（全局单例）
                     │                        ├─ 内存：最近 50 条消息
                     └─ 静态资源 (public/)     ├─ 内存：置顶消息 / 关闭状态
                                              └─ WebSocket 广播（常驻内存，不落存储）
```

- 管理员登录：`POST /api/login`，校验通过后签发 HMAC-SHA256 签名令牌（30 天有效），令牌仅用于证明管理员身份
- 置顶 / 关闭群聊等管理操作全部走 WebSocket 消息，并在服务端二次校验权限，前端只是 UI 展示

## 本地开发

```bash
npm install
npm run dev     # 打开 http://localhost:8787
```

## 部署到 Cloudflare

```bash
npx wrangler login    # 首次需要登录
npm run deploy        # 部署到 https://wechat-chat-room.<你的子域>.workers.dev
```

Durable Objects 使用 SQLite 后端（免费计划可用），消息不写入存储，因此**不产生任何存储费用**。

## 配置（必需）

管理员账号密码**不在代码仓库中**，通过 Cloudflare Secrets 配置：

```bash
npx wrangler secret put ADMIN_USERNAME   # 按提示输入管理员账号
npx wrangler secret put ADMIN_PASSWORD   # 按提示输入管理员密码
npx wrangler secret put ADMIN_SECRET     # 建议设置：令牌签名密钥，可用 openssl rand -hex 32 生成
```

本地开发在项目根目录创建 `.dev.vars`（已被 .gitignore 忽略，不会提交）：

```
ADMIN_USERNAME=你的账号
ADMIN_PASSWORD=你的密码
ADMIN_SECRET=任意随机长字符串
```

> ⚠️ 未配置 Secrets 时管理员登录会一直失败（这是预期行为）。修改 Secret 后立即生效，无需改动代码；如怀疑口令泄露，直接更新 `ADMIN_PASSWORD` 即可轮换。

## 常见问题

**聊天记录真的不会保存吗？**
是。Durable Object 不调用任何 Storage API，消息只存在于实例内存；实例重启/休眠唤醒后消息清空。前端也不写 localStorage。

**为什么新加入的人能看到最近几条消息？**
为了让后来者同步上下文，服务端在内存中保留最近 50 条用于快照下发，这份数据随时会因重启而消失，不属于持久化存储。

**一个页面可以开两个标签页测试吗？**
可以，每个标签页会分配不同的随机昵称，消息实时互通。
