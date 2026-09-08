// front_check.js — 在 Node 里真渲染一遍前端，验它画出来的 HTML
//
// 为什么要这个：`pages.js` 是纯函数（状态 → HTML 字符串），完全可以在
// 没有浏览器的情况下调用。老项目栽过两次「测试全绿但界面实际没生效」——
// 光断言函数存在不够，要断言**画出来的东西**。
//
// 跑法：node tests/front_check.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;

// 🔴 **必须能等 async。**
//    第一版是直接 fn() 不看返回值 —— async 测试体里的 throw 落在微任务里
//    被吞掉，ck 当场 pass++。结果是：把被测代码拆掉，测试照样全绿。
//    2026-09-08 自己踩了一遍，正是老项目「测试全绿但实际没生效」那个形状。
const queued = [];

function ck(name, fn) {
  const good = () => { pass++; console.log('  ✓ ' + name); };
  const bad = (e) => {
    fail++;
    console.log('  ✗ ' + name + '  ' + (e && e.message || e));
  };
  let r;
  try {
    r = fn();
  } catch (e) {
    bad(e);
    return;
  }
  if (r && typeof r.then === 'function') {
    queued.push(r.then(good, bad));
    return;
  }
  good();
}

// 造一个够用的假 window/document，把三个 JS 跑起来
function mkSandbox() {
  const listeners = {};
  const sb = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: (k, f) => { listeners[k] = f; },
    },
    __listeners: listeners,
  };
  sb.window = sb;
  sb.window.api = {
    getPort: () => Promise.resolve(1),
    pickFiles: () => Promise.resolve([]),
    pickDir: () => Promise.resolve(''),
    pickOutDir: () => Promise.resolve(''),
    openFile: () => {}, openPath: () => {},
    pathForFile: (f) => f.path,
  };
  sb.window.addEventListener = (k, f) => { listeners[k] = f; };
  vm.createContext(sb);
  vm.runInContext(R('app/renderer/app.js'), sb);
  vm.runInContext(R('app/renderer/pages.js'), sb);
  vm.runInContext(R('app/renderer/actions.js'), sb);
  return sb;
}

// 一个「一切正常、可以干活」的基准状态
function ready(sb) {
  const st = sb.window.P2W_STATE;
  st.ready = true;
  st.port = 1;
  st.env = {
    node: { ok: true }, pandoc: { ok: true },
    token: { ok: true, masked: 'sk-demo1...EXAMPLE9' },
    tokens: {
      slots: 2, max_slots: 10, daily_pages: 1000,
      list: [{ has: true, masked: 'sk-demo1...EXAMPLE9', used: 340 },
             { has: false, masked: '', used: 0 }],
    },
    writable: true,
  };
  st.editSlot = -1;
  st.copied = false;
  st.items = []; st.picked = {}; st.task = null; st.taskId = '';
  st.runs = []; st.err = ''; st.showReport = false;
  st.page = 'main'; st.outDir = ''; st.scanning = false; st.starting = false;
  return st;
}

const sb = mkSandbox();
const main = sb.window.P2W_PAGES.main;
const hist = sb.window.P2W_PAGES.history;

console.log('\n开机与拦截：');

ck('还没连上后台时不画空白页', () => {
  const st = ready(sb);
  st.ready = false;
  const h = main(st);
  if (!h.includes('正在启动')) throw new Error('没给「正在启动」的反馈');
});

ck('不再拿 Office 拦人（XSL 已随软件打包）', () => {
  const h = main(ready(sb));
  if (h.includes('Office')) throw new Error('界面上还在提 Office');
});

ck('缺 node/pandoc 要说是安装包不完整，不是让用户去装开发工具', () => {
  const st = ready(sb);
  st.env.node = { ok: false };
  const h = main(st);
  if (!h.includes('安装包不完整')) throw new Error('没拦');
  if (h.includes('nodejs.org')) throw new Error('不该引导用户去下 Node.js');
});

ck('装在不可写目录要拦', () => {
  const st = ready(sb);
  st.env.writable = false;
  const h = main(st);
  if (!h.includes('写不了')) throw new Error('没拦');
});

console.log('\ntoken：');

const settings = sb.window.P2W_PAGES.settings;

ck('没 token 时拦一屏，并把人送去设置页', () => {
  const st = ready(sb);
  st.env.token = { ok: false, masked: '' };
  const h = main(st);
  if (!h.includes('还没填 token')) throw new Error('没拦');
  if (!h.includes('data-act="openSettings"')) throw new Error('没给去设置的入口');
  // 🔴 主屏**不该**再有输入框 —— token 只在设置页填，两处都能改迟早不一致
  if (h.includes('id="tokenbox"')) throw new Error('主屏又冒出输入框了');
});

ck('底栏显示 token 个数和今日用量，不显示 token 原文', () => {
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  st.picked['D:/a.pdf'] = true;
  const h = main(st);
  if (!h.includes('1 个 token')) throw new Error('没显示 token 个数');
  if (!h.includes('今天已用 340 页')) throw new Error('没显示今日用量');
  if (h.includes('EPUTTaAx')) throw new Error('把 token 原文画出来了');
});

console.log('');
console.log('设置页：');

ck('几个栏就画几行', () => {
  const st = ready(sb);
  const h = settings(st);
  if (!h.includes('第 1 个')) throw new Error('没画第 1 栏');
  if (!h.includes('第 2 个')) throw new Error('没画第 2 栏');
  if (h.includes('第 3 个')) throw new Error('画多了');
});

ck('栏数下拉框能选到 10，当前值被选中', () => {
  const st = ready(sb);
  const h = settings(st);
  if (!h.includes('data-slots')) throw new Error('没有下拉框');
  if (!h.includes('<option value="10"')) throw new Error('选不到 10');
  if (!h.includes('<option value="2" selected')) throw new Error('当前值没选中');
});

ck('已填的栏显示打码版和用量，没填的给「填这个」', () => {
  const st = ready(sb);
  const h = settings(st);
  if (!h.includes('sk-demo1...EXAMPLE9')) throw new Error('没显示打码 token');
  if (h.includes('EPUTTaAx')) throw new Error('把 token 原文画出来了');
  if (!h.includes('今天用了 340 页')) throw new Error('没显示这一栏的用量');
  if (!h.includes('data-act="editSlot" data-arg="1"')) throw new Error('空栏没给填入口');
});

ck('点某一栏才出输入框，且只出一个', () => {
  const st = ready(sb);
  st.editSlot = 1;
  const h = settings(st);
  if (!h.includes('id="tokenbox"')) throw new Error('没有输入框');
  if (h.indexOf('id="tokenbox"') !== h.lastIndexOf('id="tokenbox"')) {
    throw new Error('画出了不止一个输入框');
  }
  if (!h.includes('data-act="saveSlot"')) throw new Error('没有保存按钮');
});

ck('正在验的时候保存按钮变灰，不给连点', () => {
  const st = ready(sb);
  st.editSlot = 0;
  st.tokenBusy = true;
  const h = settings(st);
  const i = h.indexOf('data-act="saveSlot"');
  const tag = h.slice(h.lastIndexOf('<button', i), h.indexOf('>', i));
  if (!tag.includes('disabled')) throw new Error('还能连点');
  st.tokenBusy = false;
});

ck('设置页有检查更新，并显示当前版本', () => {
  const st = ready(sb);
  st.env.version = 'v0.1.0';
  const h = settings(st);
  if (!h.includes('data-act="checkUpdate"')) throw new Error('没有检查更新');
  if (!h.includes('v0.1.0')) throw new Error('没显示当前版本');
});

ck('查到新版本给版本号和「立即更新」', () => {
  const st = ready(sb);
  st.upd = { has_update: true, latest: 'v0.2.0', published: '2026-09-09T00:00:00Z',
             notes_brief: '修了两个问题', lines: [] };
  const h = settings(st);
  if (!h.includes('v0.2.0')) throw new Error('没显示新版本号');
  if (!h.includes('data-act="startUpdate"')) throw new Error('没有更新按钮');
  if (!h.includes('修了两个问题')) throw new Error('没显示更新说明');
});

ck('失败时也能看各条线路（连不上时最想知道的就是这个）', () => {
  const st = ready(sb);
  st.upd = { has_update: false, error: '连不上 GitHub',
             lines: [{ id: 'direct', name: 'GitHub 官方', ok: false,
                       error: 'SSL 握手失败' },
                     { id: 'gh-proxy', name: 'gh-proxy.com', ok: true,
                       ms: 800, used: true }] };
  let h = settings(st);
  if (!h.includes('连不上 GitHub')) throw new Error('没说失败原因');
  if (!h.includes('data-act="toggleUpdLines"')) throw new Error('没给看线路的入口');
  st.updLines = true;
  h = settings(st);
  if (!h.includes('SSL 握手失败')) throw new Error('展开后没显示每条的结果');
  if (!h.includes('用的这条')) throw new Error('没标出用的哪条');
});

ck('下载中显示进度，不顶着 0% 装死', () => {
  const st = ready(sb);
  st.updTask = { state: 'downloading', got: 50, total: 200, step: 'running',
                 via: 'gh-proxy.com' };
  let h = settings(st);
  if (!h.includes('25%')) throw new Error('没显示百分比');
  // 🔴 挑线路那两秒也得说清楚在干什么
  st.updTask.step = 'probing';
  h = settings(st);
  if (!h.includes('挑最快的线路')) throw new Error('测速阶段顶着「下载 0%」装死了');
});

ck('拿不到校验值要问用户，不硬拦', () => {
  const st = ready(sb);
  st.updTask = { state: 'need_confirm', error: '拿不到 GitHub 给的校验值' };
  const h = settings(st);
  if (!h.includes('data-act="updateAnyway"')) throw new Error('没给「仍然继续」');
  if (!h.includes('拿不到 GitHub 给的校验值')) throw new Error('没说清风险');
});

ck('装完给重启按钮，并说清必须重启', () => {
  const st = ready(sb);
  st.updTask = { state: 'done', files: 12 };
  const h = settings(st);
  if (!h.includes('data-act="restartApp"')) throw new Error('没有重启按钮');
  if (!h.includes('12 个文件')) throw new Error('没说换了几个文件');
  if (!h.includes('必须重启')) throw new Error('没说清要重启才生效');
});

ck('注册指南给出地址、复制入口，并说清用量只算本软件的', () => {
  const st = ready(sb);
  const h = settings(st);
  if (!h.includes('mineru.net/apiManage/token')) throw new Error('没给注册地址');
  if (!h.includes('data-act="copyTokenUrl"')) throw new Error('没有复制入口');
  if (!h.includes('微信')) throw new Error('没说可以微信再注册一个');
  // 🔴 用量是本地记的，只算本软件用掉的 —— 不说清楚用户会当成官方数字
  if (!h.includes('偏小')) throw new Error('没说清用量偏小');
});

console.log('\n待转清单：');

ck('空清单给拖拽提示', () => {
  const st = ready(sb);
  const h = main(st);
  if (!h.includes('把 PDF 拖进来')) throw new Error('没给提示');
});

ck('列出文件、页数、勾选框', () => {
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/讲义.pdf', pages: 12, scan_pages: [] }];
  st.picked['D:/讲义.pdf'] = true;
  const h = main(st);
  if (!h.includes('讲义.pdf')) throw new Error('没列出文件名');
  if (!h.includes('12 页')) throw new Error('没显示页数');
  if (!h.includes('data-check="D:/讲义.pdf"')) throw new Error('没有勾选框');
  if (!h.includes('checked')) throw new Error('默认没勾上');
});

ck('打不开的文件标红并说原因，不给勾选框', () => {
  const st = ready(sb);
  st.items = [{ ok: false, path: 'D:/坏的.pdf', error: '这个 PDF 加了密码' }];
  const h = main(st);
  if (!h.includes('加了密码')) throw new Error('没说原因');
  if (h.includes('data-check="D:/坏的.pdf"')) throw new Error('坏文件不该能勾');
});

ck('超过云端页数上限的要在清单里就说明白', () => {
  const st = ready(sb);
  st.items = [{ ok: false, path: 'D:/大.pdf', pages: 812,
                note: '这份 812 页，超过云端单次 600 页上限' }];
  const h = main(st);
  if (!h.includes('600 页上限')) throw new Error('没说清为什么不能转');
});

ck('扫描页要提示没有文字层', () => {
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/扫描.pdf', pages: 20, scan_pages: [3, 7] }];
  st.picked['D:/扫描.pdf'] = true;
  const h = main(st);
  if (!h.includes('没有文字层')) throw new Error('没提示');
});

ck('一份都没勾就不给开始', () => {
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  st.picked = {};
  const h = main(st);
  const i = h.indexOf('data-act="start"');
  const tag = h.slice(h.lastIndexOf('<button', i), h.indexOf('>', i));
  if (!tag.includes('disabled')) throw new Error('没勾也能点开始');
});

console.log('\n转换中：');

function running(st) {
  st.task = { state: 'running', current: 0, total: 2, now: 'a.pdf',
              lines: ['云端状态：running'], results: [] };
  st.taskId = '1';
  return st;
}

ck('显示第几份 / 共几份', () => {
  const h = main(running(ready(sb)));
  if (!h.includes('正在转第 1 份，共 2 份')) throw new Error('没说进度');
});

ck('把云端那行状态透出来，不装作有百分比', () => {
  const h = main(running(ready(sb)));
  if (!h.includes('云端状态：running')) throw new Error('没透出云端状态');
  if (h.includes('%')) throw new Error('画了百分比 —— 云端根本给不出');
});

ck('停止按钮要说清楚只是不再等，不是真能停', () => {
  const h = main(running(ready(sb)));
  if (!h.includes('data-act="stop"')) throw new Error('没有停止按钮');
  if (!h.includes('停止只是不再等它')) throw new Error('没说清停止的真实含义');
});

ck('转换中也能加文件，但不给改输出目录', () => {
  // 作者 2026-09-08 要的「双队列」：正转着还能往后面加，加进来的排队等。
  // 🔴 但**不给改输出目录** —— 追加的文件跟着原来那一批走，摆个改不动的
  //    按钮比没有更糟。
  const st = running(ready(sb));
  const h = main(st);
  if (!h.includes('data-act="pickFiles"')) throw new Error('转换中不让加文件了');
  if (h.includes('data-act="pickOutDir"')) throw new Error('转换中不该给改输出目录');
});

ck('排队中的文件要画出来，并说还有几份', () => {
  const st = running(ready(sb));
  st.task.queued = ['第二份.pdf', '第三份.pdf'];
  const h = main(st);
  if (!h.includes('第二份.pdf')) throw new Error('排队的没画出来');
  if (!h.includes('排队中')) throw new Error('没标明是排队');
  if (!h.includes('还有 2 份排队')) throw new Error('底栏没说还有几份');
});

ck('转换中选了新文件才给「加进队列」', () => {
  const st = running(ready(sb));
  if (main(st).includes('data-act="appendQueue"')) {
    throw new Error('什么都没选就给了加入队列');
  }
  st.items = [{ ok: true, path: 'D:/new.pdf', pages: 5, scan_pages: [] }];
  st.picked['D:/new.pdf'] = true;
  const h = main(st);
  if (!h.includes('data-act="appendQueue"')) throw new Error('选了却没给加入队列');
  if (!h.includes('把选中的 1 份加进队列')) throw new Error('没说清加几份');
});

console.log('\n转完：');

function done(st, results) {
  st.task = { state: 'done', current: 2, total: results.length,
              now: '', lines: [], results: results };
  st.taskId = '1';
  return st;
}

const OK1 = { ok: true, pdf: 'D:/a.pdf', docx: 'D:/a.docx',
              line: '12 页 ｜ 公式 40 ｜ 表格 2 ｜ 图 5 ｜ 公式是 Word 原生公式',
              pages: 12, formulas: 40, formulas_xsl: 40, scan_pages: [] };
const BAD1 = { ok: false, pdf: 'D:/b.pdf', error: '云端解析失败',
               degraded: '', scan_pages: [] };

ck('转完给每份的结果和打开入口', () => {
  const h = main(done(ready(sb), [OK1]));
  if (!h.includes('公式是 Word 原生公式')) throw new Error('没显示汇总');
  if (!h.includes('data-act="openFile"')) throw new Error('没有打开入口');
  if (!h.includes('data-act="openFolder"')) throw new Error('没有文件夹入口');
});

ck('全都干净时不给「看报告」死按钮', () => {
  const h = main(done(ready(sb), [OK1]));
  if (h.includes('data-act="toggleReport"')) {
    throw new Error('没东西可报还给了报告按钮');
  }
});

ck('有失败时才给「看报告」', () => {
  const h = main(done(ready(sb), [OK1, BAD1]));
  if (!h.includes('data-act="toggleReport"')) throw new Error('该给报告按钮');
});

ck('报告页的返回按钮必须在报告内容【前面】', () => {
  // 🔴 老项目栽过：按钮放在后面，而内容区 min-height:100%，
  //    按钮被挤出屏幕，用户被困在报告页出不来（作者真机报的）。
  const st = done(ready(sb), [OK1, BAD1]);
  st.showReport = true;
  const h = main(st);
  const btn = h.indexOf('data-act="toggleReport"');
  const log = h.indexOf('class="log"');
  if (btn < 0) throw new Error('报告页没有返回按钮');
  if (log < 0) throw new Error('没画报告内容');
  if (btn > log) throw new Error('返回按钮在报告后面，会被挤出屏幕');
});

ck('报告开头要说明「没列出的不代表一定对」', () => {
  const st = done(ready(sb), [OK1, BAD1]);
  st.showReport = true;
  const h = main(st);
  if (!h.includes('不代表一定对')) throw new Error('没有这句免责');
});

ck('失败的那份要显示原因', () => {
  const h = main(done(ready(sb), [BAD1]));
  if (!h.includes('云端解析失败')) throw new Error('没显示失败原因');
});

ck('公式没转全时，报告里要点出来', () => {
  const half = Object.assign({}, OK1, { formulas: 40, formulas_xsl: 37 });
  const st = done(ready(sb), [half]);
  st.showReport = true;
  const h = main(st);
  if (!h.includes('3 个公式没转成')) throw new Error('没点出差额');
});

ck('中途停了要说明白', () => {
  const st = done(ready(sb), [OK1]);
  st.task.state = 'cancelled';
  const h = main(st);
  if (!h.includes('中途停了')) throw new Error('没说明是被停的');
});

console.log('\n历史：');

ck('没历史时给一句话，不是空白', () => {
  const st = ready(sb);
  st.page = 'history';
  const h = hist(st);
  if (!h.includes('还没转过东西')) throw new Error('空白页');
});

ck('历史每行能打开产物和文件夹', () => {
  const st = ready(sb);
  st.page = 'history';
  st.runs = [{ time: '2026-09-08 19:46:47', file: 'a.pdf', pdf: 'D:/a.pdf',
               docx: 'D:/a.docx', ok: true, pages: 12, formulas: '40/40',
               tables: 2, images: 5, error: '' }];
  const h = hist(st);
  if (!h.includes('a.pdf')) throw new Error('没列出来');
  if (!h.includes('公式 40/40')) throw new Error('没显示公式数');
  if (!h.includes('data-act="openFile"')) throw new Error('打不开');
  if (!h.includes('data-act="backMain"')) throw new Error('没有返回');
});

console.log('\n每个按钮都得有人接：');

ck('画出来的 data-act 在 P2W_ACTS 里都能找到', () => {
  // 🔴 老项目有个「重新下载」按钮，handler 在、但一进去就 return，
  //    点了什么都不发生。这里至少保证「按钮画出来了就有人接」。
  const acts = sb.window.P2W_ACTS;
  const states = [];
  let st = ready(sb); states.push(main(st));
  st = ready(sb); st.env.token = { ok: false, masked: '' }; states.push(main(st));
  st = ready(sb); st.tokenEditing = true; states.push(main(st));
  st = ready(sb); st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  st.picked['D:/a.pdf'] = true; states.push(main(st));
  states.push(main(running(ready(sb))));
  states.push(main(done(ready(sb), [OK1, BAD1])));
  st = done(ready(sb), [OK1, BAD1]); st.showReport = true; states.push(main(st));
  st = ready(sb); st.page = 'history'; st.runs = []; states.push(hist(st));

  const miss = new Set();
  for (const h of states) {
    const re = /data-act="([a-zA-Z]+)"/g;
    let m;
    while ((m = re.exec(h))) {
      if (typeof acts[m[1]] !== 'function') miss.add(m[1]);
    }
  }
  if (miss.size) throw new Error('这些按钮没人接：' + [...miss].join(', '));
});

console.log('\nHTTP 层的防线：');

ck('get 必须检查状态码，否则 404 会被当成正常数据', () => {
  // 🔴 老项目就栽在这里：get 不看 r.ok，于是「撞到 404 就停轮询」那段
  //    代码从来没执行过，而台账里已经记成「已修」。
  const src = R('app/renderer/app.js');
  const i = src.indexOf('function httpGet');
  if (i < 0) throw new Error('找不到 httpGet');
  const seg = src.slice(i, i + 400);
  if (!seg.includes('r.ok')) throw new Error('httpGet 没有检查 r.ok');
});

ck('轮询撞到任务不存在时要停下来', () => {
  const src = R('app/renderer/actions.js');
  // 🔴 匹配 `function poll()` 连括号一起，不能只写 `function poll` ——
  //    那是前缀匹配，2026-09-08 加了检查更新的 `function pollUpd()` 之后
  //    它排在前面，被抓错了目标，这条测试当场红给我看。
  const i = src.indexOf('function poll()');
  const seg = src.slice(i, i + 1600);
  if (!seg.includes('stopPolling')) throw new Error('404 时不停轮询');
  if (!seg.includes('404')) throw new Error('没有识别 404');
});

console.log('');
console.log('外壳与前端的接缝：');

ck('不许有弹浏览器的通道', () => {
  // 🔴 2026-09-08 作者定的：**这个软件不弹浏览器。**
  //
  //    原来设置页有个「直接打开」，点了去 mineru 申请 token 的页面，
  //    主进程那边卡着域名白名单。删掉的理由不是安全，是**保证不了**：
  //    能不能弹出浏览器取决于用户机器上的默认程序关联、协议注册、
  //    安全软件拦不拦 —— 一个「点了可能没反应」的按钮比没有更糟。
  //
  //    替代品是「复制地址」，复制到剪贴板让用户自己粘，百分百可控。
  //
  //    这条测试盯着整条链路别被人顺手加回来。真要加回来的话，
  //    **必须连域名白名单一起加**：页面的 HTML 是字符串拼出来的，
  //    有转义漏洞就是钓鱼入口 —— 用户看到是我们的软件弹的浏览器，
  //    戒心最低。
  //
  //    只看代码不看注释：注释里写着「这里曾经有 openUrl」是好事，
  //    那是留给后来人的说明。
  const strip = (src) => src.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  const acts = strip(R('app/renderer/actions.js'));
  const pre = strip(R('app/preload.js'));
  const shell = strip(R('app/main.js'));

  if (acts.includes('openUrl')) throw new Error('actions.js 里又有 openUrl 了');
  if (pre.includes('openUrl')) throw new Error('preload.js 又开了 openUrl 的桥');
  if (shell.includes("'open-url'")) throw new Error('主进程又注册了 open-url');
  if (shell.includes('openExternal')) throw new Error('主进程又能弹浏览器了');
});

ck('复制地址还在（删掉「直接打开」之后它是唯一的出路）', () => {
  const st = ready(sb);
  const h = settings(st);
  if (!h.includes('data-act="copyTokenUrl"')) throw new Error('复制入口也没了');
  if (h.includes('data-act="openTokenPage"')) throw new Error('「直接打开」还在');
  // 地址本身必须画在界面上 —— 复制按钮万一失灵，用户还能照着敲
  if (!h.includes('mineru.net/apiManage/token')) throw new Error('界面上看不到地址');
});


console.log('');
console.log('轮询不该白重绘（治「上下滑动会顿」）：');

// 这一组要真跑轮询循环，不能只扫源码 —— 扫源码只能证明那几行在，
// 证明不了它真的挡住了重绘。
function mkPollSandbox(replies) {
  const sb = mkSandbox();
  const st = ready(sb);
  st.taskId = 'T1';
  let i = 0;
  let drawn = 0;
  // 记账用的假 render：真 render 要 document.getElementById，沙箱里没有
  sb.window.P2W_RENDER = () => { drawn++; };
  sb.window.P2W_HTTP = {
    get: (p) => {
      if (p.indexOf('/api/convert/') === 0) {
        const d = replies[Math.min(i, replies.length - 1)];
        i++;
        return Promise.resolve(JSON.parse(JSON.stringify(d)));
      }
      return Promise.resolve({ rows: [] });
    },
    post: () => Promise.resolve({}),
  };
  // 重新加载 actions.js，让它拿到上面这套假的 render/HTTP
  vm.runInContext(R('app/renderer/actions.js'), sb);
  return { sb, st, count: () => drawn, poll: sb.window.P2W_ACTS.__poll };
}

ck('actions 暴露了 poll 供测试驱动', () => {
  const src = R('app/renderer/actions.js');
  if (src.indexOf('__poll') < 0) {
    throw new Error('poll 没暴露出来，这组测试驱动不了它');
  }
});

ck('连续三轮数据一样，只重绘一次', async () => {
  const same = { state: 'running', current: 0, total: 2, now: 'a.pdf',
                 error: '', elapsed: 5, lines: ['云端状态：running'],
                 results: [] };
  const t = mkPollSandbox([same, same, same]);
  await t.poll(); await t.poll(); await t.poll();
  if (t.count() !== 1) {
    throw new Error('数据没变却重绘了 ' + t.count() + ' 次（该 1 次）');
  }
});

ck('数据一变立刻重绘', async () => {
  const a = { state: 'running', current: 0, total: 2, now: 'a.pdf',
              error: '', lines: ['pending'], results: [] };
  const b = { state: 'running', current: 1, total: 2, now: 'b.pdf',
              error: '', lines: ['running'], results: [{ ok: true }] };
  const t = mkPollSandbox([a, a, b, b]);
  await t.poll(); await t.poll(); await t.poll(); await t.poll();
  if (t.count() !== 2) {
    throw new Error('该重绘 2 次（第一轮 + 变化那轮），实际 ' + t.count());
  }
});

ck('转完那一轮一定重绘，不会被这道判断挡住', async () => {
  const run = { state: 'running', current: 0, total: 1, now: 'a.pdf',
                error: '', lines: [], results: [] };
  const fin = { state: 'done', current: 1, total: 1, now: '',
                error: '', lines: [], results: [{ ok: true }] };
  const t = mkPollSandbox([run, fin]);
  await t.poll();
  const before = t.count();
  await t.poll();
  await new Promise((r) => setImmediate(r));   // 等 /api/runs 那个 then
  if (t.count() <= before) throw new Error('终态没有重绘');
});

Promise.all(queued).then(() => {
  console.log('');
  console.log((fail ? ('前端检查失败 ' + fail + ' 项') : '前端全部通过')
              + '（共 ' + (pass + fail) + ' 条）');
  process.exit(fail ? 1 : 0);
});
