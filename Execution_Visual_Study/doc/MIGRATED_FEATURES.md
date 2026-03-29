# VisualPilot 已迁移功能说明

本文档说明当前从 `helloworld-sample` 迁移到 `visualPilot` 的可用能力（截至当前代码状态）。

## 1. 已支持功能

1. Python 插桩配置与执行
- 命令：`VisualPilot: Init Python Trace`
- 命令：`VisualPilot: Run Python Trace`
- 命令：`VisualPilot: Visualize Suspicious Test Task`
- 支持在 Webview 中配置 `entry_point` 与高级 JSON 参数
- 配置文件落盘到工作区：`__debug/trace/inst.json`
- 执行入口脚本：扩展目录下 `python_inst/main.py`
- 新增可疑测试可视化一键流程：`step0插桩 -> step1_2设计 -> step2二次插桩 -> step3设计`
- 新流程将中间过程与结果统一落盘到：`__debug/anime/design/engine_runs/<run_id>`
- `--model debug` 时支持在 VS Code 中编辑 `query.txt` / `response.txt` 并继续会话

2. 左侧 Trace Timeline 可视化
- 活动栏容器：`VisualPilot`
- 视图名称：`Trace Timeline`
- 视图 ID：`ttdTraceView`
- 支持在列表中点击 trace 项并跳转源文件对应行
- 支持 Step Properties 区域展示 read/written 变量

3. Trace 数据刷新
- 命令：`VisualPilot: Refresh Trace Data`
- 视图标题栏提供刷新按钮
- 会监听工作区 `__debug/**/trace.json` 文件变化并自动刷新

4. 打开可视化入口
- 命令：`VisualPilot: Open Trace Viewer`
- 会切换到活动栏 `visualpilot-trace-explorer`

## 2. 命令清单

- `visualPilot.initPythonTrace`
- `visualPilot.runPythonTrace`
- `visualPilot.runSuspiciousVisualization`
- `visualPilot.openTraceViewer`
- `visualPilot.refreshTrace`

## 3. 关键文件约定

1. 运行配置
- `__debug/trace/inst.json`

2. Trace 输入（视图读取优先级）
- `__debug/debugpilot/trace.json`（优先）
- `__debug/trace/trace.json`

## 4. 使用流程（推荐）

1. 打开一个 Python 工程工作区。
2. 执行 `VisualPilot: Init Python Trace`，确认 `entry_point` 并保存。
3. 在初始化面板中点击 Confirm and Run（会触发 Python 插桩执行）。
4. 打开左侧 `VisualPilot -> Trace Timeline` 查看结果。
5. 如需更新显示，执行 `VisualPilot: Refresh Trace Data`。

## 5. 当前迁移边界

以下能力目前未迁移到 `visualPilot`：
- Java 插桩相关能力
- DebugPilot 计划面板（Debugging Plan）与其配套功能
- 其他仅在 `helloworld-sample` 中存在的调试扩展模块
