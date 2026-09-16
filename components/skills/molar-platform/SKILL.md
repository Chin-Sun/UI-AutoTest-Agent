---
name: molar-platform
description: MolarData 数据标注平台（任务 2.0）的页面与业务知识：流程积木用法、路由、导入弹窗、工作流规则，编译该项目用例时加载
roles: [compiler, triager, repairer]
---

# MolarData 标注平台知识

来源：`MolarTest/AutoTest/testcases/README.md`、molardata-e2e 工程约定与前端源码 `molar-label-system-fe-v2`。

## 范围

- 只覆盖任务 2.0（`/task-v2/*`），旧版任务 1.0 页面不在范围内。
- 清单主键形如 `02-A1`（文件号 + 清单内编号），导入的用例 `source` 记为 `molardata:02-A1`。

## 登录与账号

- **登录是自动的。** 执行前平台按 `project.yaml` 的 `login` 配置复用或建立会话，默认角色 `admin`。计划里不要写登录步骤，也不要打开 `/login`。
- **不要切换账号重新登录。** 平台对同一账号只保留一个有效会话，重新登录会顶掉已存的会话。
- **按钮权限按中文字面量匹配**，界面已锁定为 zh-CN。

## 流程积木（先用 list_flows 确认）

几乎每条用例的准备阶段都是：

```json
{ "id": "s1", "stage": "setup", "action": "use", "flow": "molar.ensureTask", "params": { "tool": "IAT", "ref": "task.iat" } },
{ "id": "s2", "stage": "setup", "action": "use", "flow": "molar.openTaskPage", "params": { "taskId": "${data.taskId}", "page": "io" } }
```

| 积木 | 用途 | 要点 |
| --- | --- | --- |
| `molar.ensureTask` | 拿到指定工具类型的任务，输出 `taskId`、`taskName` | 始终写上 `ref`，填测试数据目录的任务条目（`task.iat` / `task.pcat` / `task.vmt` / `task.qt2`）；漏写时积木也会按 `task.<工具小写>` 使用人工预定义的任务。目录没配时才自动创建 `uta-auto-<工具>` 并记住。新建任务没有标签、没有数据：依赖标签或已有数据的用例必须用 `ref` 指向预定义任务 |
| `molar.openTaskPage` | 打开任务子页面并等任务信息加载完成 | `page`：`io` 导入导出、`workflow` 工作流画布、`dataItem` 条目、`setting` 设置、`member` 成员、`statistics` 统计 |

**工具类型：** IAT 图像通用标注工具v2、PCAT 点云、VMT 视频多模态、QT2 问卷、ASR 音频、NLP 文本、MAT 医疗、PHONE 音素、LMAT 大模型、PCAT_4D 4D点云。

不要手写 `goto task-v2/...`：任务详情没有 `detail` 页，taskId 走 query 参数，由积木负责。

## 页面与定位

- **按钮大多不是真正的 button。** 「导入数据」「创建任务」「确定」「重新上传」这类主按钮都是 `div.button`，没有 button 语义，`{ "role": "button", "name": … }` 定位不到，已经在真实环境失败过。请用 `{ "text": "导入数据", "exact": true }`；文字不唯一时再用 CSS（见各页面小节）。只有原生 `<button>` 才用 role。
- **定位优先级：** 优先使用 `data-testid`；没有 testid 时用精确文字，再退到 CSS。
- **表格行：** 表格暂无行级 testid，定位行时先用 `{text}` 找行内唯一文本，再对行内按钮使用 role。
- **Canvas 画布：** 工作流画布、标注工作台是 Canvas/WebGL，不能用 DOM 断言节点。遇到这类用例在 rationale 标注「需要 Canvas 组件」。
- **全站弹窗容器** `.pop-container` 是通用 class，断言时用标题文字过滤。

## 01 数据导入（page: io）

- **打开入口：** 页头右侧「导入数据」按钮，是 `div.button.primary`，被 teleport 到页头，不在 `.page` 内。定位写 `{ "css": "#appContentHeader .app-content-header-right .button.primary" }`，或 `{ "text": "导入数据", "exact": true }`。点击后打开标题为「选择上传数据类型」的弹窗。
- **不要单独断言入口可见。** `molar.openTaskPage` 已经等页头渲染完成，直接点击即可；页面右下角还有一个「重新上传」主按钮，别混淆。
- **弹窗卡片：** 用 `{ "css": ".pop-container > main > .item" }` 计数，单张卡片用 `{ "css": ".pop-container > main > .item span" }` 或精确文字断言。注意「文件」「JSON」是其他卡片名的一部分（「文件夹」「导出JSON」），文字断言必须 `"exact": true`。各工具卡片如下：

| 工具 | 卡片 |
| --- | --- |
| IAT（9 类） | 文件、文件夹、云端数据源、导出JSON、COCO、LabelMe、VOC、YOLO、JSON |
| PCAT | 文件夹、云端数据源、KITTI、JSON |
| VMT | 文件夹导入、JSON |
| QT2 | 图像文件、文本文件、JSON |
| ASR | 文件导入、JSON |

- **点击卡片必须限定在弹窗内。** 弹窗背后的导入轮次列表里也有「文件」「文件夹」等数据类型文字，`{ "text": "文件", "exact": true }` 会命中多个元素，点击会失败（真实环境已踩过）。写成 `{ "css": ".pop-container > main > .item:has(span:text-is(\"文件\"))" }`。
- **上传要写成一步 upload，target 就是卡片。** 点卡片后前端才临时创建 input 并唤起系统文件选择器，页面里没有 `input[type=file]`，定位 input 会超时（真实环境已踩过）。写成 `{ "action": "upload", "target": { "css": ".pop-container > main > .item:has(span:text-is(\"文件\"))" }, "value": "${data.uploadImageFile}" }`，不需要先单独 click 卡片。
- **上传值要和卡片类型匹配。** 「文件」「导出JSON」「JSON」卡片要文件路径（可以多个），「文件夹」「VOC」「YOLO」「COCO」「LabelMe」卡片要目录。测试数据目录里的 `file.*` 都是目录，给「文件」卡片用时要拼上具体文件名；不知道文件名时声明 `human` 来源。
- **选完文件后没有弹窗，也没有「确定」按钮。** 弹窗关闭后，左侧「导入轮次列表」顶部多出一条状态为「未开始」的轮次，右侧「数据目录」汇总变为「共 N 个文件,预计拆分为 X 个批次,Y 个条目」，下方「数据划分」面板里的「批次设置」只是表单标签。此时轮次只在本地，还没提交到服务端。
- **提交导入：** 点「数据划分」面板右下角的「开始导入」，写法 `{ "css": ".data-split .button.primary:text-is(\"开始导入\")" }`。点击后才真正创建导入轮次，属于共享环境写操作，需要在 cleanup 阶段删除。未点击时同一位置显示「重新上传」。
- **判定导入完成：** 在当前选中的轮次卡片上断言状态，写法 `{ "action": "assertText", "target": { "css": ".record-list ul > .record-item.active .status-flag" }, "expect": "已完成", "timeoutMs": 60000 }`。状态依次为「未开始 → 进行中 → 已完成」，失败或取消时显示「失败 / 已取消」。上传成功没有固定的 toast 文案，不要断言「上传成功」。
- **「云端数据源」** 点击后打开云盘选择弹窗，不会唤起文件选择器。
- **需求文档差异：** IAT 需求文档没列「云端数据源」但写了 9 类。按实际 9 张卡片断言，并在 rationale 注明差异。

## 02 动态工作流（page: workflow）

- **节点是 DOM，不是画布像素，也没有「节点切换 Tab」。** 每个节点是 `div.node-card`（vue-flow 渲染），卡片头部是节点名。选中节点写 `{ "css": ".node-card:has-text(\"验收\")" }`，别用 `{ "role": "tab" }`（真实环境已踩过：15 秒超时）。选中后卡片带 `.active`。
- **权限：** 只有空间创建者 / 超级管理员能删除节点（前端 `isOwnerAdmin`）；节点管理员只能配置自己团队的成员。
- **可拖入的节点：** 右侧「添加节点」里是标注内审 / 审核 / 智能审核 / 智能标注 / 验收（打包机视任务配置）。未连线的新节点是「暂存」态，不落库，连线后才真正创建。
- **删除节点要按 Backspace，不是 Delete。** 前端只处理 `Backspace`（`Base.vue` 的 `handleDelKeyDown`），这也是清单 02-C3 要确认的那条。写法：先 `click` 选中节点卡片，再 `press` 一次 `Backspace`（`target` 写同一个节点卡片）。
- **删除的三种结果**（弹窗都是全站容器 `.pop-container`，标题「移除节点」）：

| 情况 | 表现 |
| --- | --- |
| 内置节点（原始数据 / 合格数据 / 标注） | 弹窗内容为「{节点名}节点不可移除」，只有确认按钮（02-A1 / A2） |
| 非内置、**无数据** | 不弹窗，直接删除并提示「删除成功」（02-C7） |
| 非内置、**有数据** | 弹窗里出现红字「当前节点存在数据，请进行数据分配。」+「分配数据 至」+ 节点下拉（占位「请选择节点」）；目标选到标注节点时再出现团队下拉（占位「请选择团队」，即 02-C6）；确认后才删除 |

- **转移目标下拉里没有**：智能审核、智能标注、标注内审、打包机、原始数据；「合格数据」和普通审核 / 验收节点可选。下拉是 naive-ui 的 NSelect，选项用 `{ "css": ".n-base-select-option:has-text(\"合格数据\")" }` 这类写法。
- **可观测证据：** 断言弹窗文案、toast、以及删除后画布上该 `.node-card` 是否消失；条目页里的节点名也可用。

## 数据

- **先查目录：** 用 `list_test_data` 查项目数据目录。任务通过 `molar.ensureTask` 的 `ref` 引用，本地素材引用 `file.*`。目录里没有、页面上又造不出来的，才声明 `human` 来源由门禁请人补。
- **新建对象要清理：** 共享环境里新建的节点、导入轮次名要用生成模板（`uta-{{case}}-{{ts}}`），并在清理阶段删除。
- **执行串行：** Daily 为共享环境，用例之间可能互相干扰，执行默认串行。
