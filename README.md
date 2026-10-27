# 每日听歌 · DeepSeek Harness 插件

每天北京时间 **21:00**，从你登录的网易云音乐「每日推荐」挑 **5 首候选**，每首用本机播放器试听 **30 秒**，由 DeepSeek 选出 **3 首**、写推荐理由和歌曲链接，发送到开启任务的 Harness 对话。日报另存本机。可以告诉它喜欢 / 不喜欢哪首歌，之后选歌会参考本地偏好，并避开近 14 天推荐过的歌曲。

**这里的“听歌”是本机播放器真实播放。** DeepSeek 根据歌曲资料、可用歌词和你的偏好写推荐理由；文本模型不会因为播放了音乐就获得音频理解能力。没有播放器、歌曲不可播或试听失败时，仍可推荐，但明确标记「未完成试听」。不提交虚假播放记录，不绕过会员 / 版权限制，不自动修改收藏。

## 安装

已针对 Harness Desktop **0.2.1-rc.2** 的真实工具和排程接口编写。使用 Node.js 22.19+（建议 24），无需另填 DeepSeek API Key，使用当前 Harness 会话的模型。

### 从 GitHub 安装（开发版 / 最新未发布代码）

```powershell
dsh plugin --profile <profile> add github:zxcvbnmlxy/dsh-netease-daily#9843d6f
```

或安装不带固定提交的最新 main：

```powershell
dsh plugin --profile <profile> add github:zxcvbnmlxy/dsh-netease-daily
```

在 **Harness 的对话里**（profile 已启用 `plugin_manager` 时）也可以直接说：

> 安装 bundle `github:zxcvbnmlxy/dsh-netease-daily`，然后确认 `netease_status` 工具可用。

### 从 npm 安装

```powershell
dsh plugin --profile <profile> add dsh-netease-daily
```

npm 最新版本以 `npm view dsh-netease-daily version` 为准。注意 pnpm 11 起默认 `minimumReleaseAge: 1440`（新发布的版本要满 1 天才参与按范围的解析），所以刚发布的新版本用**裸包名**可能仍解析到上一版。三种处理方式：

- 显式指定版本（立即生效）：`dsh plugin --profile <profile> add dsh-netease-daily@<版本号>`
- 等约 1 天后裸包名自动解析到新版；
- 或在 profile 的 `pnpm-workspace.yaml` 里设 `minimumReleaseAge: 0`（会放宽整个 profile 的供应链冷却，谨慎）。

市场登记：<https://dsh-plugin.market/plugin/zxcvbnmlxy/dsh-netease-daily>。

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

## 设置页

安装（或升级）插件后**重启一次 DSH**，设置页左侧会出现「每日听歌」。这一页集中管理所有可变项，不用改代码或配置文件，保存后立即生效、重启后保留：

- **每日运行时间**（默认 21:00）与启用开关；
- **推荐描述**：心情 / 场景 / 风格，AI 按它从每日推荐和关键词搜索里挑歌；
- **mpv 依赖**：显示是否就绪（路径与版本），可一键检测或用 winget 安装；
- **播放器路径**：留空则自动查找（PATH / Program Files / 插件目录）；
- **日志目录**：所有日志写入这里，不可写会在面板上直接报红；点 **浏览…** 可用系统文件夹对话框直接选（本机桌面），远程浏览器场景退回应用内逐级浏览，也可手动填路径；
- **试听时长**（默认 15 秒，5–120 秒）；
- **扫码登录**：生成二维码、检查登录结果；
- **任务开关**：开启 / 停止每日任务，并显示下次运行时间。

面板顶部还有一块 **「最近推荐」**：今日 3 首（带评分，点歌名直接打开网易云），以及最近 7 天的折叠历史——不用打开任何日志文件就能回看。

## 点歌直接播放（VIP 歌曲的解法）

网页版播不了 VIP 歌曲，所以「最近推荐」里的歌名改成了「打开并播放」动作。按你安装的客户端形态自动选择路径：

1. **经典桌面版**（`C:\Program Files\NetEase\CloudMusic\`）：
   实测客户端 3.1.42 **不响应 `orpheus://song/<id>` 深链**（手动粘贴到浏览器也不播放），
   所以插件改用客户端自带的 **本地调试通道（Chromium DevTools Protocol，127.0.0.1:9223）**：
   在客户端搜索框里输入「歌名 歌手」→ 回车 → 点搜索结果的「播放」按钮，效果等同于你在客户端里手动点歌。
   - 客户端未运行时：插件用 `--remote-debugging-port=9223` 启动它，等页面就绪后播放（约 5–10 秒）；
   - 客户端已在运行但没有控制通道（比如你从开始菜单打开的）：插件只能唤起 + 复制歌名，并在提示里说明「关掉客户端后下次点歌即可直接播放」；
   - 调试端口只绑定 `127.0.0.1`，不对外网开放，也不会读取账号凭证。
2. **Microsoft Store（MSIX）版**（运行路径在 `C:\Program Files\WindowsApps\` 下）：
   包清单里没有协议扩展、也不能带参数启动，所以**无法定位到某一首**；插件会打开应用并把「歌名 歌手」复制到剪贴板。
3. **未安装客户端**：回退网页版 `https://music.163.com/#/song?id=<id>`，并提示 VIP 限制。

每首歌右侧另有 **「网页」** 按钮，强制走浏览器；对话里也可以说「打开第 2 首」（`netease_open` 工具），逻辑一致。

客户端是否安装由外部证据判断：`HKCR\orpheus` 协议注册项、`shell\open\command` 里的 exe、常见安装路径、运行中的 `cloudmusic` 进程，或开始菜单里的 Store 应用；结果缓存 60 秒。

### Store 版的限制

如果你装的是**微软商店版**网易云（运行路径在 `C:\Program Files\WindowsApps\` 下）：

- 该版本的包清单里**没有注册 `orpheus` 深链**，也不能直接执行 exe（Windows 会拒绝），所以**无法做到"点歌名直接播放某一首"**；
- 插件会识别到 Store 版，点击歌名时：打开网易云应用 + 把「歌名 歌手」复制到剪贴板，提示里说明原因——你到客户端里粘贴搜索即可；
- 想要"点一下就直接播放"，需要安装[经典桌面版](https://music.163.com/download)；装好后插件会检测到它，并通过本地调试通道在客户端里搜索播放，无需改配置。

## 黑箱测试

照单执行见 [docs/blackbox-test-checklist.md](docs/blackbox-test-checklist.md)：覆盖安装可见性、配置持久化、依赖、扫码登录、定时静默运行、推荐与评价、日志、异常状态、唤起/降级、边界回归。

## 静默播放与评价

播放使用 `mpv --ao=null --volume=0 --mute=yes --no-video`：解码与进度照常推进，但不打开任何音频设备、不弹窗口，**全程没有声音**。

AI 评价基于歌曲资料、可用歌词、时长与播放状态，并在评价里明确标注“未直接听到音频”——文本模型确实听不到声音，不编造旋律、音色、编曲或试听感受。

未安装 mpv 时，工具返回 `PLAYER_NOT_READY`，设置页会提示安装；不会静默跳过。

## 日常使用

- 「按描述推荐」（`netease_plan`）：读设置页里的推荐描述，返回每日推荐 + 关键词搜索的候选与歌词摘要。
- 「搜歌」（`netease_search`）：按关键词搜索候选。
- 「静默试听」（`netease_listen`）：`ao=null` 播放指定候选，返回真实播放状态。
- 「写评价」（`netease_evaluate`）：把 1–5 分与评价写入日志目录（`events.jsonl` + 当日 `.md`）。
- 「保存推荐」（`netease_daily_save`）：保存 3 首推荐与理由，并写入日志。
- 「改设置」（`netease_settings`）：在对话里也能改时间、描述、日志目录等，与设置页同一份存储。
- 「我喜欢 / 不喜欢」（`netease_feedback`）：只记录本机偏好，下次选歌生效。
- 「检查状态」（`netease_status`）：登录、依赖、日志可写、任务、今日进度一屏返回。

同一天重复触发会复用当天候选，已完成的日报不重复改写；去重后没有新歌会如实告知。

## 配置和数据

默认数据目录为 `%USERPROFILE%\.dsh\netease-daily`（尊重 `DSH_HOME`），可用环境变量 `DSH_NETEASE_DATA_DIR` 指定。**可变项都通过设置页配置**，存放在 `settings.json`，不写死在代码里：

- `settings.json`：每日时间、时区、推荐描述、日志目录、试听时长、播放器路径、任务与会话绑定。设置页保存后立即生效。
- `logs/events.jsonl`：追加式事件日志（设置变更、候选计划、静默播放、评价、推荐、错误）。
- `logs/YYYY-MM-DD.md`：当天的推荐与逐首评价（每天一个文件，写入设置页指定的日志目录）。
- `logs/latest.md`：最新一次结果的镜像，适合收藏/分享。
- `logs/index.html`：可点击的历史索引（本地双击即可浏览最近 30 天）。
- **日志保留 30 天**：超过 30 天的日报与事件会在下次写入时自动清理，避免日志目录无限增长。
- `credentials.json`：网易云登录凭证，只留在本机，不写入对话、日志或安装包。
- `history.json`：候选、播放状态、推荐结果与本地偏好。
- `login-qr.png`：临时登录二维码，约两分钟失效。

异常会明确暴露：未登录返回 `NOT_LOGGED_IN`，播放器未就绪返回 `PLAYER_NOT_READY`，日志目录不可写返回 `LOG_DIR_UNWRITABLE`；设置页对应位置报红，不会静默失败。

Harness 必须在运行、电脑必须联网，任务才能执行；定时任务由 Harness 原生 Schedule 持久化。

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
