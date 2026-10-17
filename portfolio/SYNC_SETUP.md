# 资产台账云同步配置

页面继续由 GitHub Pages 托管，Supabase 只负责保存浏览器已经使用 AES-GCM 加密的台账密文。不要把 `service_role` 或 secret key 放进网页。

## 一次性配置

1. 在 Supabase 创建一个项目。
2. 打开项目的 SQL Editor，运行 [`supabase-setup.sql`](supabase-setup.sql)。这会创建 `portfolio_vaults` 表，并启用只允许登录用户读写自己那一行数据的 RLS 策略。
3. 在 Supabase 的 **Authentication → Providers → Email** 中保留 Email/Password 登录。建议开启邮箱验证；首次创建同步账户后需要点击验证邮件。
4. 在 **Project Settings → API** 复制 Project URL 和 publishable key（旧项目中可能显示为 anon public key）。
5. 填入 [`sync-config.js`](sync-config.js)：

   ```js
   window.PORTFOLIO_SYNC_CONFIG = Object.freeze({
     url: "https://YOUR_PROJECT_REF.supabase.co",
     publishableKey: "sb_publishable_YOUR_KEY"
   });
   ```

6. 提交并发布 `portfolio/` 下的改动。打开台账后点击“云同步”，在第一台设备创建同步账户；其他设备用相同的同步账户和原台账访问密码登录。

## 安全边界

- 台账访问密码只在浏览器中用于 PBKDF2 派生 AES-GCM 密钥，不会发送到 Supabase。
- 同步账户密码由 Supabase Auth 处理，与台账访问密码相互独立。
- 数据库保存的是 `{version, iv, ciphertext}` 密文包和更新时间，不保存资产明文。
- publishable/anon key 本来就用于公开客户端；安全性来自 Auth 和 RLS。绝不能使用 `service_role` key。
- 多设备同时离线编辑时采用“更新时间较新者覆盖”。开始编辑前点一次“立即同步”可减少冲突。
