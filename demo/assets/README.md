# demo/assets —— 演示素材与来源

| 文件 | 作用 | 是否必需 |
|---|---|---|
| `vision-samples.js` | 把两张订单截图以 base64 内嵌，供 Demo **离线**演示「订单截图识别」。定义 `window.VISION_SAMPLES = { hotel, flight }` | ✅ Demo 引用 |
| `hotel-order.png` / `flight-order.png` | 上面两张截图的**原始图片**（由下面两个 HTML 渲染而来） | 再生素材 |
| `hotel-order.html` / `flight-order.html` | 模拟携程订单页的**源文件**（390×844），用来重新生成 PNG | 再生素材 |

## 素材链路

```
hotel-order.html / flight-order.html      （手写的携程订单页样式）
        │  用无头浏览器截图
        ▼
hotel-order.png / flight-order.png        （截图）
        │  base64 内嵌
        ▼
vision-samples.js                         （Demo 直接引用，离线可用）
```

重新生成截图（Windows / Edge 示例）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu `
  --window-size=390,844 --screenshot="hotel-order.png" "file:///<项目路径>/demo/assets/hotel-order.html"
```

## 说明

- **不要**把 `vision-samples.js` 改名或移动：`demo/index.html` 通过 `<script src="assets/vision-samples.js">` 引用，
  `tests/demo.check.js` 也会校验该路径可解析。
- 这两张截图是**演示用的模拟订单**（非真实携程数据），仅用于展示识别流水线。
- 截图识别真正跑通需要多模态模型（见 `docs/部署与配置.md` 第四节）；未连接时 Demo 展示内置样例结果并明确标注。
