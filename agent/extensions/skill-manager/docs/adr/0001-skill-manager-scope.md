# 0001-Skill Manager 职责拆分：仅管理配置，不管理包生命周期

skill-manager 扩展的职责定为**skill 配置管理**（触发模式和可见性），不再包含包生命周期操作（安装、卸载、更新）。这些操作由 pi CLI（`pi install`/`pi remove`/`pi update`）直接处理，避免了在一个命令扩展里混合两类不同性质的职责。

**考虑过的替代方案**：保持 skill-manager 作为一站式入口，包含 config + install/update/remove。但这导致 /skills 命令臃肿，内部耦合了包解析、进程 spawn、安装进度 UI 等与 trigger/visibility 管理无关的代码。拆分后 skill-manager 文件大小减半，职责清晰。
