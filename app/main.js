// PDF 转 Word · Electron 外壳
//
// 外壳只做三件事：起 Python 服务、开窗、把系统对话框（选文件、打开文件夹）
// 转给渲染层。**业务逻辑一行都不放这里** —— 放这儿就没法用 Python 那套测试测了。
//
// 起服务的约定：Python 把 `PDF2WORD_PORT=<端口>` 打到 stdout，这边等那一行。
// 端口由系统分配，不写死 —— 写死会在用户同时开着别的软件时撞车，那种失败极难查。

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// 安装目录。发行版和开发环境的层级不一样：
//
//   发行版    <安装目录>/resources/app/main.js   → 上两级
//   开发环境  <项目>/app/main.js                 → 上一级
//
// 发行版把代码放进 resources/app 是 Electron 的标准形态（VS Code、Discord
// 都是），这样 electron.exe 改个名就能双击直接开 —— 不用再弹个 cmd 黑框
// 去调它。判断依据是父目录叫不叫 resources，不依赖 app.isPackaged
// （我们没打 asar，那个标志不可靠）。
const ROOT = path.basename(path.dirname(__dirname)) === 'resources'
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'main.py');

// 🔴 Python 的位置：发行版和开发环境不一样，按顺序找。
//    发行版用官方 embeddable 包（自带 stdlib，自包含）放在 runtime/python/；
//    .venv **不能打包分发** —— 它的 Lib 下只有 site-packages，没有 stdlib，
//    os.__file__ 指向开发机的 Python 安装目录，换台机器第一句 import 就死。
//    跟 Python 那边的 paths.find_exe 是同一套思路，别再各写各的。
//    macOS/Linux 上目录结构不一样：可执行文件没有 .exe，虚拟环境里是
//    bin/ 不是 Scripts/。四条候选一起列，存在哪条用哪条。
const PYTHON = (() => {
  const win = process.platform === 'win32';
  const exe = win ? 'python.exe' : 'python3';
  const venvBin = win ? 'Scripts' : 'bin';
  const cands = [
    path.join(ROOT, 'runtime', 'python', exe),            // 发行版
    path.join(ROOT, 'runtime', 'python', 'bin', exe),     // 发行版（类 Unix 布局）
    path.join(ROOT, '.venv', venvBin, exe),               // 开发环境
    path.join(ROOT, '.venv', venvBin, 'python'),          // 开发环境（兜底）
  ];
  const fs = require('fs');
  for (const p of cands) {
    if (fs.existsSync(p)) return p;
  }
  return cands[cands.length - 1];   // 都没有：让它报错，错误信息里能看见路径
})();

let win = null;
let py = null;
let apiPort = 0;

function startServer() {
  return new Promise((resolve, reject) => {
    // 强制 server 用 UTF-8 输出。中文 Windows 的默认代码页是 cp936，
    // 而下面 d.toString() 按 UTF-8 解 —— 不设的话 server 打出来的中文
    // （报错、路径）在这一侧全是乱码。
    py = spawn(PYTHON, [SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env,
                         { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
    });
    let buf = '';
    // 超时给到两分钟。云端版不 import torch（那是本地版首启最慢的一步），
    // 但 FastAPI + pymupdf 冷启在机械盘上也要十几秒，留足余量。
    // 超时了软件就直接打不开，而它其实只是还在加载。
    // 等这么久不会掩盖真故障：进程要是崩了，下面的 'exit' 会立刻
    // reject，不用等到超时。
    const timer = setTimeout(() => {
      reject(new Error('后台服务两分钟没起来。最后的输出：\n' + buf.slice(-600)));
    }, 120000);

    py.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/PDF2WORD_PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        apiPort = parseInt(m[1], 10);
        resolve(apiPort);
      }
    });
    // stderr 也留着：服务起不来时，原因几乎总在这里
    py.stderr.on('data', (d) => { buf += d.toString(); });
    py.on('error', (e) => { clearTimeout(timer); reject(e); });
    py.on('exit', (code) => {
      if (!apiPort) {
        clearTimeout(timer);
        reject(new Error('后台服务退出了（code ' + code + '）：\n' + buf.slice(-600)));
      }
    });
  });
}

// 🔴 把 Electron 自己的缓存挪进安装目录。
//    作者定的规矩：运行中产生的一切都留在安装文件夹内，只有导出的 Word
//    例外 —— 删掉文件夹 = 卸载干净。Electron 默认往
//    %APPDATA%\\pdf2word 放 4.6 MB（GPU 缓存、字典、Code Cache…），
//    是最后一处还落在外面的东西。
//    **必须在 app ready 之前设**，ready 之后再设就来不及了。
//
//    🔴 四个路径都要设，不能只设 userData：
//
//      userData     主目录（Windows: %APPDATA%\\<app>；macOS: ~/Library/Application Support/<app>）
//      sessionData  Cookies / 缓存 / GPU 缓存
//      logs         **macOS 上默认在 ~/Library/Logs/<app>**，不在 userData 底下 ——
//                   只设 userData 的话它照样往外面写
//      crashDumps   崩溃转储，通常跟着 userData 走，显式设一遍不吃亏
//
//    ⚠️ macOS 上还有两处是 Cocoa 自己的行为，setPath 管不着：
//      ~/Library/Saved Application State/<bundle-id>.savedState  窗口恢复
//      ~/Library/Preferences/<bundle-id>.plist                   系统偏好
//    这两样得靠 Info.plist 里关掉窗口恢复才能免掉，真机验过再说。
function relocateUserData() {
  const dir = path.join(ROOT, 'appdata');
  try {
    require('fs').mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    app.setPath('sessionData', dir);
    // 这两个单独 try —— 有的 Electron 版本要求目录已存在，
    // 设失败不该把前面两个也带倒。
    for (const k of ['logs', 'crashDumps']) {
      try {
        const sub = path.join(dir, k);
        require('fs').mkdirSync(sub, { recursive: true });
        app.setPath(k, sub);
      } catch (e2) { /* 单个设不上就算了，主目录已经挪进来了 */ }
    }
  } catch (e) {
    // 目录建不出来（比如装进了 Program Files）就维持默认位置 ——
    // 这种情况下后端的 writable 自检会拦住用户并说明原因，
    // 不必在这里再弹一次窗。
  }
}

relocateUserData();

// 🔴 只允许开一份。开两份的后果，按严重度排：
//
//   1. 两个窗口用同一个 token 并发提交 → 每天 2000 页的额度双倍消耗
//   2. 两边都往 logs/runs.json 写历史 → 后写的整份覆盖先写的，丢记录
//   3. token.json 同理：一边刚改完，另一边拿旧的覆盖回去
//   4. 临时目录 _tmp/cloud 里同名任务互相踩
//
// 而触发它只需要手快双击两下。原来没有任何提示，就是安静地又开一个窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 第二次点开时，把已经开着的那个窗口提到前面 —— 用户要的是「打开软件」，
  // 给他看到窗口就是对的响应，静悄悄什么都不发生反而像是点坏了。
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function createWindow() {
  // 小工具的尺寸，参照 Geek Uninstaller 那一类。620 宽刚好放得下
  // 「文件名 + 无文字层提示 + 页数」三列，440 高能露出 15 行左右。
  // 拉大窗口列表会跟着长 —— 主区是 flex:1，不是写死的高度。
  win = new BrowserWindow({
    width: 620,
    height: 440,
    minWidth: 460,
    minHeight: 300,
    backgroundColor: '#ffffff',   // 跟页面底色一致，开窗时不白闪
    title: 'PDF 转 Word',
    // 图标：终末诗篇的手写落款。ico 里分档放了不同内容 ——
    // 16/24/32 是单字「终」，48 以上才是四个字：四个字缩到 16px
    // 每字只剩 8x8 像素，糊成一团灰，认不出来。
    // 底色是白色圆角：源图是全透明底 + 黑墨迹，在深色任务栏上等于隐形。
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  attachContextMenu(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// 🔴 **Electron 不带右键菜单，得自己挂。**
//
//    作者 2026-09-08 实测报的：填 token 的时候右击没有「粘贴」。
//    token 是一长串随机字符，**从网站复制过来粘贴是唯一合理的输入方式**
//    —— 让人手敲 50 个字符是不可能的。
//
//    顺带说明：`setMenuBarVisibility(false)` 只是把菜单栏藏起来，
//    没有 `setApplicationMenu(null)`，所以 Ctrl+V / Ctrl+C 这些
//    快捷键一直是能用的。缺的只是右键这条路 —— 而很多人就习惯右键。
//
//    菜单项按 `params.editFlags` 灰掉不可用的：在空输入框上右击，
//    「剪切」「复制」是灰的，「粘贴」是亮的。比全都亮着、点了没反应强。
function attachContextMenu(w) {
  w.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.isEditable) {
      const ef = params.editFlags || {};
      items.push(
        { label: '剪切', role: 'cut', enabled: !!ef.canCut },
        { label: '复制', role: 'copy', enabled: !!ef.canCopy },
        { label: '粘贴', role: 'paste', enabled: !!ef.canPaste },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', enabled: !!ef.canSelectAll },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      // 不是输入框、但选中了文字（比如报告里的一段）—— 只给「复制」
      items.push({ label: '复制', role: 'copy' });
    }
    if (!items.length) return;      // 空白处右击：什么都不弹，别给个空菜单
    Menu.buildFromTemplate(items).popup({ window: w });
  });
}


app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (e) {
    // 服务起不来就没法干活了。**把原因原样给人看**，别只说「启动失败」——
    // 那四个字谁也查不了。
    dialog.showErrorBox('启动失败', String(e.message || e));
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 🔴 kill(py) 只杀 Python 本身，**MinerU 是它的子进程** —— Python 死了
//    MinerU 变成孤儿继续跑，用户关掉软件之后它还在后台吃着 GPU 直到转完。
//    Windows 上要 taskkill /T（连整棵进程树）才能真正收干净。
//    /F 是强杀：这时候窗口已经关了，没有「优雅退出」可谈，
//    留着一个吃 4 GB 显存的孤儿进程比丢掉半个转换产物糟得多。
function killTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      require('child_process').spawnSync(
        'taskkill', ['/PID', String(proc.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill();
    }
  } catch (e) { /* 已经没了 */ }
  try { proc.kill(); } catch (e) { /* 同上 */ }
}

app.on('window-all-closed', () => {
  killTree(py);
  app.quit();
});

// 进程被外面强制结束时也收一次 —— 任务管理器结束进程、Ctrl+C 之类。
app.on('before-quit', () => { killTree(py); });

// ── 渲染层要的系统能力 ────────────────────────────────────────────────
ipcMain.handle('get-port', () => apiPort);

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选 PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选文件夹',
    properties: ['openDirectory'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-out-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '转好的 Word 放哪',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('open-path', async (_e, p) => {
  // 打开文件用默认程序；打开目录并选中文件，比只开目录省用户一次找
  if (!p) return;
  try {
    const fs = require('fs');
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      await shell.openPath(p);
    } else {
      shell.showItemInFolder(p);
    }
  } catch (e) { /* 文件被人挪走了，不值得为此弹窗 */ }
});

// 🔴 只放行 .docx。
//
// `shell.openPath` 是「用默认程序打开」—— 对 .exe 就是**执行它**。
// 而页面的 HTML 是字符串拼出来的，万一哪天有个转义漏洞，
// 「能打开任意文件」立刻升级成「能执行任意程序」。
//
// （旁边原来还有个 open-url 也卡着域名白名单，2026-09-08 整条删了，
//   理由见 preload.js 里那段说明。这一条的危害更大，
//   却一直什么都没卡 —— 2026-09-05 复查才发现。）
//
// 限制成 .docx 不损失任何功能：渲染层只在两个地方用它，传的都是
// 转换产物 —— 正品 r.docx 和判失败改名的次品 r.degraded
// （`xxx【公式未完全转换】.docx`，改的是文件名，扩展名没变）。
ipcMain.handle('open-file', async (_e, p) => {
  if (typeof p !== 'string' || !p) return false;
  if (!p.toLowerCase().endsWith('.docx')) return false;
  await shell.openPath(p);
  return true;
});

// 更新装好之后重启。relaunch 排一个新实例，quit 关掉当前这个 ——
// window-all-closed 里会顺手 kill 掉 Python 后端，新实例会重新起一个。
// 往剪贴板写一段文字（注册指南那个「复制地址」用）。
//
// 🔴 **不能用渲染层的 navigator.clipboard。** 页面是 loadFile 起来的，
//    file:// 不是安全上下文，那个 API 在这儿直接不存在 —— 写了不报错，
//    只是永远拿不到剪贴板，用户点了没反应还不知道为什么。
ipcMain.handle('copy-text', (_e, s) => {
  if (typeof s !== 'string' || !s) return false;
  clipboard.writeText(s.slice(0, 2000));
  return true;
});

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.quit();
  return true;
});

// 🔴 **这个软件不弹浏览器。**
//
//    这里曾经有 `open-url`（配一份域名白名单）。2026-09-08 作者定了删：
//    能不能弹出浏览器取决于用户机器上的默认程序关联、协议注册、安全
//    软件拦不拦 —— 保证不了的事就不做，改成「复制地址」让用户自己粘。
//
//    所以 `shell.openExternal` 在这个项目里**一次都不该出现**，
//    tests/front_check.js 有一条测试盯着这句话。
