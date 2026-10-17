# Whale Balance Hermes

在 Hermes 桌面窗口里挂一只鲸鱼，实时显示 DeepSeek / 中转账户余额，并附带一份本机模型费用记账面板。

> 这是个人自用插件的公开版本。**不含原画与音效**，原因见 [Licensing](#licensing)。

## 功能

- `desktop/plugin.js` 是免编译的原生桌面 ESM 插件，ID 为 `whale-balance-hermes`，`defaultEnabled: false`。
- 通过 SDK 的 `statusBar.right` 贡献挂载：状态栏显示隐藏开关，其 React 兄弟节点是一只窗口内 fixed 定位的鲸鱼。**不是独立操作系统桌宠或跨应用置顶窗口。**
- 指针捕获拖动，9 CSS 像素阈值区分点击；靠近窗口边缘吸附；窗口缩放后限制坐标；缩放范围 0.6–2.5；位置、缩放、可见性经 `ctx.storage` 持久化。
- 点击鲸鱼刷新、键盘激活刷新、60 秒 React Query 轮询。隐藏即停止轮询。无 DOM 注入、无额外全局监听器、无自建轮询计时器；卸载时释放指针捕获，其余生命周期交给宿主。
- 菜单可在 DeepSeek / CCTQ / Neko 间切换数据源：DeepSeek 显示 CNY 余额；CCTQ 与 Neko 从 CC Switch 的只读 SQLite 配置读取已启用的 NewAPI 用量查询凭据，显示 USD 剩余额度。**不会把 Access Token 或 User ID 返回给 renderer。**
- 菜单的「编辑气泡」打开最小内容面板，预览复用 `BubbleShape` / `BubbleText` 样式；可编辑三行现有内容：可选标签、金额显示模式（始终保留后端余额数值，仅可替换 `¥` 前缀）、空闲提示。保存写入 `ctx.storage` 并重开后恢复；取消丢弃草稿；重置还原默认值（需保存才生效）。
- 「用量与峰谷」面板读取本机 `state.db` 的 `session_model_usage`，按 DeepSeek 官方峰谷价折算 CNY 成本，并单独标记无价目表的模型，不静默按 0 计。

## 后端与安全

`dashboard/plugin_api.py` 导出 `APIRouter`，由 Hermes 已认证的插件路由挂载为：

```text
GET /api/plugins/whale-balance-hermes/balance
GET /api/plugins/whale-balance-hermes/bubble-image/{asset_id}
GET /api/plugins/whale-balance-hermes/ledger
```

只在 DeepSeek 请求时读取后端进程的 `os.environ['DEEPSEEK_API_KEY']`，不读取 `.env`，renderer 永远拿不到密钥。CCTQ / Neko 走只读 SQLite URI 查询固定的 CC Switch 数据库，仅当用量查询已启用、模板为 `newapi` 且脚本 URL 含 `/api/user/self` 时才读取 `accessToken` 与 `userId`；不读取模型调用 key，不执行自定义脚本，不回传数据库内容。缺少或不匹配时返回 `unavailable / missing_credentials`。

> ⚠️ 该数据库中的凭据未加密。Windows 上同一用户账户可以读到它。这个设计只适合单用户本机，**不适合共享账户或远程网关**。

请求使用 `httpx.AsyncClient` 访问固定 HTTPS 端点 `https://api.deepseek.com/user/balance`；每次 HTTP 操作超时 10 秒，不跟随重定向，禁用环境代理继承。10 秒是各网络阶段超时，不是整个复查流程的总 deadline。

- 按 `currency == 'CNY'` 选取唯一记录，不取第一条；校验 total / granted / topped-up 都是有限非负 Decimal，保留十进制字符串精度。
- 单进程事件循环内合并进行中的请求；调用者取消不会取消共享请求。
- 完成后缓存 60 秒（含错误及零值，避免点击风暴）。手动点击仍遵守后端缓存。
- 零余额首次读取后最多**额外复查 3 次**，共最多 4 次；仍为零则返回 `zero_unconfirmed`，不伪造正余额。每次复查间隔 250 毫秒。
- 失败时保留此前成功余额及其原始采样时间并标记 `stale`；没有历史余额则返回 null。密钥变更清空缓存。
- 不回传原始 HTTP body、异常文本、Authorization 或密钥，只回传固定错误代码。无宽松 CORS，无独立服务器。

返回状态为 `ok`、`unavailable`、`error`、`zero_unconfirmed`。`balance` 是十进制字符串或 null，`updated_at` 是采样时间，`stale` 与 `cached` 分开标记。

## 包结构

```text
plugin.yaml                  原生统一包元数据（不把密钥列为加载门槛）
__init__.py                  无副作用 register
dashboard/manifest.json      仅 API，无 dashboard 页面
dashboard/plugin_api.py      Python 路由、余额服务与用量读取
dashboard/ledger.py          峰谷计价与聚合
desktop/plugin.js            原生桌面贡献与内联 SVG
tests/test_backend.py        模拟 HTTP / ASGI 的 unittest
tests/test_ledger.py         计价与聚合的 unittest
tests/desktop.test.mjs       模拟 SDK / hooks 的 ESM 行为测试
tests/verify_sdk.py          对真实本地 SDK 导出表的静态检查
```

## 安装

把整个目录放进 Hermes 的插件目录，重启 Hermes，然后在桌面端的插件设置里启用 `whale-balance-hermes`。

统一包需要**分别**授权启用 Python 后端与桌面部分；桌面开关不会自动导入 Python 后端。后端进程必须真正继承 `DEEPSEEK_API_KEY` 环境变量 —— 在 CLI 里保存过凭据不代表进程里就有。

## 验证

需要 Python 环境中有 `fastapi` 与 `httpx`；桌面测试需要 Node 支持 `vm.SourceTextModule`。无需 npm 依赖。

```bash
python -m unittest discover -s tests -v
node --check desktop/plugin.js
node --experimental-vm-modules --test tests/desktop.test.mjs
python tests/verify_sdk.py --hermes-root <你的 hermes-agent 检出目录>
```

`verify_sdk.py` 静态读取真实 `apps/desktop/src/sdk/index.ts` 核对 named exports，只做静态检查，不代表宿主渲染验证。

后端测试覆盖币种顺序、异常数字与字段、缺 key、缓存到期、并发合并与取消、超时保留旧数据、零值复查上限、HTTP/JSON/异常脱敏、账户不可用、密钥变更，以及真实 FastAPI router 的模拟 ASGI 请求。所有出站流量由 MockTransport 接管，测试只用硬编码的假 key。

桌面测试通过 Node VM 链接**模拟** SDK 与 React，覆盖合法贡献、点击与拖动、边界、缩放、隐藏与清理，以及气泡编辑、音效与视觉常量回归。这不是 React DOM 集成测试，也不是 Hermes 真实窗口测试。

### 已知未验证项

- 未做 live provider 请求，未验证真实余额显示。
- 未在真实 Hermes 窗口里验证渲染、遮挡、主题、辅助功能与远程连接切换。
- 固定定位仍受宿主 CSS 的 containing block、overflow 与堆叠上下文约束；没有编造独立 overlay API，也没有用 portal 或 `document.body` 注入绕过宿主。
- 查询按 profile 与 gateway 连接状态分组，这不是完整的 connection identity；跨远程连接的缓存隔离未验证，因此**不是可直接投产的多账号界面**。
- 编辑器是分阶段实现：尚未移植上游的任意 SVG/图片上传、加权随机模块、多个可排序内容模块及 DOM 注入行为。

## Licensing

**本仓库的代码**以 MIT 许可证发布，见 `LICENSE`。

**本仓库刻意不含以下内容**，它们已被移除，而不是因为疏忽：

| 内容 | 出处 | 状态 |
| --- | --- | --- |
| 鲸鱼原画 `DSniang1.png` | 上游项目美术，无再分发授权 | 已移除，代码中为空 |
| `bubble-money1.gif` / `bubble-petpet.gif` | 来源不明 | 已移除 |
| DST 音效 `Ya1/Ya2/D1/D2.mp3` | Klei 版权 | 已移除 |
| Minecraft 经验球音效 | Mojang 版权 | 已移除 |
| `task-end-a.wav` | 来源不明 | 已移除 |

`desktop/plugin.js` 中 `ARTWORK_BASE64`、`SOUND_ASSET_*` 这些常量是**空字符串**。这不是 bug：

- 没有原画时，鲸鱼位置渲染为一块带描边的浅蓝占位块，拖动、点击刷新、键盘操作全部照旧。
- 没有音效时，音效开关照常显示但不会有声音，也不会构造空 URL 的 `Audio`。
- 气泡内置图片缺失时，后端返回 `asset_missing`，气泡安静降级而不是报错。

**想在本机恢复全貌**：把你有权使用的图片放到 `assets/DSniang1.png`，把它转成 base64 填进 `ARTWORK_BASE64`，音效同理。相关资产测试会自动从「验证为空」切换为「逐字节比对 SHA-256」，不需要改测试。

视觉与交互常量参考了 [MeteorNOX/dsh-whale-widget](https://github.com/MeteorNOX/dsh-whale-widget)（MIT），归属声明保留在源码头部。本工程在该项目之上为 Hermes 桌面 SDK 做了适配，并新增了后端余额、峰谷记账与气泡编辑器。
