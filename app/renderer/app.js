// app.js — 状态、渲染、跟后端说话
//
// 这个前端没有框架：一个全局 state + 一个 render() 把整页重画。
// 老项目就是这么写的，搬过来是因为它够用且好懂 —— 但那边攒下的几个坑
// 这里一开始就避开，见下面每处的 🔴。

var state = {
  page: 'main',        // main | history | settings
  port: 0,
  ready: false,

  env: null,           // /api/env 的结果
  // 正在编辑第几个 token 栏。-1 = 没在编辑。
  // 🔴 **token 的填写只在设置页做**，主屏不再内嵌输入框 —— 一个东西
  //    两个地方能改，迟早两边说法不一致。
  editSlot: -1,
  tokenBusy: false,

  // 检查更新。upd = /api/update/check 的结果，updTask = 下载/安装进度。
  upd: null,
  updBusy: false,
  updTask: null,
  updLines: false,     // 展开「各条线路怎么样」
  updNotes: false,     // 展开完整更新说明

  items: [],           // 体检过的待转清单
  picked: {},          // path -> 选没选
  outDir: '',          // 空 = 跟原 PDF 放一起
  scanning: false,
  dragging: false,     // 文件正拖在窗口上（空列表时给「松手就行」）

  // 待办：转换中新拖进来的文件排在这儿，**不混进 items**。
  // 这一批转完自动晋升成新一批（见 actions.promotePending）。
  pending: [],
  pendingBusy: false,
  lastResults: null,   // 上一批的结果，晋升之后还能看它的报告
  showLastReport: false,

  taskId: '',
  task: null,          // 轮询结果
  starting: false,

  runs: [],            // 转换历史
  showReport: false,
  reportText: '',      // 报告正文，渲染时存下来给「复制」用
  showLog: false,       // 摊开云端返回的那几行状态
  err: '',

  // 🔴 **后台连不上要跟普通报错分开。** 塞进 err 的话，界面照样往下走，
  //    最后落到「请填 token」那一屏 —— 后台都没起来，让人填 token
  //    是把他往沟里带，而且那屏没有任何重试的出口。
  envError: '',
};

// ── 跟后端说话 ─────────────────────────────────────────────────────────

function apiUrl(p) { return 'http://127.0.0.1:' + state.port + p; }

// 🔴 **每个请求都要有超时。** fetch 默认不超时 —— 后端要是挂住不返回，
//    starting / tokenBusy / updBusy 这些忙态标志就永远置着，界面卡在
//    「正在开始…」上，除了重启软件没别的办法。
//
//    默认 30 秒。**体检要单独放宽**：扫一个大文件夹本来就慢（本地版实测
//    456 份要 16 秒），拿 30 秒卡它是误伤，调用处传 SCAN_TIMEOUT。
var DEFAULT_TIMEOUT = 30000;
var SCAN_TIMEOUT = 300000;

function fetchWithTimeout(url, opts, ms) {
  var wait = ms || DEFAULT_TIMEOUT;
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, wait);
  opts = opts || {};
  opts.signal = ctl.signal;
  return fetch(url, opts).then(function (r) {
    clearTimeout(timer);
    return r;
  }, function (e) {
    clearTimeout(timer);
    // abort 报出来的原文是 "The user aborted a request"，摆给用户看没有意义
    if (e && e.name === 'AbortError') {
      throw new Error('后台一直没回话（等了 ' + Math.round(wait / 1000) + ' 秒）');
    }
    throw e;
  });
}

// 🔴 **get 必须检查 r.ok。**
//    老项目的 get 是 `fetch(u).then(r => r.json())` —— 没有这一句，于是
//    404 会当成正常数据 resolve 掉，调用方的 .catch 永远进不去。那边为
//    「撞到 404 就停止轮询」写的整段代码从来没执行过（2026-09-08 查出，
//    而台账里已经记了「已修」）。这里从第一行就带上。
function httpGet(p, ms) {
  return fetchWithTimeout(apiUrl(p), null, ms).then(function (r) {
    return r.json().then(function (d) {
      if (!r.ok) {
        var e = new Error(d.detail || ('HTTP ' + r.status));
        e.status = r.status;
        throw e;
      }
      return d;
    });
  });
}

function httpPost(p, body, ms) {
  return fetchWithTimeout(apiUrl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, ms).then(function (r) {
    return r.json().then(function (d) {
      if (!r.ok) {
        var e = new Error(d.detail || ('HTTP ' + r.status));
        e.status = r.status;
        throw e;
      }
      return d;
    });
  });
}

window.P2W_HTTP = { get: httpGet, post: httpPost, SCAN_TIMEOUT: SCAN_TIMEOUT };
// actions.js / pages.js 都从这里拿状态 —— 只有一份，不复制。
window.P2W_STATE = state;

// ── 渲染 ───────────────────────────────────────────────────────────────

function render() {
  var el = document.getElementById('app');
  if (!el) return;

  // 重绘是整页 innerHTML 换掉，所有滚动容器的位置都会归零。
  // 画之前记下来、画完放回去。**认 data-keep-scroll，不写死选择器** ——
  // 老项目是一个容器写一段，结果连着漏了两回（新加滚动区的人不记得
  // 回来改这里）。标记跟容器写在一起，加的时候顺手就带上。
  var keep = {};
  var olds = el.querySelectorAll('[data-keep-scroll]');
  for (var i = 0; i < olds.length; i++) {
    var k = olds[i].getAttribute('data-keep-scroll');
    if (k) keep[k] = olds[i].scrollTop;
  }

  var page = window.P2W_PAGES[state.page] || window.P2W_PAGES.main;
  el.innerHTML = page(state);

  var news = el.querySelectorAll('[data-keep-scroll]');
  for (var j = 0; j < news.length; j++) {
    var k2 = news[j].getAttribute('data-keep-scroll');
    if (k2 && keep[k2]) news[j].scrollTop = keep[k2];
  }
}

window.P2W_RENDER = render;

function isRunning(st) {
  return !!(st.task && st.task.state === 'running');
}
window.P2W_ISRUNNING = isRunning;

// ── 事件委托 ───────────────────────────────────────────────────────────

document.addEventListener('click', function (e) {
  var t = e.target;
  while (t && t !== document.body && !t.getAttribute('data-act')) {
    t = t.parentNode;
  }
  if (!t || !t.getAttribute) return;
  var act = t.getAttribute('data-act');
  if (!act) return;
  var fn = window.P2W_ACTS[act];
  // 🔴 不许有「按钮在、处理器不在」的情况。老项目的前端检查只验
  //    handler 存不存在，验不了它会不会立刻 return —— 那边就有一个
  //    「重新下载」按钮点了什么都不发生。这里直接报出来。
  if (typeof fn !== 'function') {
    state.err = '这个按钮没接上：' + act;
    render();
    return;
  }
  fn(t.getAttribute('data-arg') || '', t);
});

// 🔴 这里原先有一个 change 监听，认列表行 checkbox 上的 data-check。
//    2026-09-09 整段删掉：列表改成「点整行都能勾」之后 checkbox 设了
//    pointer-events:none，点击穿透到行上走 data-act="toggle"，它自己会
//    render()。留着这个监听既收不到事件，又会让人以为勾选有两条路。

// 回车提交 token
document.addEventListener('keydown', function (e) {
  // editSlot 是三态：-1 关着、'new' 新增那栏、>=0 改第 N 栏。
  // 只判 `>= 0` 会漏掉 'new'（'new' >= 0 是 false），新增那栏敲回车没反应。
  // 判据跟 actions.js 的 saveSlot 保持一致。
  if (e.key === 'Enter' && (state.editSlot === 'new' || state.editSlot >= 0)) {
    var box = document.getElementById('tokenbox');
    if (box) window.P2W_ACTS.saveSlot(box.value);
  }
});

// ── 拖进来 ─────────────────────────────────────────────────────────────

// 🔴 **转换中也收拖进来的文件**（进待办，不打断这一批）。
//    dragging 只为了让空列表那一屏给一句「松手就行」——
//    没有反馈的拖放区，用户不知道松手会不会有用。
document.addEventListener('dragover', function (e) {
  e.preventDefault();
  if (!state.dragging && state.page === 'main') {
    state.dragging = true;
    render();
  }
});

document.addEventListener('dragleave', function (e) {
  // 拖到窗口外面才算离开：拖过子元素时也会冒出 dragleave，
  // 不判断的话「松手就行」会一路闪烁。
  if (e.relatedTarget) return;
  if (state.dragging) { state.dragging = false; render(); }
});

document.addEventListener('drop', function (e) {
  e.preventDefault();
  state.dragging = false;
  // 🔴 **别的页面拖进来也照收。** 本地版的历史/关于是主屏里的一个分支
  //    （page 一直是 'main'），所以那道判断只挡真正不该收的屏；云端把
  //    历史/设置做成了独立 page，同一句话就变成「拦掉一半界面」——
  //    在历史页拖文件进去连高亮都不亮，看着就是坏了。
  //    用户拖文件的意图很明确，收下并切回主屏，让他看见文件进了列表。
  if (state.page !== 'main') state.page = 'main';
  var paths = [];
  for (var i = 0; i < e.dataTransfer.files.length; i++) {
    var f = e.dataTransfer.files[i];
    var p = window.api.pathForFile ? window.api.pathForFile(f) : f.path;
    if (p) paths.push(p);
  }
  // 🔴 **拿不到路径也要重画一次。** dragging 上面已经置 false 了，可要是
  //    直接 return，界面不会更新 —— 「松手就行」那圈虚线会一直赖在屏幕上，
  //    看着像卡死了。（拖进来的是网页选区、图片这类非文件时就会走到这儿。）
  if (paths.length) window.P2W_ACTS.addPaths(paths);
  else render();
});

// ── 开机 ───────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', function () {
  // 🔴 **先画一帧再去问端口。** 不画的话，从双击图标到 /api/env 回来这段
  //    时间窗口是纯白的 —— 而 mainPage 里那个 `!st.ready → 正在启动…`
  //    分支永远等不到执行（等它执行时 ready 已经是 true 了），等于死代码。
  render();
  window.api.getPort().then(function (p) {
    state.port = p;
    return httpGet('/api/env');
  }).then(function (e) {
    state.env = e;
    state.ready = true;
    render();
    // 历史拉不到不挡主流程
    return httpGet('/api/runs').catch(function () { return { rows: [] }; });
  }).then(function (d) {
    state.runs = (d && d.rows) || [];
    render();
  }).catch(function (err) {
    // ready 照样置 true —— 否则卡在「正在启动…」，连重试按钮都画不出来。
    state.envError = String((err && err.message) || err);
    state.ready = true;
    render();
  });
});
