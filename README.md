# opencli-plugin-flow

把 **Google Labs Flow** 的 **Omni Flash** 视频生成能力变成命令行。借用你 Chrome 里已登录 Flow 的 session（OAuth + reCAPTCHA），**不存任何凭证**，账号扣费完全是你的。

## 能干什么

- 🎬 纯文字生视频 / 图片+文字生视频 (R2V，多参考)
- 💰 提交前自动 dry-run 算积分 + 显示余额
- 🗂️ 图片素材自动 sha256 去重，**重复上传秒命中本地缓存**
- 🔒 跨进程文件锁，多 agent 并发用同一文件不会重复上传
- 📦 项目级别隔离 cache（同一文件在不同 project 各自独立 mediaId）
- 🛡️ 检测 Google reCAPTCHA 静默拒绝（STUB_WORKFLOW），不会让你被骗 ok:true
- 🎯 友好中文表格 + 一键转 csv / json 给 agent 解析

## 价格表（Omni Flash · SERVICE_TIER_ADVANCED）

| 模式 | 时长 | 积分 |
|---|---|---|
| 纯文字 / 多参考 | 4s | 15 |
| 纯文字 / 多参考 | 6s | 20 |
| 纯文字 / 多参考 | 8s | 25 |
| 纯文字 / 多参考 | 10s | 30 |
| 视频编辑 (abra_edit) | ≤10s 输入 | 40 |

参考：75 元 = 45000 积分 ≈ **0.04 元/8s 视频**

## 前置

1. **opencli ≥ 1.7.22** （`npm i -g @jackwener/opencli`）
2. **esbuild** （`npm i -g esbuild`）—— 编译 TS plugin 用
3. **opencli Chrome 扩展** 装好且桥接连通（跑一次 `opencli doctor` 验证）
4. **Chrome 里登录你自己的 Google Labs Flow 账号**（[labs.google/fx/tools/flow](https://labs.google/fx/tools/flow)），打开任意一个项目页

## 安装

```bash
opencli plugin install github:LingJingAI-Labs/opencli-plugin-flow
```

安装时会自动：
- 编译 TS → JS
- 把 SKILL.md 链到 `~/.claude/skills/flow/`（Claude Code 会自动发现）

验证：

```bash
opencli flow credits        # 应该看到你的余额
opencli flow --help         # 12 个子命令
```

## 5 分钟快速开始

```bash
# 1. 切到当前 Flow 项目（在浏览器打开过的）
opencli flow project-list                                    # 看你有哪些项目
opencli flow project-use --projectId <从上一步拿到的 UUID>     # 设默认

# 2. 试算（不扣分）
opencli flow gen --prompt "a cat walking on grass" --length 4 --dryRun true

# 3. 真发（4s = 15 积分 ≈ 0.025 元）
opencli flow gen --prompt "a cat walking on grass" --length 4 --yes

# 4. 等结果（2-4 分钟）
opencli flow job-wait --mediaId <上一步返回的 mediaId>

# 5. 下 mp4
opencli flow job-download --mediaId <ID> --out out.mp4
open out.mp4
```

## 视频编辑 (abra_edit)

```bash
# 自动 chunked resumable 上传，sha256 dedupe
opencli flow media-upload --file ./clip.mp4 --name myclip

# --refVideo 触发视频编辑模式（固定 40 积分；length/aspect 跟原视频一致）
opencli flow gen --prompt "改成晚上 加点雾气" --refVideo myclip --yes

# 也可以直接传路径或 mediaId
opencli flow gen --prompt "..." --refVideo ./clip.mp4 --yes
```

## 多参考图生视频 (R2V)

```bash
# 上传素材，绑别名（同文件多次上传秒命中 cache）
opencli flow media-upload --file ./hero.png --name hero
opencli flow media-upload --file ./bg.jpg   --name bg

# 引用别名生成
opencli flow gen \
  --prompt "hero 走在 bg 草地上" \
  --refs hero,bg --length 8 --aspect 9:16 --yes
```

**`--refs` 三种 token 自动识别**：

| Token | 行为 |
|---|---|
| `hero` | 别名 → 查 cache |
| `./hero.png` | 本地文件 → sha256 dedupe + 上传（cache 命中时秒回） |
| `9a42af9d-...` | UUID → 直接当 mediaId 用 |

可以混用：`--refs hero,./other.png,9a42af9d-...`

## 命令一览

| 命令 | 用途 |
|---|---|
| `flow credits` | 余额 + 账号等级 |
| `flow models` | 全部 Omni 变体 + 价格 + 限制 |
| `flow project-list / current / use` | 项目管理 |
| `flow media-upload <file> [--name]` | 上传图片 + sha256 dedupe |
| `flow media-list` | 列当前项目缓存的素材 |
| `flow gen --prompt ... [--refs ...]` | 生成视频（核心） |
| `flow job-status / job-wait / job-list` | 查询任务状态 |
| `flow job-download` | 下载 mp4 |

每个命令的 `--help` 都有详细参数 + footer 给下一步建议。

## 输出格式

| 想要 | 用 |
|---|---|
| 终端紧凑表格 | `flow xxx`（默认） |
| 长字段不截断 | `flow job-list --full -f csv` |
| 给 agent 用 | `-f json` 或 `-f yaml`（含 mediaId / status_raw / model_raw 等原始字段） |

## 限制 + 已知陷阱

| 情况 | 表现 | 处理 |
|---|---|---|
| **没有 15 秒视频** | model 表只有 4/6/8/10s | Omni 限制 |
| **同账号被同事并发用** | `STUB_WORKFLOW` / `PUBLIC_ERROR_UNUSUAL_ACTIVITY`，钱可能被扣但视频没产出 | 加 `--reload`；或独占账号 |
| **真人脸太像名人** | `CELEBRITY_POLICY` | 换 prompt |
| **mediaId 跨项目用** | 服务端拒 | cache 已按 project 隔离，使用别名时切 project 会失效 |
| **首尾帧** | Omni 不支持 | 用多参考替代 |

## 批量并行

CLI 不内置 queue。剧本批量场景用 shell：

```bash
# 串行（最稳）
for p in "镜头1：早晨" "镜头2：推门" "镜头3：阳光"; do
  opencli flow gen --prompt "$p" --refs hero --length 8 --yes
done

# 并行（GNU parallel；同账号 ≤ 3 并发，避免风控）
parallel -j3 'opencli flow gen --prompt {} --refs hero --length 8 --yes' \
  ::: "镜头1..." "镜头2..." "镜头3..."
```

## 数据存哪

- 项目默认值：`~/.opencli/clis/flow/state.json`
- 素材缓存：`~/.opencli/clis/flow/media-cache.json`（按 projectId 隔离）
- 文件锁：`~/.opencli/clis/flow/locks/<projectId>__<sha256>.lock`
- Claude Code skill: `~/.claude/skills/flow/`（symlink 到此 plugin）

**不存任何 OAuth / cookie / 凭证** —— 每次实时从 Chrome session 取。

## 卸载

```bash
opencli plugin uninstall flow
rm -f ~/.claude/skills/flow                       # 移除 skill symlink
rm -rf ~/.opencli/clis/flow                       # 清缓存（可选）
```

## License

MIT
