# 谁是卧底 · 朋友局

手机优先的多人文字派对游戏。前端原生 HTML/CSS/JavaScript + Vite，GitHub Pages 托管；Supabase Anonymous Auth、PostgreSQL RPC、Realtime 与 Edge Function 提供后端。电脑无需开机，也不用开放本机端口。

## 已配置的项目

- 游戏：https://mcloseyb.github.io/undercover-game/
- 词库管理：https://mcloseyb.github.io/undercover-game/admin.html
- GitHub：https://github.com/Mcloseyb/undercover-game
- Supabase Project Ref：`cypbwptcuvvaejruiqgb`

首次部署已于 2026-11-06 成功，首页、CSS 和管理页均经实际 HTTPS 请求返回 200。后续部署结果见仓库 Actions 中最新的 `Deploy game to GitHub Pages`。

验证结果：本地 PostgreSQL/词库/弹窗测试 15 项通过；真实云端 14 组场景通过，包含 4 人整局、68 次成员 Realtime 事件和 0 次越权事件。详细范围与限制见 [TESTING.md](TESTING.md)。

## 开始一局

1. 用手机浏览器打开游戏，输入昵称创建房间，选择人数、词库和时间。
2. 把邀请链接或 6 位房间号发给朋友。每位玩家用自己的手机加入。
3. 人数达到设置值、所有玩家在线后，房主开始。等待大厅可修改设置、移除离线玩家。
4. 查看自己的词，轮流发送一句描述。发言超时自动跳过；描述不能直接包含自己的词。
5. 投票给其他存活玩家或弃票，提交后不能更改。超时算弃票，最高票平票无人淘汰。
6. 平民淘汰全部卧底获胜；卧底人数达到平民人数，或达到轮次上限仍有卧底，卧底获胜。
7. 结算后房主可直接再来一局，或返回大厅调整设置。

刷新、切换应用或短暂断网后，在同一浏览器重新打开可恢复。不要退出匿名账号或清除网站数据；换设备和微信内置浏览器与系统浏览器之间不会共享身份。游戏中主动退出会淘汰自己。房主超过 60 秒没有心跳，自动交给在线玩家；已离线玩家仍可恢复身份。在线标识约有 45 秒宽限。

## 本地开发

安装 Node.js 20.19+（推荐 24 LTS）与 npm：

```powershell
npm install
npm start
```

打开 `http://localhost:3000/`。当前电脑也可双击 `start.bat`；脚本支持本次开发安装的便携 npm。默认前端直接连接上面的 Supabase 项目，因此本地也是真实云端游戏。开发预览不是最终公网地址。

```powershell
npm test
npm run build
npm run test:integration
```

`npm test` 在 PGlite 的真实 PostgreSQL 内执行相同迁移和 RPC，验证身份、流程、平票、弃票、获胜、权限与房主转移；测试中的时间调整只发生在独立本地测试库。`test:integration` 通过真实 HTTPS 和 WebSocket 创建 5 个独立匿名账号，以其中 4 人进行整局游戏，包含真实 15 秒超时、并发投票、越权检查和重连，不使用伪造联机数据。云端测试需要联网，大约数分钟；结果保存在忽略提交的 `test-output/integration.json`。测试 Auth 会话仅存于 `.tools/test-sessions.secret`，不提交。默认匿名注册受 Supabase 每 IP 每小时限制，不要反复批量注册。

可复制 `.env.example` 为 `.env` 指向其他 Supabase 项目。前端只允许公开的 URL 与 publishable key，不能填写 Secret、service_role、数据库密码或 Access Token。

## 管理员导入词库

打开 `admin.html`，输入管理员密码并选择 UTF-8 JSON 或 CSV 文件（最大 256 KB）。密码在 Edge Function 通过服务器 Secret 校验，浏览器不持久保存密码。每次成功上传创建新词库，不覆盖旧词库；创建或调整房间时会重新加载词库列表。

本次部署生成的管理员密码保存在本机 `.tools/admin-password.secret`，已被 Git 忽略。只把游戏地址发给朋友，勿分享该密码文件。

JSON：

```json
{
  "name": "水果派对",
  "pairs": [
    { "civilian": "苹果", "undercover": "梨子" },
    { "civilian": "橙子", "undercover": "柚子" }
  ]
}
```

CSV 文件名作为词库名（最多 24 个字），首行也可用 `平民词,卧底词`：

```csv
civilian,undercover
苹果,梨子
橙子,柚子
```

每个词库 2～2000 组，每个词 1～24 个字。相同词、重复配对、控制字符、不合法文件名会被拒绝；SQL 事务保证不会导入半份数据。管理员请求同时校验匿名登录 JWT 和管理密码，并限制请求频率。

修改密码：Supabase Dashboard → Project Settings → Edge Functions → Secrets，更新 `ADMIN_PASSWORD`（至少 12 字符）；不要把密码加入 VITE_ 变量或 GitHub。CLI 也可从本地被忽略的文件设置：

```powershell
.\.tools\supabase.exe secrets set --env-file .tools\admin-env.secret --yes
```

文件内容形如 `ADMIN_PASSWORD=你的新密码`，用后删除。当前 CLI 登录令牌由官方 CLI 保存在用户凭据存储，不在项目中。

## 服务端设计与部署维护

- `supabase/migrations/`：表、RLS、服务端游戏规则、初始 45 组词语、Realtime 与 Cron。
- `wodi_private`：未通过 Data API 暴露的 schema，保存身份、双方词语、票选和真实房间状态。普通角色没有表读写权限。
- `public.wodi_action`：统一 RPC，用 `auth.uid()` 确定身份。每次操作锁定房间行，验证当前阶段和服务器截止时间，再进行原子转换。
- `public.wodi_room_events`：只含房间 UUID、版本号和更新时间；RLS 仅允许房间成员读取。Realtime 订阅它，再调用 RPC 获取只属于自己的视图。未结算的投票选择、票数、其他人的未公开身份永不进入事件。
- `public.wodi_wordbanks`：只暴露主题名称和词组数。词对在私有表中。
- `wodi-advance` Cron：每 5 秒推进到期阶段，无人在线时仍运行；客户端同步请求也检查到期时间。修改手机时钟不能提前发言或延长截止时间，UI 倒计时由服务端时间锚定到单调时钟。
- 每个连接约 12 秒同步一次用于心跳和断线兜底，正常操作通过 Realtime 立即同步。后台手机浏览器暂停运行时会暂时显示离线，回到页面即可恢复。
- 总局数/胜场是当前浏览器本地统计，清除网站数据会重置。

本次使用 Supabase CLI 3.x，远程数据库命令需显式指定 `--remote`：

```powershell
.\.tools\supabase.exe login --agent no
.\.tools\supabase.exe link --project-ref cypbwptcuvvaejruiqgb
.\.tools\supabase.exe db push --remote --dry-run
.\.tools\supabase.exe db push --remote --yes
.\.tools\supabase.exe functions deploy admin-wordbanks --use-api --yes
```

其他电脑可按 Supabase 官方文档安装 CLI。不要执行 `db reset --remote`。新改动应新建迁移文件，禁止改写已部署的历史。`supabase/config.toml` 已开启匿名登录，Realtime publication 由迁移配置。Edge Function 的平台 `verify_jwt=false` 用于兼容当前签名方式，函数内部仍强制使用 Auth API 验证 Bearer JWT，管理员操作还必须通过密码校验。

推送到 `main` 后 Actions 自动测试、构建并部署。GitHub 仓库 Settings → Pages → Source 需为 **GitHub Actions**。工作流设定 `VITE_BASE_PATH=/undercover-game/`，所有页面、资源和邀请链接均兼容子路径；只有 `index.html` 和 `admin.html` 两个实际页面，不依赖 SPA 路由重写。

```powershell
git add .
git commit -m "Update game"
git push origin main
```

## 使用边界与排查

- 这是朋友间的小型项目，不提供反作弊裁判、跨设备身份迁移或正式账号找回。匿名会话本身是身份凭据，不能分享。
- 使用平台免费套餐；免费项目的暂停、额度、地区网络可达性由平台决定。无需购买服务，但不能保证国内所有运营商或微信内置浏览器都能稳定访问 GitHub Pages / Supabase；打不开时先尝试系统浏览器及不同网络。
- Realtime 暂时断线时会自动重新订阅，并以同步请求补齐状态。页面提示“房间不存在”时重新创建或加入。
- 倒计时显示 0 秒到状态切换最多可能有约 5 秒调度延迟。结算页保留 7 秒再进入下一轮。
- 游戏状态保存在数据库中，网页关闭不会清除。现阶段不自动批量删除用户、房间和历史数据，避免误删；长期不用的测试数据可在备份和确认后按 `wodi_` 范围维护。
- 查看 Supabase → Logs / Edge Functions → admin-wordbanks 日志及 Cron → `wodi-advance` 历史；不要把包含 JWT 的日志公开。
