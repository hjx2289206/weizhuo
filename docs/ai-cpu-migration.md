# 通用 CPU 模型推理迁移（2026-10-18）

五个出牌网络统一为 ONNX Runtime `CPUExecutionProvider`。不使用 MPS、CoreML、CUDA；服务的 `.ai/venv` 没有安装 Torch。原始训练权重保留，出牌候选生成、观测编码、强易档策略、服务端合法性校验与取消保护沿用原机制。

## 文件与环境

- `.ai/models/guandan-danlm.onnx`：由 Dansformer 原始 `.pt` 导出，标准 ONNX 算子、动态历史长度与候选数量，约 16 MB。
- `.ai/models/guandan-danzero.onnx`：原始易档 ONNX，逐字节复制，约 2.6 MB。
- `.ai/models/douzero-{landlord,landlord_down,landlord_up}.onnx`：三个官方角色原始 `.ckpt` 导出，动态候选数量，各约 6 MB。
- `.ai/models/manifest.json`：原文件与 ONNX 的 SHA256、大小、导出版本、转换时评分校验结果。worker 加载模型时验证校验和。
- `server/bots/onnx_cpu.py`：共用 CPU 会话配置，默认两个计算线程、一个会话间线程，限制线程数为 1–4，禁用执行后端回退。
- `server/bots/guandan_onnx.py`：直接调用编码器和分词器，再输入 ONNX；不再导入上游 UIAgent、eval 或 model 模块。
- `.ai/export-venv` 与两个旧 venv 仅供离线导出或原版对照。服务推理只使用 `.ai/venv`。

## 复现

新安装先执行原有两个 setup 脚本，自动准备源码、原始权重、导出模型及推理环境。已有上游源码与权重时可以单独执行：

```bash
bash scripts/ai-export.sh
bash scripts/ai-setup.sh
npm run test:ai
```

原版整局评分和公开状态审计需要带 Torch 的离线导出环境：

```bash
.ai/export-venv/bin/python scripts/ai-parity.py
.ai/export-venv/bin/python scripts/douzero-audit.py --games 3
```

迁移时复制模型包和所需源码，重新创建 venv，不要复制另一个操作系统的 venv。可用 `AI_PYTHON` 指定推理解释器、`AI_MODEL_DIR` 指定模型目录、`AI_CPU_THREADS` 调整计算线程。`AI_SETUP_PYTHON` 与 `AI_EXPORT_PYTHON` 分别指定创建两个环境的解释器。

## 当前验证

本机 macOS ARM64，以原始 CPU 模型为参考，使用固定种子。以下只衡量本机 CPU，不能外推为 Linux 或其他服务器性能。

| 模型 | 整局决策数 | 最大评分绝对误差 | 最高分动作一致 | 原 CPU / ONNX CPU 中位评分耗时 |
| --- | ---: | ---: | --- | ---: |
| 掼蛋强档 | 516 | 9.06e-6 | 全部 | 4.71 / 3.00 ms |
| 掼蛋易档 | 545 | 0 | 全部 | 0.58 / 0.35 ms |
| 地主 | 70 | 7.63e-6 | 全部 | 0.29 / 0.15 ms |
| 地主下家 | 69 | 1.25e-6 | 全部 | 0.29 / 0.15 ms |
| 地主上家 | 68 | 1.07e-6 | 全部 | 0.30 / 0.15 ms |

掼蛋覆盖每个模型六副完整对局（级牌 2、7、A，有/无进还贡记录），斗地主六局完整对局。对比逐项评分 `rtol=1e-4, atol=1e-5`，同时要求 argmax 一致。这说明已测决策保持一致，不代表所有可能牌局逐位数值相同，也不是胜率评测。

另有斗地主三局、195 个状态的官方观测审计：公开状态重建、张量编码和最高分动作全部一致，覆盖过牌、连续两次过牌、底牌已出与炸弹后状态。

干净推理环境验证五个模型不同候选数量及长历史输入，并确认 worker 没有加载 Torch 或 DanLM model/eval 模块。`npm run test:ai` 另行运行真实 worker → Node 候选校验 → 本项目权威规则引擎连续两副对局，覆盖两档模型与进还贡。

本次集成验证完成：掼蛋两副分别 91、85 次决策，第二副完成两次进还贡操作；斗地主强档一局 36 次决策、易档一局 49 次决策，均正常结算。通过真实服务的 WebSocket 创建两款游戏房间、添加机器人、开启托管和开始游戏，两房间均接受至少两手出牌，AI 可用且无错误响应。

独立创建 `.ai/export-venv` 后，已重新运行正式导出脚本：四个模型文件逐字节复现，Transformer 导出图的参数字节、节点数量和样本评分相同（文件包含不同导出上下文元数据，因此整体哈希不同）。新导出包同样通过所有动态输入评分检查。原始 Transformer 最大历史长度为 1280；适配器保持超长时报错，不静默截断历史。

评分耗时不含规则枚举、掼蛋历史重放、JSON 通信和动画等待。它不等于界面看到的出牌间隔。

## Linux 尚未完成的边界

ONNX 模型图已是通用格式，推理适配器没有 Apple 专用接口。**尚未在 Linux 实机执行验证。**

斗地主的上游规则与观测编码是 Python 源码。掼蛋的 `danzero.engine`、`danzero.encoding`、tokenizer 仍是上游发布的 macOS / CPython 3.12 二进制扩展；此次保留它们以确保规则与编码一致。因此整个掼蛋服务仍依赖 macOS，完整迁移 Linux 还需要替换或移植这部分，并重新做编码及对局一致性验证。不能仅复制五个 ONNX 就称整个项目已兼容 Linux。
