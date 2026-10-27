# 发布 0.2.1 到 npm（两条路径）

当前状态（2026-10-27）：

- 本地插件已是 **0.2.1**，代码已推到 GitHub（`9843d6f`），`dsh-netease-daily-0.2.1.tgz` 已打好。
- npm 上最新仍是 **0.1.2**，所以 `dsh plugin --profile <profile> add dsh-netease-daily` 装到的是旧版（这正是你看到"上上一版"的原因）。
- 本机 `~/.npmrc` 里的 token 已失效（`npm whoami` → 401）。npm 现在对发布要求"能证明本人"：账号 **没有开 2FA**，而 **bypass-2FA token** 被标记为弃用但仍可用到 2027 年 1 月。

## 路径 A：生成 bypass-2FA token（最快，1 分钟）

1. 打开 https://www.npmjs.com/settings/yuanshen_qidong/tokens → **Generate New Token → Granular Access Token**
2. Name 任意；Expiration 7 days；Packages 选 `All packages` 或 `dsh-netease-daily`；Permissions 选 **Read and write**
3. **勾选 Bypass two-factor authentication (2FA)**（会提示弃用，属预期；2027-01 前仍有效）
4. 生成后二选一：
   - 把 token 发我，我用一次性 npmrc 发布并立即删除；或
   - 自己执行：
     ```powershell
     cd D:\deepseek插件
     npm config set //registry.npmjs.org/:_authToken <token>
     npm publish --access public
     npm config delete //registry.npmjs.org/:_authToken
     ```

发布后验证：`npm view dsh-netease-daily version` 应为 `0.2.1`。

## 路径 B：Trusted Publishing（推荐长期用，不需要 token/2FA）

仓库已带 `.github/workflows/publish-npm.yml`。你只需要在 npm 页面配置一次：

1. 打开 https://www.npmjs.com/package/dsh-netease-daily → **Settings** → **Trusted Publisher**
2. 选择 **GitHub Actions**，填写：
   - Organization or user：`zxcvbnmlxy`
   - Repository：`dsh-netease-daily`
   - Workflow filename：`publish-npm.yml`
   - Environment：留空
3. 保存后，打 tag 或手动触发工作流即可发布（npm 会生成 provenance，以后升级版本只改 `package.json` 再推 tag）：
   ```powershell
   cd D:\deepseek插件
   git tag v0.2.1
   git push origin v0.2.1
   ```
   或 GitHub → Actions → publish-npm → Run workflow。

## 在那之前的临时安装方式

装最新 0.2.1（GitHub 固定提交）：

```powershell
dsh plugin --profile <profile> add github:zxcvbnmlxy/dsh-netease-daily#9843d6f
```

或让 Harness 调用 `plugin_manager` 的 `install_bundle`，target 填上面的 GitHub 地址。
