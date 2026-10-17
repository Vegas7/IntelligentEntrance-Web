# IntelligentEntrance-Web（智能通行 Web 版）

「智能通行」楼宇门禁 App 的轻量网页版，接口协议参考重构的 Lite 安卓版：手机浏览器打开即可出示通行二维码、点击选层。
无广告、无统计、不调屏幕亮度、**不需要定位或任何设备权限**。

> **免责声明**：本项目是非官方的第三方客户端，与 App 开发商无任何关联，仅供个人学习和自用。
> 账号数据只在你自己的浏览器与官方服务器之间传递。使用风险自负。

---

## 一、关于定位权限的结论

| | 原版 APK (`com.infoxs.parkAccessFlutter`) | Lite APK | Web 版 |
| :-- | :-- | :-- | :-- |
| 声明的权限 | `ACCESS_FINE/COARSE/BACKGROUND_LOCATION`、蓝牙全套、电话、存储、推送等 | 仅 `INTERNET` | 无 |
| 通行码相关请求中的位置字段 | 无 | 无 | 无 |

- 原版的定位权限是给 **蓝牙门锁模块**（`libLockCore.so`，Android 11 及以下扫描 BLE 必须有定位权限）和极光/小米推送用的。
- 出码链路的所有请求（`get_token`、`read_relation_building_list`、`floor/read_list`、`get_default_floor`、`v2/user/get_commuter_code`、`modify_default_floor`、`send_dispatch`）的请求体里都没有经纬度等位置参数，服务端也不校验位置。
- Lite 版只申请了 `INTERNET`，实际可以正常出码过闸 —— 这本身就证明了不需要定位。
- 本大楼 `doorLockSupported: false`，蓝牙门锁功能在这里根本不启用。

---

## 二、为什么需要一个小服务端

官方接口 `https://www.infoxs.com.cn:15000` 对任何带 `Origin` 头的请求直接返回 **403**（Spring CORS 拦截），浏览器页面无法直连。
所以网页通过同源路径 `/api/*` 访问，由 `server.js` 原样转发到 `/building_app_api/*`：

```
手机浏览器 ──/api/v2/user/get_commuter_code──▶ server.js ──▶ www.infoxs.com.cn:15000/building_app_api/v2/user/get_commuter_code
```

- 代理只放行本应用用到的 8 个接口（白名单），不会变成开放代理。
- 只转发 `Authorization` 头和 JSON 请求体，不转发 Cookie / Origin / Referer。
- 服务端日志只记录 `方法 路径 -> 状态码 (耗时)`，**不记录**请求体（密码、验证码）或 Token。
- Token 只保存在用户自己手机浏览器的 `localStorage` 里，服务端不保存任何用户数据。

---

## 三、目录结构

```text
IntelligentEntrance-Web/
├── server.js              # 零依赖 Node.js 服务：静态页面 + /api 白名单代理
├── worker.js              # 可选：同样功能的 Cloudflare Workers 版本
├── wrangler.toml          # Cloudflare Workers 配置
├── package.json
├── deploy/
│   ├── intelligent-entrance.service  # systemd 服务
│   └── Caddyfile.example             # Caddy 站点配置示例
└── public/
    ├── index.html         # 登录 / 通行 / 个人中心 / 调试日志
    ├── style.css          # 移动端优先，自动跟随系统深色模式（二维码卡片始终白底）
    ├── app.js             # 全部业务逻辑
    ├── i18n.js            # 界面文案（中文 / English）
    ├── sw.js              # 离线缓存（Service Worker）
    ├── vendor/qrcode.js   # 二维码生成（qrcode-generator 1.4.4, MIT）
    ├── manifest.webmanifest  # 可"添加到主屏幕"
    ├── icon.svg / icon-dark.svg / icon-*.png / apple-touch-icon(-dark).png  # 应用图标：白底 + 暗色模式黑底（满幅不透明）
    └── ghost.svg          # 小幽灵头像（SVG）
```

---

## 四、运行

需要 Node.js 18+，没有任何 npm 依赖，不用 `npm install`。

```powershell
cd IntelligentEntrance-Web
node server.js                 # 默认 http://0.0.0.0:8080
```

环境变量：`PORT`（默认 8080）、`HOST`（默认 0.0.0.0）。

同一局域网内手机访问 `http://<电脑IP>:8080` 即可使用（需在 Windows 防火墙放行该端口）。

### 部署到服务器（推荐配 HTTPS）

HTTPS 不是必需的，但有了 HTTPS 才能使用离线缓存、「保持屏幕常亮」和「添加到主屏幕」全屏模式。
以 Debian / Ubuntu + Caddy 为例（可与服务器上已有的其他 Caddy 站点共用）：

```bash
# 1. 安装 Node.js（18+）并创建专用用户
sudo apt install -y nodejs
sudo useradd --system --no-create-home --shell /usr/sbin/nologin entrance

# 2. 放置代码
sudo git clone https://github.com/Vegas7/IntelligentEntrance-Web.git /opt/intelligent-entrance

# 3. 注册 systemd 服务（监听 127.0.0.1:8010）
sudo cp /opt/intelligent-entrance/deploy/intelligent-entrance.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now intelligent-entrance

# 4. 把 deploy/Caddyfile.example 里的站点块（改成你的域名）追加到 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

更新：`cd /opt/intelligent-entrance && sudo git pull && sudo systemctl restart intelligent-entrance`。

### 部署到 Cloudflare Workers（可选，免服务器）

```powershell
npx wrangler deploy
```

`worker.js` 的代理逻辑和 `server.js` 完全相同，静态文件来自 `public/`。

---

## 五、功能对照 Lite 版

| 功能 | Lite APK | Web 版 |
| :-- | :-- | :-- |
| 密码登录 / 验证码登录 | ✅ | ✅ |
| 冷启动直接显示上次缓存的二维码 | ✅ | ✅（页面走 Service Worker 离线缓存秒开，数据走 localStorage，后台同时刷新） |
| 30 秒自动刷新 + 手动刷新 | ✅ | ✅（切到后台暂停，回到前台立即刷新） |
| 授权楼层 / 全部楼层切换 | ✅ | ✅ |
| 选层 | 双击 | 单击 |
| 选层后同步默认楼层 `modify_default_floor` | ✅ | ✅ |
| 选层时呼梯 `send_dispatch` | 每次双击都发送 | 已移除（实测不可用） |
| 屏幕亮度调到最高 | ✅ | ❌ 网页无法调节亮度，改为「保持屏幕常亮」（不改系统设置，离开页面自动失效） |
| 调试日志 + 导出 | ✅ | ✅（密码自动打码，Token 只显示前 8 位） |
| 个人中心 / 退出登录 | ✅ | ✅ |
| 中文 / English 切换 | ❌ | ✅（登录页和通行页右上角，默认跟随浏览器语言） |
| 亮色 / 暗色切换 | 跟随系统 | ✅（默认跟随系统，手动切换后记住选择） |


---

## 六、使用建议

- 手机浏览器打开后「添加到主屏幕」，之后就像 App 一样一点即开、全屏显示。
- 扫码时如果环境较暗，手动把手机亮度调高一些即可（网页没有权限改亮度，也就不会出现原版"改了亮度不恢复"的问题）。
- 修改昵称、修改密码、注销账号等敏感操作请使用原版 App。

---

## 七、缓存机制（打开即用，不转圈）

- **页面与脚本**：首次打开后由 Service Worker（`public/sw.js`）缓存到手机本地，之后每次打开直接从本地读取，同时在后台检查新版本，下次打开生效。断网也能打开页面。
  需要 **HTTPS**（或 localhost）才能启用；纯 HTTP 局域网访问时浏览器不允许 Service Worker，会退化为 ETag 校验（未修改时服务器只回 304）。
- **业务数据**：Token、楼宇、楼层列表、上次选择的楼层、上一次的二维码都保存在 localStorage，打开即先显示，再静默刷新。
- **更新部署**：直接替换 `public/` 下的文件即可，用户下一次打开自动拿到新版本，无需改版本号。
