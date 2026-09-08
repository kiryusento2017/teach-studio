// 渲染层与主进程之间唯一的门。
//
// contextIsolation 开着、nodeIntegration 关着，所以渲染层拿不到 require ——
// 这是有意的：页面里那些字符串拼出来的 HTML 一旦能碰到 fs，
// 一个转义漏洞就是任意文件读写。这里只开五个具体动作，不开通用能力。

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getPort: () => ipcRenderer.invoke('get-port'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  pickOutDir: () => ipcRenderer.invoke('pick-out-dir'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openFile: (p) => ipcRenderer.invoke('open-file', p),

  // 更新装好之后重启软件。**必须重启才生效** —— 覆盖的是 .py 和 .js，
  // 当前进程跑的还是加载时的那份旧代码。
  restart: () => ipcRenderer.invoke('restart-app'),

  // 复制文字到剪贴板（注册指南里的网址）。走主进程，理由见 main.js。
  copyText: (s) => ipcRenderer.invoke('copy-text', s),

  // 🔴 这里曾经有一个 `openUrl` —— 渲染层能让主进程弹浏览器打开网址，
  //    主进程那边卡了域名白名单。2026-09-08 **整条拆掉**：
  //
  //    · 弹不弹得出浏览器取决于用户机器上的默认程序关联、协议注册、
  //      安全软件拦不拦 —— 我们保证不了，而一个「点了可能没反应」
  //      的按钮比没有更糟
  //    · 替代品是「复制地址」（copyText），用户自己粘到浏览器，百分百可控
  //
  //    要加回来的话，**必须连域名白名单一起加回来**。页面的 HTML 是
  //    字符串拼出来的，万一有个转义漏洞，「能打开任意 URL」就是钓鱼入口：
  //    用户看到是我们的软件弹出的浏览器，戒心最低。

  // 拖进来的文件要拿真实路径。Electron 32 之后 File.path 被移除了，
  // 得走 webUtils.getPathForFile —— 不处理这个，拖放功能会静默失灵。
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      return file && file.path ? file.path : '';
    }
  },
});
