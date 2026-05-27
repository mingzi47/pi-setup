# Skill Manager

管理 skill 的触发模式和可见性。不负责 skill 包的安装、卸载、更新——这些由 pi CLI（`pi install`/`pi remove`/`pi update`）处理。

## 语言

**Skill（技能）**：
一个包含 `SKILL.md` 的目录或 `.md` 文件，定义 agent 可加载的专项能力。
_Avoid_：插件、扩展、工具

**触发模式（Trigger Mode）**：
控制 LLM 是否在系统提示词中自动看到该 skill。
- **auto**：LLM 自动加载
- **manual**：仅通过 `/skill:name` 手动调用
实现方式：修改 `SKILL.md` frontmatter 中的 `disable-model-invocation` 字段。
_Avoid_：启用/禁用、激活/停用、加载/卸载

**可见性（Visibility）**：
控制 skill 是否在 pi 中可见。通过 settings.json 包条目中的 `skills` filter 数组管理。
- 无 entry = 默认可见
- `-path` = 隐藏
- `+path` = 强制可见
可见性切换循环：无 → `-` → `+` → `-`（一旦碰过必须显式标记，无法回到无 entry 状态）
_Avoid_：开关、启用/禁用

**包（Package）**：
通过 settings.json 中 `packages` 数组安装的 skill 集合。来自 git（`git:`）或 npm（`npm:`）。
_Avoid_：扩展包、插件包

**本地 Skill（Local Skill）**：
存放在 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`、`.agents/skills/` 目录中的 skill。不归属任何包，永远可见，无需可见性管理。
_Avoid_：自定义 skill、用户 skill

**触发器状态文件（Trigger State File）**：
`~/.pi/agent/skill-triggers.json`，持久化用户对每个 skill 的触发模式偏好。启动时恢复覆盖外部改动（如 `pi update` 重新拉取了 SKILL.md），启动时清理孤儿条目（SKILL.md 已不存在的记录）。

**设置文件（Settings File）**：
`~/.pi/agent/settings.json` 或 `.pi/settings.json`。包条目中的 `skills` filter 数组管理 skill 可见性。skill-manager 读写此文件。

## 标签页

- **Trigger 标签页**：管理所有 skill 的触发模式（auto/manual）
- **Visibility 标签页**：管理包 skill 的可见性（`-`/`+`）
- 使用左右箭头在标签页之间切换

## 分组

- **包 skill**：按包名分组（repo 最后一段），组内字母排序
- **本地 skill**：归入 "Local" 组，组内字母排序
- 所有分组可折叠/展开
- Visibility 标签页仅显示包 skill（本地 skill 不在此管理）

## 示例对话

> **Dev**：我刚 `pi install` 了一个新包，里面 20 个 skill 太多了，只想看其中 2 个。
> **Expert**：打开 `/skills`，切到 Visibility 标签页，找到那个包分组。除了你要的 2 个，其余都切到 `-`（隐藏）。
>
> **Dev**：我改了 visibility，退出标签页就自动保存了？
> **Expert**：对，切换标签页时保存到 settings.json 并触发 reload。有未保存修改时 UI 会有提示。
>
> **Dev**：trigger 偏好会在 `pi update` 之后丢失吗？
> **Expert**：不会。`skill-triggers.json` 记录你的偏好，启动时自动恢复。如果 SKILL.md 被外部删除了，对应记录也会自动清理。
