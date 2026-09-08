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
  err: '',
};

// ── 跟后端说话 ─────────────────────────────────────────────────────────

function apiUrl(p) { return 'http://127.0.0.1:' + state.port + p; }

// 🔴 **get 必须检查 r.ok。**
//    老项目的 get 是 `fetch(u).then(r => r.json())` —— 没有这一句，于是
//    404 会当成正常数据 resolve 掉，调用方的 .catch 永远进不去。那边为
//    「撞到 404 就停止轮询」写的整段代码从来没执行过（2026-09-08 查出，
//    而台账里已经记了「已修」）。这里从第一行就带上。
function httpGet(p) {
  return fetch(apiUrl(p)).then(function (r) {
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

function httpPost(p, body) {
  return fetch(apiUrl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (r) {
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

window.P2W_HTTP = { get: httpGet, post: httpPost };
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

document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || !t.getAttribute) return;
  if (t.getAttribute('data-check')) {
    var p = t.getAttribute('data-check');
    state.picked[p] = t.checked;
    // 只改选中状态，不重画 —— 重画会让复选框失焦，连点几个很别扭
  }
});

// 回车提交 token
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && state.editSlot >= 0) {
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
  if (state.page !== 'main') return;
  var paths = [];
  for (var i = 0; i < e.dataTransfer.files.length; i++) {
    var f = e.dataTransfer.files[i];
    var p = window.api.pathForFile ? window.api.pathForFile(f) : f.path;
    if (p) paths.push(p);
  }
  if (paths.length) window.P2W_ACTS.addPaths(paths);
});

// ── 开机 ───────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', function () {
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
    state.err = '连不上后台服务：' + (err && err.message || err);
    state.ready = true;
    render();
  });
});
