# Performance Analysis and Profiling Plan

本文档把课程 `INSTRUCTIONS.md` 的 Performance Analysis 要求拆成可实现、可复现、可逐次 review 的工程计划。目标不是只做一个更漂亮的 FPS 面板，而是建立同一套低开销测量基础，同时服务于：

1. 交互时随 renderer / light count / cluster strategy 自动变化的实时 Overlay；
2. 固定变量、批量运行、导出原始数据并生成图表的正式实验；
3. Forward+、Clustered Deferred 及额外优化之间可解释的 pass-level 对比。

本计划只定义实现路线，不把尚未采集的数据写成性能结论。

## 1. 课程要求如何落到本项目

课程要求至少回答：

- Forward+ 和 Clustered Deferred 哪个更快，以及分别适合什么 workload；
- 每项优化的 before / after render time；
- light count、tile count 等参数如何影响性能，并使用图表；
- 报告使用毫秒，不使用 FPS 作为主要实验指标；
- 最好能把 debug view 或 workload 特征与性能联系起来；
- 对优化给出 best case、worst case 和 tradeoff。

因此最终证据不能只有 FPS 截图。每个正式结论至少要保存：

- 控制变量；
- 原始逐帧样本；
- GPU pass timing；若 timestamp-query 不可用，只保留 CPU/frame-pacing diagnostics，不据此得出 GPU 性能结论；
- median、p95 和重复实验结果；
- 对应 renderer、分辨率、light count、cluster 配置、camera pose 和运行环境。

## 2. 当前基线的真实含义

### 2.1 `stats.js` 现在测到什么

当前 `Renderer.onFrame()` 在 `draw()` 前后调用 `stats.begin()` / `stats.end()`。

- FPS panel 不是严格的 rolling window；它累计约一秒内的 frame 数，然后清零开始下一个统计桶。
- MS panel 显示最近一次 `begin()` 到 `end()` 的 CPU wall-clock duration，并保留从页面启动以来的 min/max。
- `draw()` 主要在 CPU 上编码 WebGPU commands 并调用 `queue.submit()`。GPU 异步执行，所以这个 MS 不是 GPU render time。
- `camera.onFrame()`、`lights.onFrame()` 和 light-movement command submission 位于 `stats.begin()` 之前，因此现有 MS 甚至不是完整 CPU frame cost。
- `performance.memory` 若存在，代表 JavaScript heap，不是 GPU VRAM。

结论：保留 FPS 作为交互流畅度提示没有问题，但正式比较必须增加独立测量层。

### 2.2 Fixed 与 adaptive 的当前含义

当前 fixed clustering：

- 每个 cluster 预留 `maxLightsPerCluster = 128` 个 index；
- 一个 compute pass 完成相交测试和写入；
- 单个 cluster 超过 128 时会 overflow。

当前 adaptive clustering：

- count pass 先计算每个 cluster 的 candidate count；
- 一个 `@workgroup_size(1)` 的 prefix pass 串行分配全局 index pool；
- fill pass 再次执行 light / cluster 相交测试并写入；
- 使用的全局 index pool 总容量仍是 `clusterCount * 128`，当前并没有减少这块 buffer 的分配量。

所以 adaptive 的首要价值是把未被稀疏 cluster 使用的容量转给密集 cluster，而不是天然更快或更省显存。它多两个 pass、相交测试执行两次，并且当前 prefix 是串行的。实验必须同时回答：

- adaptive 是否减少了 overflow / dropped light references；
- 这种正确性或容量弹性付出了多少 GPU time；
- 在什么 light distribution 下它有收益；
- 全局 pool 耗尽时是否出现前部 cluster 优先、后部 cluster 饥饿。

## 3. 指标的可行性分级

### 3.1 实时 Overlay 应显示的核心指标

| 指标 | 数据源 | 展示方式 | 目的 |
| --- | --- | --- | --- |
| Resolution | canvas physical width x height | 单值文本 | 防止 DPR / 窗口变化破坏对比 |
| Frame interval | `requestAnimationFrame` delta | median + p95，ms | 反映用户实际看到的 frame pacing，含 vsync / browser interference |
| GPU frame work | renderer command encoder 中第一个被测 pass 开始到最后一个被测 pass 结束的 timestamp span | median + p95，ms | 正式 renderer 性能的主要实时指标 |
| Timing status | active / unavailable / warming up / paused | 状态文本 | 不允许把 CPU 指标误认成 GPU 值 |

Render mode、cluster strategy 和 light count 已存在于 dat.GUI，FPS 已存在于 `stats.js`，Overlay 不重复展示。第一版默认只显示 resolution、frame pacing median/p95、GPU frame median/p95 和 timing status。CPU update、CPU encode + submit、sample count 与 GPU pass breakdown 放在可折叠 Details 中。

### 3.2 低频 workload diagnostics

以下数据需要 GPU buffer readback，不能每帧读取：

- active cluster count；
- average / median / p95 / max accepted lights per cluster；
- max candidate lights per cluster；
- overflow cluster count；
- dropped light-reference count；
- fixed capacity utilization 或 adaptive global-pool utilization。

它们应当采用以下两种方式之一：

- Overlay 中每 1 秒或手动触发一次诊断快照；
- benchmark 每个 scenario 在 timing samples 完成后读取一次。

不要把 diagnostic readback 插在每个正式 timing frame 中。

## 4. Rolling window 与不同数据格式

### 4.1 适合共用 rolling window 的连续时序数据

下列每帧产生一个数值，可以共用按时间淘汰的 ring buffer 和相同统计函数：

- frame interval；
- CPU update time；
- CPU encode + submit time；
- `renderer_gpu_ms`；
- 各 GPU pass time。

live window 保存最近 1 秒内所有已经完成 readback 的有效样本。每个新样本到达时删除时间戳早于 `now - 1000 ms` 的旧样本，因此它是连续向前移动的 sliding window，不是 `stats.js` 那种每秒清零一次的固定统计桶。在 60 FPS 时通常约有 60 个样本，在 120 FPS 时通常约有 120 个样本。

窗口输出：

- median：作为默认中心值，抗偶发 browser spike；
- p95：展示卡顿尾部；
- optional EMA：只用于视觉上平滑的单行即时读数，不进入 CSV summary；
- sample count：用于判断窗口覆盖时间是否足够；尚未覆盖完整 1 秒时显示 warming up。

median/p95 只在新的 profiling 结果可用时，从当前窗口复制并排序。窗口通常只有几十到一百多个数值，排序本身预计很小，但仍在 observer-effect audit 中实测。历史队列有严格的 1 秒上限，不允许随运行时间增长。

不要把 lifetime min/max 当成主要指标，因为一次 tab 切换或 shader 首次编译就会永久污染它。

### 4.2 不适合 rolling window 的状态数据

mode、strategy、light count、resolution、camera preset、tile size、depth slices 是 experiment dimensions，应显示当前值，并在改变时开始新的 measurement epoch。

任何 dimension 改变后：

1. 增加 epoch，清空 live timing window；
2. 丢弃前 30 个 live frames，状态显示 `WARMING UP`；
3. 再收集最近一秒的有效样本；
4. 窗口覆盖完整一秒后切换为 `ACTIVE`。

不能把切换前后的帧混在一个平均值里。

这里的 30-frame live warmup 只服务 Overlay；正式 benchmark 的 warmup protocol 在 7.2 单独定义，二者不能混用。

### 4.3 不适合每帧滚动的分布数据

cluster occupancy / overflow 是一整个 cluster array 的分布。Overlay 用低频 snapshot，格式为：

- `clusters active / total`；
- `lights per active cluster: median / p95 / max`；
- `overflow clusters`；
- `dropped references`；
- `pool utilization`。

正式结果保存 snapshot histogram 或 summary，而不是把所有 cluster 值塞进帧时间 window。

## 5. 测量架构与项目结构

新增横切模块放入独立目录，避免把 CSV、DOM 和统计逻辑散落到每个 renderer：

```text
src/
  performance/
    rolling_window.ts       # one-second time window, median and percentile
    profiler.ts             # metric types, epochs, CPU/GPU timing and readback ring
    overlay.ts              # DOM presentation only
    benchmark.ts            # added later: scenario and benchmark state machine
    export_results.ts       # added later: JSON/CSV download
  stage/
    ...                     # still owns camera, lights, clusters and scene data
  renderers/
    ...                     # still owns render-pass orchestration
  shaders/
    ...                     # still owns WGSL

docs/
  performance-analysis-plan.md
  performance/
    methodology.md          # finalized machine/browser/test protocol
    results/
      <run-id>/
        metadata.json
        samples.csv
        summary.csv
        charts/
```

Ownership rules：

- `main.ts` 只负责创建 profiler / overlay / benchmark controls，并把 renderer mode changes 通知 profiler；
- `Renderer` 负责 frame 生命周期，不负责统计公式或 DOM；
- renderer subclasses 只声明 pass boundary，例如 `forward_shading`、`gbuffer`、`deferred_lighting`；
- `Lights.doLightClustering()` 只声明 assignment clustering pass boundary；starter `Lights.onFrame()` 保持原样且不纳入 renderer GPU timing；
- `profiler.ts` 统一聚合 CPU/GPU samples；
- `overlay.ts` 只读取 snapshot，不发起 GPU readback；
- benchmark results 不放进 `src/`，也不手工复制 Overlay 上的数字。

### 5.1 统一 pass taxonomy

使用稳定名称，便于不同 renderer 对齐：

- `cluster_fixed`；
- `cluster_adaptive_count`；
- `cluster_adaptive_prefix`；
- `cluster_adaptive_fill`；
- `forward_shading`；
- `gbuffer_geometry`；
- `deferred_lighting_fullscreen`；
- `deferred_lighting_compute`；
- `visibility_geometry`；
- `visibility_lighting_compute`。

统一保存两个不同指标：

- `renderer_gpu_ms`：renderer command encoder 中第一个被测 pass begin 到最后一个被测 pass end 的 timestamp span。Forward+/Deferred 从 clustering 开始，Naive 从其 render pass 开始；不包含 starter light motion、browser compositing、presentation 或 display scan-out。
- `pass_busy_sum_ms`：当前 frame 所有被测 pass duration 之和，只用于解释 pass 间隙和 breakdown。

Overlay 默认显示 `renderer_gpu_ms`。pass 未出现时保持 absent，不写成 0。

## 6. GPU timestamp-query 的实现原则

`timestamp-query` 是 WebGPU optional feature。初始化时应：

1. 检查 `adapter.features.has('timestamp-query')`；
2. 若存在，与当前其他 optional features 一起请求；
3. 若不存在，项目仍正常渲染，Overlay 明确显示 `GPU timing unavailable`；
4. 不用 CPU `performance.now()` 冒充 GPU pass duration。

每个 assignment renderer/clustering pass 使用 pass descriptor 的 `timestampWrites` 记录 begin/end。结果经 `resolveQuerySet()` 写入 resolve buffer，再复制到 staging/readback buffer。不要为了 profiling 修改或包裹 starter light-motion pass。

为减少 observer effect：

- 默认尝试为每一帧写入 GPU timestamps；
- 使用有界 staging ring，读取已经落后数帧的 slot；slot 状态只能是 free、pending、mapping 或 ready；
- 若所有 slot 都在使用，跳过这一帧的 profiling 并增加 dropped-sample counter，绝不追加一个无界等待任务；
- 不在 render loop 中 `await mapAsync()`；未准备好就跳过该次 UI 更新；
- 不在每帧调用 `queue.onSubmittedWorkDone()`；
- Overlay 每个 rAF 都可检查并展示最新 ready sample；没有新结果时保留上一个值，不排队重放旧结果；
- DOM 只更新少量已有 text nodes，且仅在显示字符串实际变化时写入；
- 正式 benchmark 关闭 Overlay，并在一个 trial 结束后批量读取结果；
- 增加 profiler-on / profiler-off 空载 A/B，量化 instrumentation overhead。

Chrome 可能量化 timestamp 精度。metadata 必须记录 timestamp feature 是否可用，以及实验是否启用了 WebGPU developer features；不同设置的数据不可直接混合。

## 7. Benchmark runner：把控制变量实验做成产品功能

正式 benchmark 不依赖手动拖 GUI、抄数字或目测稳定。它是基于 frame loop 的状态机：

```text
apply scenario
  -> reset measurement epoch
  -> warm up
  -> collect timed samples
  -> collect one diagnostic snapshot
  -> save trial
  -> next repeat / scenario
  -> export raw + summary
```

### 7.1 必须固定的变量

- physical canvas resolution 和 devicePixelRatio；
- browser、browser flags、GPU、driver、OS；
- Sponza scene 与 renderer build/commit；
- camera preset；
- light count；
- renderer mode；
- fixed/adaptive strategy；
- tile size、depth slice count、max lights per cluster；
- warmup frames、sample frames、repeat count；
- tab visibility、Overlay on/off。

starter light animation 和随机颜色初始化保持原样，不注入 benchmark clock、不修改 seed。动态灯光位置作为 workload 的一部分，通过足够长的 measurement、重复 trials 和交替/随机 scenario 顺序降低时间漂移影响。相机仍保存为命名 preset，并在每个 scenario 前恢复，而不是依赖操作者站在“差不多的位置”。

Resolution 不是当前运行时可热切换的配置：canvas、cluster buffers 和 attachments 都按启动尺寸创建。每个分辨率 scenario 必须先设置目标物理窗口尺寸并重新加载页面，确认实际 `canvas.width x canvas.height` 后再 warm up；不要在旧 renderer 上直接 resize 后继续测量。

### 7.2 每个 scenario 的默认协议

首版建议：

- warmup：120 frames；
- measurement：300 valid GPU samples；
- repeats：5；
- scenario 顺序：每个 repeat 中打乱或正反交替，减少温度/后台负载随时间漂移的偏差；
- summary：median、p95、mean、standard deviation、valid/invalid sample count；
- renderer/strategy 切换后的 shader compilation、resource construction 和前若干帧不进入样本。

最终协议可根据单次运行时长缩放，但所有图表使用同一协议，并保存原始样本。

### 7.3 结果 schema

`metadata.json` 至少包含：

- schema version、run ID、date；
- Git commit 和 dirty-worktree flag；
- user agent、adapter info（能获得多少记录多少，不补猜测值）；
- physical resolution、DPR；
- timing capability / quantization configuration；
- camera preset；
- warmup、sample、repeat settings。

`samples.csv` 每行一个 valid sampled frame：

- run / scenario / repeat / frame ID；
- renderer、strategy、lights、resolution；
- CPU metrics；
- `renderer_gpu_ms`、`pass_busy_sum_ms` 与各 pass timing；
- dropped/invalid reason（若该行无效）。

`summary.csv` 每行一个 scenario/repeat 或 aggregate，禁止只保留 summary 而丢弃 raw samples。

## 8. 实验矩阵

### Experiment A：核心 renderer scalability

目的：回答课程要求的 Forward+ vs base Clustered Deferred。

- renderer：Forward+、Clustered Deferred base；
- strategy：fixed；
- lights：以 `50, 100, 250, 500, 1000, 2000, 5000` 作为候选 sweep；先做 pilot run，极慢帧、device loss 或不稳定出现时停止上探，不强制所有 renderer 跑满 5000；
- resolution：先固定一个报告分辨率，例如 `1920x1080 physical pixels`；
- camera：至少一个固定 Sponza preset；
- 输出：`renderer_gpu_ms` vs light count；selected light counts 的 pass stacked bars；median 与 p95。

Naive 可作为低 light count reference，但高 light count 可能触发极慢帧或 TDR。对 Naive 设置独立安全上限，不为了补齐曲线强行跑到 5000。

### Experiment B：fixed vs adaptive

目的：区分“更快”与“更少 overflow”。

- renderer：Forward+、Clustered Deferred base；
- strategy：fixed、adaptive；
- lights：与 Experiment A 相同；
- 同时采集：clustering pass breakdown、`renderer_gpu_ms`、overflow clusters、dropped references、pool utilization；
- 至少两个 camera/light-distribution preset：普通分布与容易形成密集 cluster 的 worst-case。

预期要验证而不是预设：

- fixed 可能因为单 pass 在未 overflow 时更快；
- adaptive 可能在 dense/skewed distribution 下保留更多正确 light references；
- 当前串行 prefix 和双重相交测试可能使 adaptive 变慢；
- 全局 pool 饥饿模式可能使 overflow 从“局部截断”变成“顺序相关截断”。

### Experiment C：frame-budget frontier

目的：把“某个 ms 下能放多少灯”变成可回答的问题。

对每个 renderer/strategy，寻找满足以下条件的最大 light count：

- median GPU frame <= `8.33 ms`（120 Hz budget）；
- median GPU frame <= `16.67 ms`（60 Hz budget）；
- median GPU frame <= `33.33 ms`（30 Hz budget）；
- 同时报告 p95 是否超过该 budget；
- 同时要求 overflow / dropped references 在定义的正确性门槛内。

搜索可先粗粒度扫描，再在跨过 budget 的区间二分或细化。不能只按 FPS >= 60 判断，因为 vsync 与 rAF 会把 GPU cost 隐藏在 frame pacing 中。

### Experiment D：resolution scaling

目的：区分随像素数增长的 rendering cost 与 cluster/light-list cost，不把增长原因直接写成未经硬件计数器验证的 bandwidth 结论。

- resolutions：例如 `1280x720`、`1920x1080`、`2560x1440`，均指 physical pixels；
- 固定 camera、lights、strategy；
- 比较 forward shading、G-buffer geometry、deferred lighting 的增长率；
- 同时记录 cluster grid 随分辨率变化后的 cluster count，避免把 resolution 与 tile count 混为单一变量。

### Experiment E：cluster configuration

在核心比较稳定后再做：

- tile size：例如 `32, 64, 128`；
- depth slices：例如 `16, 24, 32`；
- 固定 resolution、camera、lights；
- 输出 GPU time、average lights/cluster、overflow。

该实验需要把 cluster configuration 从当前 startup-time constants 改成可重建资源的 configuration。不要在 profiling 第一阶段同时实现。

### Experiment F：extra-credit before/after

当前工作区正在开发 base deferred、packed compute deferred 和 visibility buffer。正式比较必须等各模式先通过视觉/validation correctness gate。

- base MRT deferred vs packed single-color G-buffer + compute lighting；
- packed deferred vs visibility buffer；
- 记录 `renderer_gpu_ms` 和 pass breakdown；
- 使用相同 scene、camera、resolution、lights、cluster strategy；
- debug view 只用于解释 producer/consumer 正确性，不与 final-lighting timing samples 混跑。

## 9. 图表与最终分析模板

至少生成：

1. renderer GPU ms vs light count 折线图；
2. fixed vs adaptive 的 clustering/`renderer_gpu_ms` 折线图；
3. fixed vs adaptive 的 overflow/dropped references 图；
4. selected workloads 的 pass stacked bar；
5. 8.33/16.67/33.33 ms budget 下最大可支持 light count；
6. extra optimization 的 before/after bar。

每张图标题或 caption 写明：GPU/browser、resolution、camera preset、sample protocol、metric 是 median 还是 p95。Y 轴使用 ms。FPS 只可作为补充交互截图。

分析时按以下顺序：

1. 先说明观察到的测量结果；
2. 再用 pass breakdown 和 cluster occupancy 解释；
3. 写出 best case、worst case 和 tradeoff。

## 10. 分阶段实现与 review 单元

每次只实现下面一个编号，不合并跨阶段大改。

### 0.1 计划与测量契约（本文件）

目标：固定术语、证据边界、目录和实验矩阵。

验收：不修改 renderer 行为；review 后再开始源代码实现。

### 1.1 纯 TypeScript rolling statistics

文件：`rolling_window.ts`；共享 sample types 暂放 `profiler.ts`，不额外建立只含少量声明的模块。

目标：实现最近一秒的有界 time window、median、p95、epoch reset；不接 GPU、不改 UI。

验收：已知小数组的 percentile 结果正确；`npm run build` 通过到项目已知的 packaging 边界。

### 1.2 CPU frame sample 与 mode epoch

文件：`profiler.ts`、`renderer.ts`，少量 `main.ts` wiring。

目标：分别记录 frame interval、CPU update、CPU encode+submit；mode/strategy/light/resolution 改变时清窗并 warm up。

验收：切换 renderer 后 sample count 从零重新增长；数值明确标为 CPU。

### 1.3 最小 Overlay

文件：`overlay.ts`、`main.ts`。

目标：每个 rAF 展示最新可用数据；默认显示 resolution、frame pacing median/p95 与 timing status，CPU 数据放入 Details；不做 GPU readback。

验收：切换 renderer、strategy、lights 时 UI 自然更新；Overlay 开关不影响渲染正确性。

### 2.1 Timestamp capability 与 GPU timer infrastructure

文件：`renderer.ts` 初始化、`profiler.ts`。

目标：optional feature detection、query/resolve/readback ring、unsupported fallback；尚不改所有 renderer。

验收：支持设备产生单个测试 pass duration；不支持设备继续运行并显示 unavailable；render loop 中没有 blocking await。

### 2.2 Fixed/adaptive clustering timing

文件：只在 `lights.ts` 的 assignment clustering 路径接入 profiler pass schema；不修改 starter `onFrame()` light motion。

目标：准确拆分 fixed pass、adaptive count/prefix/fill。

验收：fixed 只有一个 cluster pass；adaptive 有三个；切换策略后 epoch reset。

### 2.3 Forward+ GPU timing

文件：`forward_plus.ts`。

目标：得到 `forward_shading`、完整 GPU-frame span 与各 pass duration sum，先用一条成熟路径验证端到端架构。

验收：GPU frame span 使用首个 pass begin 到最后一个 pass end；pass sum 独立保存用于解释中间间隔；两者都不包含旧 epoch 样本。

### 2.4 Renderer-by-renderer timing integration

每个 renderer 单独一个 review：

- 2.4a base Clustered Deferred；
- 2.4b packed compute Deferred；
- 2.4c Visibility Buffer；
- 2.4d Naive reference。

目标：使用统一 taxonomy，不在 subclass 复制 query/readback 实现。

验收：每种模式只出现属于自己的 pass；runtime validation 无新增错误。

### 2.5 Observer-effect audit

目标：同一稳定 workload 比较 profiler off、timestamp only、timestamp + live Overlay。

验收：记录 median difference；若开销不可忽略，先定位 timestamp、readback、排序或 DOM 中的来源，再针对来源优化；正式 benchmark 固定 Overlay off。

### 3.1 Cluster diagnostic snapshot

文件：在 `profiler.ts` 聚合结果，并在 `clusters.ts` 添加最小 readback 支持；确认需求增长前不新建独立 diagnostics framework。

目标：低频读取 metadata/overflow，计算 occupancy、accepted/candidate/dropped/pool utilization。

验收：手动 snapshot 不阻塞连续 frame loop；fixed/adaptive 格式统一；诊断读取不进入 timed frames。

### 3.2 Controlled benchmark inputs

目标：camera preset、页面重载后的 physical resolution verification，以及不修改 starter light animation 的重复实验协议。

验收：同一 scenario 重跑得到相同配置和 camera；动态灯光保持官方 rAF 行为，通过重复 trials 覆盖其变化。

### 3.3 Benchmark state machine

文件：`benchmark.ts`。

目标：apply -> warmup -> sample -> diagnostic -> repeat，无手工抄数。

验收：先只跑两个小 scenario；切换期样本不会进入 measurement。

### 3.4 JSON/CSV export

文件：`export_results.ts`。

目标：导出 metadata、raw samples、summary；schema versioned。

验收：summary 可从 raw samples 重建；缺失 GPU timing 时字段为空并带 reason，而不是写 0。

### 4.1 核心实验 A

目标：Forward+ vs base Deferred light scaling。

验收：raw data、summary、图表和环境 metadata 齐全；结果使用 ms。

### 4.2 fixed/adaptive 实验 B

目标：把 timing 与 overflow/correctness 一起解释。

验收：不以“更少 overflow”替代“更快”，也不以“更快”掩盖 dropped lights。

### 4.3 budget frontier 与 resolution experiments

目标：完成 Experiment C、D；只有需要时再实现 E。

验收：所有比较共享 camera/protocol，图表 caption 完整。

### 4.4 Extra-credit before/after

目标：在 correctness gate 之后测 base、packed、visibility。

验收：保存 `renderer_gpu_ms`/pass measured data，并明确区分测量结果与原因解释。

## 11. Correctness gate 与性能 gate 分离

任何 renderer 进入 benchmark 前必须先满足：

- shader compilation / WebGPU validation console 无错误；
- final view 与 reference 的主要几何、材质、光照一致；
- debug views 能定位 G-buffer/visibility producer；
- fixed/adaptive overflow 语义已知；
- mode switching 不使用 stale resources；resolution scenario 通过页面重载创建匹配尺寸的资源。

`npm run build` 或 Vite transform 只能证明打包/type-level 状态，不能证明 WGSL runtime compilation、视觉正确性或 GPU timing 正确。每个实现阶段都应分别报告 static/build、runtime validation、visual acceptance 和 measurement evidence。

## 12. 第一轮实施建议

Performance implementation 当前暂停。恢复前先完成以下 prerequisites：

1. Packed Deferred 与 Visibility Buffer 在浏览器中通过 WGSL/runtime validation；
2. final/debug views 完成视觉验收；
3. 当前 bind-group/material-binding 优化被接受为稳定 baseline。

恢复 profiling 时只做 **1.1：pure rolling statistics**，随后按 `1.2 -> 1.3 -> 2.1` 前进。不要同时实现 Overlay、GPU timestamps 和 benchmark runner。

## References

- [WebGPU specification](https://gpuweb.github.io/gpuweb/)
- [Chrome WebGPU developer features](https://developer.chrome.com/docs/web-platform/webgpu/developer-features)
- [GPUQuerySet reference](https://developer.mozilla.org/en-US/docs/Web/API/GPUQuerySet)
