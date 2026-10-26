# 每日听歌 · DeepSeek Harness 插件

每天北京时间 **21:00**，从你登录的网易云音乐「每日推荐」挑 **5 首候选**，每首用本机播放器试听 **30 秒**，由 DeepSeek 选出 **3 首**、写推荐理由和歌曲链接，发送到开启任务的 Harness 对话。日报另存本机。可以告诉它喜欢 / 不喜欢哪首歌，之后选歌会参考本地偏好，并避开近 14 天推荐过的歌曲。

**这里的“听歌”是本机播放器真实播放。** DeepSeek 根据歌曲资料、可用歌词和你的偏好写推荐理由；文本模型不会因为播放了音乐就获得音频理解能力。没有播放器、歌曲不可播或试听失败时，仍可推荐，但明确标记「未完成试听」。不提交虚假播放记录，不绕过会员 / 版权限制，不自动修改收藏。

## 安装

已针对 Harness Desktop **0.2.1-rc.2** 的真实工具和排程接口编写。使用 Node.js 22.19+（建议 24），无需另填 DeepSeek API Key，使用当前 Harness 会话的模型。

### 从 npm 安装（推荐）

包名 `dsh-netease-daily`，已发布到 npm：

```powershell
dsh plugin --profile <profile> add dsh-netease-daily
```

在 **Harness 的对话里**（profile 已启用 `plugin_manager` 时）也可以直接说：

> 安装 bundle `dsh-netease-daily`，然后确认 `netease_status` 工具可用。

源码与市场登记：<https://github.com/zxcvbnmlxy/dsh-netease-daily>。需要固定代码版本时用 `github:zxcvbnmlxy/dsh-netease-daily#<commit>` 安装。

### 从本地目录安装（开发版）

1. 在本目录运行：

   ```powershell
   npm.cmd ci --ignore-scripts
   ```

2. 打开 Harness Desktop 的插件管理，使用本地插件 / 本地目录安装，选择本目录；如果界面没有本地安装入口，在 **Harness 的对话里**请它调用自带的 `plugin_manager` 安装：

   > 安装本地 bundle（指向本目录），包名 `dsh-netease-daily`，然后确认 `netease_status` 工具可用。

   根据 Harness 提示重载或重启。不要手工替换 Desktop 的核心包。

3. 扫码登录网易云（任选其一）：

   - 在本目录运行 `npm.cmd run login`，用网易云 App 扫描浏览器中的二维码并确认，网页会自动检查登录；
   - 或者直接在 Harness 里说：

     > 调用 netease_login_start，把本机二维码图片显示给我；我扫码确认后，再调用 netease_login_check。

4. 登录后，在准备接收日报的 **Harness 对话里**说：

   > 启用网易云每日听歌任务：北京时间每天 21:00，从我的每日推荐挑 5 首，每首试听 30 秒，给我推荐 3 首并说明理由。现在先执行一次。

   这会调用 `netease_schedule_enable`。以工具返回的任务 ID 和下次执行时间为准；**仅安装插件不会自行创建任务**。先登录、再开启任务。

## 试听播放器

安装 [mpv](https://mpv.io/installation/)，确保 `mpv.exe` 在 PATH，或把插件配置 `player_path` 设为完整路径。插件不代装播放器。声音由运行 Harness 的电脑播放，默认音量 25%。如果是远程服务器，声音不会自动传到你的手机或浏览器。

未安装 mpv 时，工具会返回 `unavailable`，日报注明没有完成试听；不会阻止歌曲推荐。播放器收到取消信号或超时会停止。成功记录依赖实际音频输出与播放进度，不能仅凭拿到了歌曲链接就算试听成功。

## 日常使用

- 「现在选歌、试听并推荐」：`netease_daily_prepare` → 对每首调用 `netease_preview` → `netease_daily_save`。
- 「我喜欢这首 / 不喜欢这首」：`netease_feedback` 记录在本机，下次选歌生效。
- 「停止每天推歌」：`netease_schedule_disable`；不会影响其他任务。
- 「检查登录和今日任务状态」：`netease_status`。
- 同一天重复触发会继续使用当天候选，已成功试听的歌曲不重复播放，已完成的日报不重复改写。

歌曲数量不足时推荐相应的较少数量；去重后没有新歌会如实告知，不从别的来源偷偷填补。

## 配置和数据

默认数据目录为 `%USERPROFILE%\.dsh\netease-daily`（尊重 `DSH_HOME`），也可通过环境变量 `DSH_NETEASE_DATA_DIR` 指定。插件行的配置支持 `data_dir`、`preview_seconds`、`player_path`、`volume`、`avoid_days`，默认值分别为上述目录、30、`mpv`、25、14。更改数据目录后，命令行登录和插件必须使用同一目录。

- `credentials.json`：网易云登录凭证，只留在本机，不写入对话、日报或安装包。POSIX 系统使用 0600 权限；Windows 继承用户目录 ACL。
- `history.json`：每日候选、真实播放状态、推荐结果和个人偏好。
- `reports/YYYY-MM-DD.md`：歌曲推荐与试听记录。
- `login-qr.png`：临时登录二维码，通常约两分钟失效。

Harness 必须在运行、电脑必须联网，任务才能执行；插件不会唤醒关机的电脑。定时任务由 Harness 的原生 Schedule 持久化，停机后恢复遵循 Harness 的补发规则。会话归档、模型授权或工具审批也可能影响执行，以 Harness 的任务记录为准。

该插件使用社区维护的网易云 API 包，不是网易云官方插件。接口请求在独立进程中运行，依赖自身的标准输出和错误日志不会进入 Harness；取消或超时会终止该进程。登录失效时重新扫码。歌曲资料和歌词作为数据读取，不作为指令执行；推荐时不引用歌词、不编造听感。

## 独立 CLI / Web 用户

Desktop 用户按上文安装；独立 CLI 才使用：

```powershell
dsh plugin --profile web add 'link:D:/deepseek插件'
```

也可以安装交付的 `.tgz` 包。工具和任务需要原生 Schedule 服务；未启用该服务时，音乐工具仍可使用，需先在 Harness 启用「Scheduled tasks」。

## 开发验证

```powershell
npm.cmd test
npm.cmd pack --ignore-scripts
```

单元测试使用模拟网易云接口和模拟播放器，不会登录你的账号、实际播歌或向网易云上报记录。真实账号扫码、受版权限制的歌曲、实际音频设备和原生定时触发需要安装后验证。

接口依据：[Harness 插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)、[Harness Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/schedule.md)、[网易云 API 维护者文档](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)、[mpv 参数](https://mpv.io/manual/stable/)。
