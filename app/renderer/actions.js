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
  // ⚠️ 这两个常量 pages.js 里也各有一份（那边渲染要用）。改一处记得改两处。
  var RELEASE_URL = 'https://github.com/kiryusento2017/teach-studio/releases';

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
  //    ⚠️ 这原先「不是根治」—— 2026-09-09 把局部更新补上了：结构没变时
  //    只改两处 textContent（patchConv），整页 innerHTML 不动。
  //    现在的三道闸依次是：签名没变 → 不动；当前屏不显示任务 → 不动；
  //    结构没变 → 只 patch 文字。都过不去才整页重画。
  var lastSig = '';
  var lastStruct = '';

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
    // 🔴 **lines 只有最后一行会显示**（当前那行的右侧），日志屏开着时才要全部。
    //    不这么掐的话，后端每吐一行日志签名就变一次 —— 界面上明明只多了
    //    半句话，却整页 innerHTML 重来，滚动惯性当场断。
    if (!st.showLog && o.lines) {
      o.lines = (d.lines || []).slice(-1)[0] || '';
    }
    return JSON.stringify(o);
  }

  // 结构签名：**换了一份、多了一条结果、状态变了**才算结构变。
  // 这几样一变必须整页重画（行数、顺序、按钮都跟着变）；只是那句状态文字
  // 变了的话，patchConv 改两个 textContent 就够。
  function structSig(d) {
    if (!d) return '';
    return [d.state, d.current, d.total,
            (d.results || []).length,
            (st.pending || []).length].join('|');
  }

  // 🔴 **抓手不在就什么都不做。** 找不到这两个元素说明当前屏根本不显示
  //    任务状态（在历史页 / 设置页 / 关于页 / 报告屏 / 日志屏），
  //    那就没什么可 patch 的，也不该整页重画去打断用户。
  //    返回 true = 已经处理完，调用方不用再 render。
  function patchConv(d) {
    var nowEl = document.getElementById('convnow');
    if (!nowEl) return false;
    nowEl.textContent = d.now || '准备中…';
    var lineEl = document.getElementById('convline');
    if (lineEl) {
      lineEl.textContent = (d.lines || []).slice(-1)[0] || '正在处理…';
    }
    return true;
  }

  function stopPolling() {
    if (poller) { clearInterval(poller); poller = null; }
    lastSig = '';
    lastStruct = '';
  }

  function poll() {
    if (!st.taskId) { stopPolling(); return; }
    HTTP.get('/api/convert/' + st.taskId).then(function (d) {
      st.task = d;
      if (d.state === 'done' || d.state === 'cancelled') {
        stopPolling();
        // 转完刷新两样：转换历史，和各个 token 的今日用量。
        //
        // 🔴 用量**后端在提交那一刻就记好了**（见 convert.py 的
        //    note_pages），但界面上那个数字来自 /api/env —— 不重新拉
        //    一次的话，底栏还显示转之前的数，得进一趟设置页才更新。
        //    账是准的、显示是滞后的，这种落差最容易让人以为没记上。
        HTTP.get('/api/runs').then(function (r) {
          st.runs = (r && r.rows) || [];
          render();
        }).catch(function () { render(); });
        refreshEnv();
        // 待办接上：转完自动起新一批；中途停了就并回待转清单。
        if (d.state === 'done' && st.pending.length) {
          promotePending();
          return;
        }
        if (d.state === 'cancelled' && st.pending.length) {
          mergePendingToItems();
        }
        return;
      }
      // 跟上一轮一模一样就别动 DOM —— 见上面 lastSig 那段。
      // 终态（done / cancelled）走的是上面那条路，一定会重绘，
      // 不会被这道判断挡住。
      var sig = convSig(d);
      if (sig === lastSig) return;
      lastSig = sig;

      // 当前屏不显示任务状态（历史 / 设置 / 关于）就别画 —— st.task 已经
      // 更新过了，用户切回主屏时 backMain 会画一次，看到的是最新的。
      // 不挡的话在历史页翻记录时每秒被重绘一次，滚动条一直往回跳。
      if (st.page !== 'main') return;

      // 结构没变（还在转同一份）→ 只改那两处文字，整页不动。
      // 日志屏开着时 lines 要整段重排，patchConv 抓不到 convnow，
      // 自然会 falseback 到整页 render（有 data-keep-scroll 兜着滚动位置）。
      if (structSig(d) === lastStruct && patchConv(d)) return;
      lastStruct = structSig(d);
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
    // 正在转的时候拖进来的，走待办 —— 不打断这一批。
    //
    // 🔴 判据是 `starting`（请求已发、task 还没回来的那段窗口），**不是
    //    `st.task`**。转完之后 st.task 还留着 done 快照，拿它判会把
    //    「在结果屏上再拖一份进来」也算成忙 —— 于是进待办、体检回来发现
    //    这批已经 done、自动晋升、**不问一句直接开转**，白花 MinerU 额度。
    //    反过来漏掉 starting 也不行：那一刻 task 还是 null，文件会被当成
    //    新的一批塞进 items，可这批的 paths 早发出去了，那几份永远显示
    //    「未处理」。两个洞都堵在这一行。
    if (window.P2W_ISRUNNING(st) || st.starting) { addPending(paths); return; }
    if (!paths || !paths.length) { render(); return; }
    st.scanning = true;
    st.err = '';
    render();
    HTTP.post('/api/scan', { paths: paths }, HTTP.SCAN_TIMEOUT).then(function (d) {
      var seen = {};
      st.items.forEach(function (x) { seen[x.path] = true; });
      (d.items || []).forEach(function (x) {
        if (!seen[x.path]) {
          st.items.push(x);
          seen[x.path] = true;
          if (x.ok) st.picked[x.path] = true;
        }
      });
      // 🔴 拖进来一个不含 PDF 的文件夹时要说话。不说的话界面一个字不变，
      //    用户不知道是软件没反应还是里面真没有东西。
      //    ⚠️ 判据跟本地版一样是「整个清单为空」—— 清单里已经有文件时
      //    再拖一个空文件夹进来仍然不吭声。两边同病，先保持一致。
      if (!st.items.length) st.err = '这里面没有找到 PDF';
      st.scanning = false;
      render();
    }).catch(function (e) {
      st.scanning = false;
      st.err = String(e && e.message || e);
      render();
    });
  }

  // ── 待办 ─────────────────────────────────────────────────────────────
  //
  // 转换中拖进来的文件先进这儿，这一批转完自动晋升成新一批。
  // 后端**不知道待办的存在** —— 一批就是一批，晋升时前端起一个新任务。

  function addPending(paths) {
    if (!paths || !paths.length) { render(); return; }
    st.pendingBusy = true;
    st.err = '';
    render();
    HTTP.post('/api/scan', { paths: paths }, HTTP.SCAN_TIMEOUT).then(function (d) {
      // 🔴 **去重要比两样**：待办里已有的、**正在转的这批**。
      //    用户很可能把已经在转的某份又拖一次，那份转出来会覆盖同一个
      //    .docx，白花一次额度。
      var seen = {};
      st.pending.forEach(function (x) { seen[x.path] = true; });
      st.items.forEach(function (x) { seen[x.path] = true; });
      (d.items || []).forEach(function (x) {
        // 体检不过的不进待办 —— 它在主队列里同样会当场失败，
        // 提前挡掉比让用户等到晋升之后才看见一个红叉好。
        if (x.ok && !seen[x.path]) { st.pending.push(x); seen[x.path] = true; }
      });
      st.pendingBusy = false;

      // 🔴 **体检的这十几秒里，这一批可能已经转完了。**
      //
      //    扫一个文件夹要时间。等它回来时轮询可能早就拿到 done 了 ——
      //    而那一刻 st.pending 还是空的，所以轮询走的是「没有待办」
      //    那条路：停轮询、不晋升。之后再没有任何东西会碰这些文件：
      //    既不转、也不显示（done 时待办整块不渲染）、连「移除」都点不到，
      //    而且会一直躺着，等用户下次手动开一批转完时被突然拉起来 ——
      //    那时他早忘了自己拖过什么。
      //
      //    所以体检回来必须自己补一次判断，不能指望轮询。
      if (st.task && st.task.state === 'done' && st.pending.length) {
        promotePending();
        return;
      }
      if (st.task && st.task.state === 'cancelled' && st.pending.length) {
        mergePendingToItems();
      }
      render();
    }).catch(function (e) {
      st.pendingBusy = false;
      st.err = String(e && e.message || e);
      render();
    });
  }

  // 待办晋升成主队列。**这批转完的那一刻自动调，不问用户。**
  //
  // 复用 start() 起新任务，不另写一条发起转换的路 —— start() 里那几样
  // 状态归位（showReport 之类）是「上一批的界面状态不许串到新一批」的
  // 既有教训，另起一条等于把它们漏掉。
  function promotePending() {
    // 上一批的结果留一份，报告要靠它。放在改 items 之前 ——
    // 下面那句一改，st.task 还在但列表已经是新一批的了。
    st.lastResults = (st.task && st.task.results) || null;
    st.showLastReport = false;
    st.items = st.pending.slice();
    st.picked = {};
    st.items.forEach(function (x) { st.picked[x.path] = true; });
    st.pending = [];
    window.P2W_ACTS.start();
  }

  // 中途停了的话，待办并回待转清单**让用户自己决定** ——
  // 他按了停止，不该反手又给他起一批。
  function mergePendingToItems() {
    var seen = {};
    st.items.forEach(function (x) { seen[x.path] = true; });
    st.pending.forEach(function (x) {
      if (!seen[x.path]) {
        st.items.push(x);
        st.picked[x.path] = true;
      }
    });
    st.pending = [];
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

    // ── 选择 ───────────────────────────────────────────────────────────
    //
    // 🔴 **picked 是三态**：`true` / `false` / 键根本不存在。
    //    判「选中了吗」一律用 `!== false` —— 没出现过的键视为选中，
    //    这样拖进来的文件默认全勾，用户直接点「开始转换」就行，
    //    不用先一个个勾一遍。
    toggle: function (path) {
      st.picked[path] = st.picked[path] === false;
      render();
    },

    selAll: function () {
      st.items.forEach(function (x) { if (x.ok) st.picked[x.path] = true; });
      render();
    },

    selNone: function () {
      st.items.forEach(function (x) { st.picked[x.path] = false; });
      render();
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

    // 点「+ 添加」：开一行空的输入框。保存时 slot 传 -1 = 添一个新的。
    addSlot: function () {
      st.editSlot = 'new';
      st.err = '';
      render();
      var box = document.getElementById('tokenbox');
      if (box) box.focus();
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
      if (st.tokenBusy) return;
      // 'new' = 添一个；数字 = 改第几个；-1 = 根本没在编辑
      var adding = (st.editSlot === 'new');
      if (!adding && !(st.editSlot >= 0)) return;
      var box = document.getElementById('tokenbox');
      // arg 是回车提交时带进来的输入框内容；点按钮时 arg 是 data-arg（空）
      var v = (arg && arg.length > 4) ? arg : (box ? box.value : '');
      var slot = adding ? -1 : st.editSlot;
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

    // 🔴 这里曾经有个 setSlotCount，配合设置页那个「几个 token 栏」的
    //    下拉框。2026-09-08 改成「+ 添加 / 删」之后，「栏数」这个概念
    //    整个没了 —— 栏数就是 token 数，不需要单独设。接口
    //    POST /api/slots 也一并删了。

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

    // 跨大版本要重下整包时的出路。**云端不弹浏览器**，所以给的是
    // 「复制地址」而不是「去下载页」—— 用户自己粘到浏览器，百分百可控。
    copyReleaseUrl: function () {
      window.api.copyText(RELEASE_URL);
      st.copied = true;
      render();
    },

    // 更新是独立一屏，从设置页进。进来顺手清掉上一次的复制标记。
    openUpdate: function () {
      st.page = 'update';
      st.copied = false;
      st.err = '';
      render();
    },

    // ── 转换 ─────────────────────────────────────────────────────────
    start: function () {
      if (st.starting || window.P2W_ISRUNNING(st)) return;
      var paths = st.items.filter(function (x) {
        return x.ok && st.picked[x.path] !== false;
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
        // 🔴 **不清 st.items。** 转换中的那张表就是从它画出来的 ——
        //    结果按路径贴到对应行上，行的状态在变、表本身不变。
        //
        //    2026-09-08 这里曾经清过一次：当时的列表是「已完成 + 正在转 +
        //    排队中 + 刚拖进来」四段拼接，不清就会把同一批文件在下面再
        //    列一遍。那是打在症状上的补丁 —— 换成一张表之后，
        //    根本不会有那种事，而清了反而没东西可画。
        st.showReport = false;
        st.showLastReport = false;
        render();
        startPolling();
      }).catch(function (e) {
        st.starting = false;
        st.err = String(e && e.message || e);
        render();
      });
    },

    // 转换中的「再加几份」。选完直接进待办，不打断这一批。
    pickMore: function () {
      window.api.pickFiles().then(function (ps) {
        if (ps && ps.length) addPending(ps);
      });
    },

    delPending: function (p) {
      st.pending = st.pending.filter(function (x) { return x.path !== p; });
      render();
    },

    toggleLastReport: function () {
      st.showLastReport = !st.showLastReport;
      render();
    },

    stop: function () {
      if (!st.taskId) return;
      HTTP.post('/api/convert/' + st.taskId + '/cancel', {}).catch(function () {});
    },

    // 「再转一批」：回到空的待转清单。
    //
    // 🔴 上一批的结果**不留** —— 那张表已经看过了，它的 Word 也已经躺在
    //    用户硬盘里。留着的话点完「再转一批」还看见一堆旧文件，
    //    用户会以为没清干净。（lastResults 是给「待办晋升」那条路用的，
    //    手动开新一批不走那儿。）
    // 🔴 **不清列表 —— 把失败的留下来勾上，等于一键重试。**
    //    原先是整个清空，用户想重转失败的那几份得重新拖一遍。
    newBatch: function () {
      var failed = {};
      var ran = {};
      ((st.task && st.task.results) || []).forEach(function (r) {
        ran[r.pdf] = true;
        if (!r.ok) failed[r.pdf] = true;
      });

      // 🔴 **只重设这一批真转过的那些。** st.items 里可能混着根本没转过的
      //    文件：摁停止时并回来的待办、晋升时 start() 失败留下的那批。
      //    它们在 results 里没有记录，一律重设的话会被取消勾选 ——
      //    用户看到的是「软件把我刚拖进来的东西吃了」。
      st.items.forEach(function (x) {
        if (ran[x.path]) st.picked[x.path] = !!failed[x.path];
      });

      st.task = null;
      st.taskId = '';
      st.showReport = false;
      // 🔴 手动开新一批 = 不再关心上一批。不清的话 lastResults 会隔着一批
      //    串味：A 晋升 B（lastResults 记的是 A）→ B 转完没有待办 →
      //    点「再转一批」手动转 C → C 运行中点「上一批的报告」看到的是 A。
      //    报告是拿去核对 Word 的清单，指错批次等于指错文件。
      st.lastResults = null;
      st.showLastReport = false;
      st.err = '';
      stopPolling();
      render();
    },

    // 🔴 **日志和报告互斥**：它们抢的是同一块内容区，两个都开的话
    //    后判断的那个会把前一个盖掉，用户点了没反应。
    toggleLog: function () {
      st.showLog = !st.showLog;
      if (st.showLog) st.showReport = false;
      render();
    },

    toggleReport: function () {
      st.showReport = !st.showReport;
      if (st.showReport) st.showLog = false;
      // copied 是设置页「复制地址」和报告页「复制」共用的一个标志，
      // 进出报告页时清掉，免得刚从设置页复制过地址、一进来就写着「已复制」。
      st.copied = false;
      render();
    },

    // 🔴 **走主进程剪贴板，不用 navigator.clipboard。** 页面是 file:// 加载的，
    //    浏览器的剪贴板 API 在那个来源下用不了（设置页的「复制地址」同理）。
    copyReport: function () {
      var text = st.reportText || '';
      if (!text) return;
      window.api.copyText(text);
      st.copied = true;
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

    // 关于页。版本号来自 st.env.version，进来刷一次 —— 刚更新完回来
    // 看到的还是旧版本号的话，会让人以为更新没生效。
    openAbout: function () {
      st.page = 'about';
      st.err = '';
      render();
      refreshEnv();
    },

    dismissErr: function () {
      st.err = '';
      render();
    },

    // ── 拦截屏和「连不上后台」的两个出口 ────────────────────────────
    //
    // 都是浏览器自带的，不经过主进程 —— 少一条 IPC 通道就少一处能坏的地方。
    // reload 会把整个页面重新加载一遍，等于重走开机自检（getPort → /api/env），
    // 正是「我把文件夹挪好了，你再看看」要的效果。
    reload: function () { window.location.reload(); },
    quit: function () { window.close(); },
  };
})();
