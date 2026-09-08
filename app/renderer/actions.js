// actions.js — 界面上每个按钮背后干的事
//
// 全项目只有这一个动作表。`data-act="xxx"` 对应这里的 xxx。

(function () {
  var st = window.P2W_STATE;
  var render = window.P2W_RENDER;
  var HTTP = window.P2W_HTTP;

  var poller = null;

  // 申请 token 的页面。**只此一处**，pages.js 里显示用的那个常量也指同一个
  // 地址 —— 两处写死同一个 URL 迟早改漏一个。
  var TOKEN_URL = 'https://mineru.net/apiManage/token';

  function slotNo(arg) {
    var i = parseInt(arg, 10);
    return (isFinite(i) && i >= 0) ? i : 0;
  }

  // 更新的进度轮询。跟转换那个 poller 分开 —— 两件事各有各的节奏，
  // 共用一个定时器会互相拖累（转换一秒一次，更新下载时也一秒一次，
  // 但更新结束后转换那边还得接着跑）。
  var updPoller = null;

  function stopUpdPolling() {
    if (updPoller) { clearInterval(updPoller); updPoller = null; }
  }

  function pollUpd() {
    HTTP.get('/api/update/download').then(function (d) {
      st.updTask = d;
      if (d.state === 'done' || d.state === 'error'
          || d.state === 'need_confirm' || d.state === 'idle') {
        stopUpdPolling();
      }
      render();
    }).catch(function () { /* 抖一下不管，下轮还会问 */ });
  }

  function doUpdate(allowUnverified) {
    if (st.updTask && (st.updTask.state === 'downloading'
                       || st.updTask.state === 'installing')) return;
    st.err = '';
    st.updTask = { state: 'downloading', got: 0, total: 0, step: '' };
    render();
    HTTP.post('/api/update/download',
              { line: '', allow_unverified: !!allowUnverified })
      .then(function () {
        stopUpdPolling();
        updPoller = setInterval(pollUpd, 1000);
        pollUpd();
      }).catch(function (e) {
        st.updTask = { state: 'error',
                       error: String(e && e.message || e) };
        render();
      });
  }

  // 改完 token / 槽位数之后重新拉一次环境 —— 用量、打码串、栏数都在那边。
  // 🔴 **不要在前端自己算新状态**：后端可能拒了这次修改（重复的 token、
  //    正在转换中），只有它说了算。
  function refreshEnv() {
    return HTTP.get('/api/env').then(function (e) {
      st.env = e;
      render();
    }).catch(function (err) {
      st.err = String(err && err.message || err);
      render();
    });
  }

  // 🔴 **上一轮拿回来的数据长什么样。数据没变就不重绘。**
  //
  //    `render()` 是把整页 `innerHTML` 换掉，所有滚动容器的位置归零、
  //    再由 JS 设回去。用户正滑着列表时被这么来一下，浏览器的惯性当场
  //    断掉 —— 这就是本地版 `pdf_to_word` 里「上下翻动会顿一下、不跟手」
  //    那个 bug（台账第三十二节，作者真机报的，根因确认过：只有转换
  //    进行中才顿）。
  //
  //    **本地版没法用这一招**：它每秒回来的数据里 `elapsed`（已用时）和
  //    `remain`（倒计时）必然在变，判不出相等，一轮都跳不掉 —— 而且那
  //    两个数用户就是要看的，跳过反而是坏了。
  //
  //    **云端版可以**，因为进度条和倒计时被砍掉了（作者 2026-09-08 定
  //    的：云端只给 pending/running/done，编一个百分比不如不给）。
  //    一份文件转三分钟，中间那个 JSON 一个字节都不变 —— 一百八十轮里
  //    有一百七十多轮可以完全不碰 DOM。
  //
  //    ⚠️ 这**不是根治**。真要根治得把整页重绘改成局部更新，那是动骨架。
  //    这里只是把「每秒撞你一次」变成「整个转换过程撞三五次」。
  var lastSig = '';

  // 🔴 **签名要把「每秒都在变、但界面上根本不显示」的字段剔掉。**
  //
  //    2026-09-08 实测栽在这儿：后端 poll 每秒返回一个 `elapsed`
  //    （已用时），而这个界面从头到尾没显示过它 —— 于是
  //    `JSON.stringify(d)` 每秒都不同，上面那道「数据没变就不重绘」
  //    **从来没生效过**，每秒照样整页 innerHTML 重来。任务一多、
  //    列表一长就卡，作者真机报的。
  //
  //    最讽刺的是上面那段注释里就写着「本地版没法用这一招，因为它
  //    每秒回来的 elapsed 必然在变」—— 写下了原则，实现却正好相反，
  //    而且写下之后没有人再核对过。
  //
  //    **反向排除，不是正着列举。** 只把「确定每秒在变、且界面不用」
  //    的字段挑出去，其余一律进签名：
  //      · 正着列举漏一个 → 界面该变没变（bug）
  //      · 反着排除漏一个 → 多重绘一次（性能）
  //    错的方向必须朝安全那一侧。
  //
  //    往这里加字段之前先问一句：**界面上真的不显示它吗？**
  var SIG_SKIP = { elapsed: 1 };

  function convSig(d) {
    if (!d || typeof d !== 'object') return String(d);
    var o = {};
    for (var k in d) {
      if (Object.prototype.hasOwnProperty.call(d, k) && !SIG_SKIP[k]) {
        o[k] = d[k];
      }
    }
    return JSON.stringify(o);
  }

  function stopPolling() {
    if (poller) { clearInterval(poller); poller = null; }
    lastSig = '';
  }

  function poll() {
    if (!st.taskId) { stopPolling(); return; }
    HTTP.get('/api/convert/' + st.taskId).then(function (d) {
      st.task = d;
      if (d.state === 'done' || d.state === 'cancelled') {
        stopPolling();
        // 转完刷新历史
        HTTP.get('/api/runs').then(function (r) {
          st.runs = (r && r.rows) || [];
          render();
        }).catch(function () { render(); });
        return;
      }
      // 跟上一轮一模一样就别动 DOM —— 见上面 lastSig 那段。
      // 终态（done / cancelled）走的是上面那条路，一定会重绘，
      // 不会被这道判断挡住。
      var sig = convSig(d);
      if (sig === lastSig) return;
      lastSig = sig;
      render();
    }).catch(function (e) {
      // 🔴 **任务不在了就别再问。** 后端的任务表有上限，老 id 会被挤掉；
      //    不停的话就是每秒空转一次 404，而界面停在旧状态。
      //    （这条在老项目里写了但没生效 —— 因为那边的 get 不检查状态码，
      //      catch 根本进不来。这里的 httpGet 检查了，所以是真的能停。）
      if (e && (e.status === 404 || String(e.message).indexOf('没有这个任务') >= 0)) {
        stopPolling();
        st.err = '这个任务已经不在了，重新开始吧';
        render();
        return;
      }
      // 其余（瞬时失败）不惊动用户，下一轮还会问
    });
  }

  function startPolling() {
    stopPolling();
    poller = setInterval(poll, 1000);
    poll();
  }

  function addPaths(paths) {
    if (!paths || !paths.length) { render(); return; }
    st.scanning = true;
    st.err = '';
    render();
    HTTP.post('/api/scan', { paths: paths }).then(function (d) {
      var seen = {};
      st.items.forEach(function (x) { seen[x.path] = true; });
      (d.items || []).forEach(function (x) {
        if (!seen[x.path]) {
          st.items.push(x);
          seen[x.path] = true;
          if (x.ok) st.picked[x.path] = true;
        }
      });
      st.scanning = false;
      render();
    }).catch(function (e) {
      st.scanning = false;
      st.err = String(e && e.message || e);
      render();
    });
  }

  window.P2W_ACTS = {
    // 只给测试用：让 tests/front_check.js 能一轮一轮地驱动轮询，
    // 验「数据没变就不重绘」是真的挡住了，而不是源码里有那几行。
    __poll: poll,

    addPaths: addPaths,

    pickFiles: function () {
      window.api.pickFiles().then(addPaths);
    },

    pickDir: function () {
      window.api.pickDir().then(function (d) { if (d) addPaths([d]); });
    },

    clearAll: function () {
      if (window.P2W_ISRUNNING(st)) return;
      st.items = [];
      st.picked = {};
      st.task = null;
      st.taskId = '';
      st.showReport = false;
      st.err = '';
      render();
    },

    removeOne: function (p) {
      if (window.P2W_ISRUNNING(st)) return;
      st.items = st.items.filter(function (x) { return x.path !== p; });
      delete st.picked[p];
      render();
    },

    pickOutDir: function () {
      window.api.pickOutDir().then(function (d) {
        if (d) { st.outDir = d; render(); }
      });
    },

    useSourceDir: function () {
      st.outDir = '';
      render();
    },

    // ── 设置页 ───────────────────────────────────────────────────────
    openSettings: function () {
      st.page = 'settings';
      st.editSlot = -1;
      st.copied = false;
      st.err = '';
      render();
      refreshEnv();          // 进来时刷一次，用量才是新的
    },

    editSlot: function (arg) {
      st.editSlot = slotNo(arg);
      st.err = '';
      render();
      var box = document.getElementById('tokenbox');
      if (box) box.focus();
    },

    cancelSlot: function () {
      st.editSlot = -1;
      st.err = '';
      render();
    },

    saveSlot: function (arg) {
      if (st.tokenBusy || st.editSlot < 0) return;
      var box = document.getElementById('tokenbox');
      // arg 是回车提交时带进来的输入框内容；点按钮时 arg 是 data-arg（空）
      var v = (arg && arg.length > 4) ? arg : (box ? box.value : '');
      var slot = st.editSlot;
      st.tokenBusy = true;
      st.err = '';
      render();
      // 后端存之前会真验一次（还会查重），验不过返回 400
      HTTP.post('/api/token', { token: v, slot: slot }).then(function () {
        st.tokenBusy = false;
        st.editSlot = -1;
        return refreshEnv();
      }).catch(function (e) {
        st.tokenBusy = false;
        st.err = String(e && e.message || e);
        render();
      });
    },

    clearSlot: function (arg) {
      var i = slotNo(arg);
      HTTP.post('/api/token', { token: '', slot: i })
        .then(refreshEnv)
        .catch(function (e) {
          st.err = String(e && e.message || e);
          render();
        });
    },

    // 下拉框改「几个 token 栏」时由 app.js 的 change 监听调过来
    setSlotCount: function (n) {
      HTTP.post('/api/slots', { slots: n })
        .then(refreshEnv)
        .catch(function (e) {
          st.err = String(e && e.message || e);
          render();
        });
    },

    // ── 检查更新 ─────────────────────────────────────────────────────
    checkUpdate: function () {
      if (st.updBusy) return;
      st.updBusy = true;
      st.updTask = null;        // 重来一次就把上次的失败清掉
      st.updLines = false;
      st.updNotes = false;
      st.err = '';
      render();
      HTTP.get('/api/update/check').then(function (d) {
        st.updBusy = false;
        st.upd = d;
        render();
      }).catch(function (e) {
        st.updBusy = false;
        // 🔴 连后端都没通 —— 造一个同形状的结果，界面才有话说。
        //    不然按钮转一下就回到原样，用户不知道发生了什么。
        st.upd = { has_update: false, error: '连不上本机后台：'
                   + String(e && e.message || e), lines: [] };
        render();
      });
    },

    startUpdate: function () { doUpdate(false); },

    // 拿不到官方校验值时用户点「知道风险，继续」走这条。
    updateAnyway: function () { doUpdate(true); },

    toggleUpdLines: function () {
      st.updLines = !st.updLines;
      render();
    },

    toggleUpdNotes: function () {
      st.updNotes = !st.updNotes;
      render();
    },

    restartApp: function () {
      window.api.restart();
    },

    copyTokenUrl: function () {
      window.api.copyText(TOKEN_URL);
      st.copied = true;
      render();
    },

    // ── 转换 ─────────────────────────────────────────────────────────
    start: function () {
      if (st.starting || window.P2W_ISRUNNING(st)) return;
      var paths = st.items.filter(function (x) {
        return x.ok && st.picked[x.path];
      }).map(function (x) { return x.path; });
      if (!paths.length) return;
      st.starting = true;
      st.err = '';
      st.showReport = false;
      render();
      HTTP.post('/api/convert', { paths: paths, out_dir: st.outDir }).then(function (d) {
        st.starting = false;
        st.taskId = d.task_id;
        st.task = { state: 'running', current: 0, total: d.total,
                    now: '', lines: [], results: [] };
        render();
        startPolling();
      }).catch(function (e) {
        st.starting = false;
        st.err = String(e && e.message || e);
        render();
      });
    },

    // 正转着的时候把新选的文件加到队列后面（作者要的「双队列」）。
    // 🔴 **输出目录跟着原来那一批**，后端不认这里传的 out_dir ——
    //    一批文件散落两个目录，用户回头找不着。
    appendQueue: function () {
      if (!st.taskId || !window.P2W_ISRUNNING(st)) return;
      var paths = st.items.filter(function (x) {
        return x.ok && st.picked[x.path];
      }).map(function (x) { return x.path; });
      if (!paths.length) return;
      st.starting = true;
      st.err = '';
      render();
      HTTP.post('/api/convert/' + st.taskId + '/append', { paths: paths })
        .then(function (d) {
          st.starting = false;
          // 加进队列的从待选清单里拿掉 —— 留着会让人以为没加上
          var gone = {};
          paths.forEach(function (p) { gone[p] = true; });
          st.items = st.items.filter(function (x) { return !gone[x.path]; });
          paths.forEach(function (p) { delete st.picked[p]; });
          if (d && d.skipped) {
            st.err = '有 ' + d.skipped + ' 份已经在队列里了，没重复加';
          }
          render();
        }).catch(function (e) {
          st.starting = false;
          st.err = String(e && e.message || e);
          render();
        });
    },

    stop: function () {
      if (!st.taskId) return;
      HTTP.post('/api/convert/' + st.taskId + '/cancel', {}).catch(function () {});
    },

    newBatch: function () {
      st.task = null;
      st.taskId = '';
      st.showReport = false;
      st.err = '';
      // 只把「这一批真转过的」取消勾选，没转过的留着
      var ran = {};
      ((st.task && st.task.results) || []).forEach(function (r) { ran[r.pdf] = true; });
      render();
    },

    toggleReport: function () {
      st.showReport = !st.showReport;
      render();
    },

    // ── 打开产物 ─────────────────────────────────────────────────────
    openFile: function (p) { window.api.openFile(p); },
    openFolder: function (p) { window.api.openPath(p); },

    // ── 历史 ─────────────────────────────────────────────────────────
    openHistory: function () {
      st.page = 'history';
      render();
      HTTP.get('/api/runs').then(function (d) {
        st.runs = (d && d.rows) || [];
        render();
      }).catch(function () { /* 拉不到就显示已有的 */ });
    },

    backMain: function () {
      st.page = 'main';
      render();
    },

    dismissErr: function () {
      st.err = '';
      render();
    },
  };
})();
