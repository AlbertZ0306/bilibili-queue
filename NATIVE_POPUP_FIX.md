# 1.4.1 原生弹窗尺寸修复

用户截图中的窄条已在真实 Chrome 工具栏弹窗中复现。

## 原因

1.4.0 窄屏规则为 `@media(max-width:519px){body{width:100vw}}`。Chrome 原生 action 弹窗从内容计算宽度，初始宽度很小时会进入该规则；body 又跟随很小的 viewport，无法把弹窗撑开，形成尺寸反馈循环。普通标签页的 viewport 已由测试工具固定，无法暴露这个问题。

此前的验证遗漏了这一原生弹窗行为，展示的 520×600 标签页截图没有证明实际安装后的工具栏弹窗尺寸正确。

## 复现与结果

环境：Windows，Chrome for Testing 151，headed 模式，Playwright `viewport: null`，通过 `chrome.action.openPopup()` 打开真实弹窗，并用 CDP 连接弹窗自身的页面。

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| Chrome contextType | POPUP | POPUP |
| tabId | -1 | -1 |
| 150% 缩放下 innerWidth | 25 | 520 |
| innerHeight | 600 | 600 |
| html/body 宽度 | 约 25.33px | 520px |
| 水平 scrollWidth | 130 | 520 |
| 100% 缩放 | 未作为旧版通过依据 | 520×600，通过 |
| 有 6 条视频时 | 窄条无法操作 | 完整显示 5 行 |
| 添加窗口 | 被容器裁切 | 宽 440px，位于弹窗边界内 |

修复内容：给非 manager 的 html、body 和 React 根节点显式设置 520px 的宽度与最小宽度；原生弹窗高度设为 600px。viewport 相对的窄屏规则只匹配 `.manager body`。独立管理页保留窄屏自适应，390px 和 1100px 页面验证仍通过。

## 测试

`tests/native-popup.cjs` 是新增的原生弹窗回归，不会把普通扩展标签页当作 popup，也不会在找不到原生上下文时跳过。

安装开发用 Playwright 后执行：

```sh
node tests/native-popup.cjs
```

它会短暂打开独立测试 Chromium 窗口，默认加入 6 条测试数据；不会操作个人浏览器配置或实际列表。测试需要 headed 桌面环境和支持 action.openPopup/getContexts 的现代 Chromium。可设置 NATIVE_SCALE、NATIVE_SCREENSHOT、BILI_TEST_BROWSER 和 BILI_AUDIT_WORKDIR。

原有浏览器页面尺寸回归继续用于测试独立管理页，原生弹窗必须由这个新测试单独验证。

## 已安装版本更新

此修复最初随 1.4.1 发布。当前插件目录已统一命名为 `bilibili-queue`；到 `chrome://extensions/` 选择「加载已解压的扩展程序」，选择该目录重新导入。

参考：[Chrome action popup 自动尺寸规则](https://developer.chrome.com/docs/extensions/reference/api/action#popup)。
