---
name: flow
description: 用 Google Labs Flow / Omni Flash 在浏览器登录态下生成视频。覆盖纯文字生视频（T2V）、多参考图生视频（R2V）、图片素材上传与去重复用、任务跟踪、mp4 下载。用户说"生视频 / Flow / Omni / 视频生成 / 短剧分镜 / 参考图生视频"时启用。
---

# Flow CLI

通过 opencli + Chrome 扩展，借用用户已登录的 Flow 网页 session（OAuth + reCAPTCHA），把 Google Labs Flow 的视频生成能力变成 CLI。**不存任何凭证**，账号和扣费完全是用户的。

## 前置条件（每次会话开头快速确认）

1. Chrome 装了 opencli 扩展 + 桥接守护进程在跑（`opencli doctor` 都 OK）
2. **用户自己在 Chrome 登录了 Flow**，并打开了一个 Flow 项目页
3. 用户**对账号独占**（同账号同时在多设备 / 多人用 → 容易被 Google reCAPTCHA 风控）

## 命令一览

| 命令 | 用途 | 写操作？ |
|---|---|---|
| `flow credits` | 查余额 + 账号等级 | 否 |
| `flow models` | 列 Omni 各档时长 / 模式 / 价格 | 否 |
| `flow project-list/current/use` | 切换默认项目 | use 是写 |
| `flow media-upload --file <path> [--name <alias>]` | 上传图片，sha256 自动去重 | 是 |
| `flow media-list` | 列当前项目缓存的图片素材 | 否 |
| `flow gen --prompt "..." [--refs ...]` | 生成视频（核心命令） | 是（扣分） |
| `flow job-status / job-wait / job-list` | 查任务状态 | 否 |
| `flow job-download --out <file>` | 下 mp4 | 否 |

每个命令都加了 `footerExtra`，跑完会自动提示"下一步建议"，沿着提示走就行。

## 价格表（Omni Flash，SERVICE_TIER_ADVANCED）

| 时长 | T2V / R2V 同价 |
|---|---|
| 4 秒 | **15** 积分 |
| 6 秒 | **20** 积分 |
| 8 秒 | **25** 积分 |
| 10 秒 | **30** 积分 |
| 视频编辑 | 40 积分（固定） |

`--count N` 一次出 N 个候选 = N 份钱。**75 元 = 45000 积分**，所以 8s 视频 ≈ 0.04 元一条。

## 关键限制（必记）

- **时长**只有 4 / 6 / 8 / 10 秒，**没有 15 秒**
- **宽高比**只有 16:9（横）和 9:16（竖），无 1:1
- **R2V 模式**：参考图 + 角色 ≤ **7**（无参考视频时），≤ **5**（有参考视频时）；音色 ≤ 5
- **Omni 不支持首尾帧**，靠多参考图实现"画面锚定"
- **同账号高频提交可能被 Google reCAPTCHA 风控**，表现为"我们发现了一些异常活动"。解法：
  - 加 `--reload` 强制刷新 session
  - 或在 Chrome 里手动刷新 Flow 页面 → 重发

## 标准 workflow

### A. 纯文字生视频（最简单）
```bash
# 0. 试算（不扣费）
opencli flow gen --prompt "a cat walking on grass" --length 8 --aspect 9:16 --dryRun true

# 1. 真发
opencli flow gen --prompt "..." --length 8 --aspect 9:16 --yes

# 2. 等结果（轮询，2-4 分钟）
opencli flow job-wait --mediaId <从上一步拿到的 ID>

# 3. 下 mp4
opencli flow job-download --mediaId <ID> --out out.mp4
```

### B. 多参考图生视频（R2V）
```bash
# 1. 先上传素材（绑别名，方便引用）
opencli flow media-upload --file ./hero.png --name hero
opencli flow media-upload --file ./bg.jpg   --name bg

# 2. gen 时 --refs 引用，逗号分隔。token 自动识别为别名/路径/UUID
opencli flow gen \
  --prompt "@hero 在 @bg 草地上奔跑" \
  --refs hero,bg --length 8 --aspect 9:16 --yes

# 同一文件第二次 --refs ./hero.png 会秒命中 sha256 cache，不重传
```

### B2. 视频编辑（abra_edit）
```bash
# 1. 上传视频（≤10 秒，chunked resumable，自动 sha256 dedupe）
opencli flow media-upload --file ./clip.mp4 --name myclip

# 2. 用 --refVideo（注意是单数）触发 abra_edit。会自动用 abra_edit 模型，
#    固定 40 积分，length/aspect 跟输入视频一致（CLI 自动忽略 --length / --aspect）
opencli flow gen --prompt "改成晚上 加点雾气" --refVideo myclip --yes

# 也可以直接传路径，自动 dedupe 上传
opencli flow gen --prompt "..." --refVideo ./clip.mp4 --yes
```

### C. 批量生成（剧本分镜场景）

CLI 单次只跑一个任务。批量并行**用 shell 自己组合**，不在 CLI 内部排队。

```bash
# 串行（最稳，绝对不会触发风控）
for p in "镜头1：宁静的早晨" "镜头2：人物推门" "镜头3：阳光照进"; do
  opencli flow gen --prompt "$p" --refs hero --length 8 --yes
done

# 并行 3 路（用 GNU parallel；同账号建议 ≤ 3，避免风控）
parallel -j3 'opencli flow gen --prompt {} --refs hero --length 8 --yes' \
  ::: "镜头1..." "镜头2..." "镜头3..."

# 提交后 mediaIds 都在 stdout / -f json 里，统一 wait
parallel -j5 'opencli flow job-wait --mediaId {} && opencli flow job-download --mediaId {} --out {/.}.mp4' \
  ::: <mediaId1> <mediaId2> <mediaId3>
```

## 输出格式速查

| 想要 | 用 |
|---|---|
| 终端紧凑表格（默认） | `flow xxx` |
| 长字段不截断 | `flow job-list --full -f csv` |
| 给 agent 解析（含 raw enum）| `flow xxx -f json` 或 `-f yaml` |
| 单条查看完整 prompt | `flow job-status --mediaId <id>` |

## 错误处理速查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `STUB_WORKFLOW` | reCAPTCHA 静默拒，钱扣了 workflow 不存在 | 加 `--reload` 重试 |
| `RATE_LIMIT` | 429 | 等 30s 重试 |
| `CONTENT_POLICY` / `CELEBRITY_POLICY` | 违反内容/名人政策 | **不要重试**，换 prompt |
| `AUTH` | 401/403 | 让用户在 Chrome 重新登录 Flow |
| `INSUFFICIENT_CREDITS` | 余额不足 | 充值或缩短/减少 |

## 不要做的事

- 不要为了"加快"用户操作，**在用户没明示前**触发 `flow gen --yes` —— 写命令永远先 dry-run 让用户看到要花多少
- 不要在风控警告（STUB_WORKFLOW）出现后**继续重试** —— 加 `--reload` 是一次重试，再失败要让用户判断（很可能是账号并发占用）
- 不要把缓存里的 mediaId 跨 project 用 —— cache 是按 projectId 隔离的，切 project 时旧别名失效
