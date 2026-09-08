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
      count: 2, max: 50, daily_pages: 1000,
      list: [{ masked: 'sk-demo1...EXAMPLE9', used: 340 },
             { masked: 'sk-demo2...EXAMPLE8', used: 12 }],
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
  if (!h.includes('2 个 token')) throw new Error('没显示 token 个数');
  // 340 + 12，几个号的用量要加总 —— 用户关心的是「今天一共用了多少」
  if (!h.includes('今天已用 352 页')) throw new Error('没显示今日总用量');
  if (h.includes('EPUTTaAx')) throw new Error('把 token 原文画出来了');
});

console.log('');
console.log('设置页：');

ck('有几个 token 就画几行', () => {
  const st = ready(sb);
  const h = settings(st);
  if (!h.includes('sk-demo1...EXAMPLE9')) throw new Error('第 1 个没画');
  if (!h.includes('sk-demo2...EXAMPLE8')) throw new Error('第 2 个没画');
  if (!h.includes('token（2 个）')) throw new Error('没说清一共几个');
});

ck('每一行都能换、能删', () => {
  const st = ready(sb);
  const h = settings(st);
  if (!h.includes('data-act="editSlot" data-arg="0"')) throw new Error('第 1 行不能换');
  if (!h.includes('data-act="clearSlot" data-arg="1"')) throw new Error('第 2 行不能删');
  // 用量要分行显示 —— 挑号是按「今天谁用得少」，看不见就无从判断
  if (!h.includes('今天用了 340 页')) throw new Error('没显示这一行的用量');
});

ck('「+ 添加」点了才出输入框，不占位', () => {
  const st = ready(sb);
  let h = settings(st);
  if (!h.includes('data-act="addSlot"')) throw new Error('没有「+ 添加」');
  if (h.includes('id="tokenbox"')) throw new Error('没点就冒出输入框了');
  st.editSlot = 'new';
  h = settings(st);
  if (!h.includes('id="tokenbox"')) throw new Error('点了却没有输入框');
  if (!h.includes('新的')) throw new Error('没标明这是新加的一行');
  // 正在添的时候不该还能再点「+ 添加」
  const i = h.indexOf('data-act="addSlot"');
  const tag = h.slice(h.lastIndexOf('<button', i), h.indexOf('>', i));
  if (!tag.includes('disabled')) throw new Error('添加中还能再点添加');
});

ck('一个都没有时给条明路', () => {
  const st = ready(sb);
  st.env.tokens = { count: 0, max: 50, list: [] };
  const h = settings(st);
  if (!h.includes('+ 添加')) throw new Error('没给添加入口');
  if (!h.includes('一个都还没有')) throw new Error('空着却不说话');
});

ck('到上限就不给「+ 添加」，并说明原因', () => {
  const st = ready(sb);
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ masked: 'sk-x...' + i, used: 0 });
  st.env.tokens = { count: 50, max: 50, list: many };
  const h = settings(st);
  if (h.includes('data-act="addSlot"')) throw new Error('到上限还给添加');
  if (!h.includes('已经 50 个了')) throw new Error('没说为什么不给加');
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
  if (!h.includes('第 2 个')) throw new Error('没标明在改第几个');
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

const OK1 = { ok: true, pdf: 'D:/a.pdf', docx: 'D:/a.docx',
              line: '12 页 ｜ 公式 40 ｜ 表格 2 ｜ 图 5 ｜ 公式是 Word 原生公式',
              pages: 12, formulas: 40, formulas_xsl: 40, scan_pages: [] };
const BAD1 = { ok: false, pdf: 'D:/b.pdf', error: '云端解析失败',
               degraded: '', scan_pages: [] };

// 🔴 转换中的列表是**从 st.items 画出来的**（结果按路径贴到对应行上），
//    所以这两个辅助必须把 items 和 picked 一起造出来 —— 只设 st.task
//    的话表是空的。这正是重构前后的关键差别。
function running(st, files) {
  files = files || ['D:/a.pdf', 'D:/b.pdf'];
  st.items = files.map((p) => ({ ok: true, path: p, pages: 12, scan_pages: [] }));
  st.items.forEach((x) => { st.picked[x.path] = true; });
  st.task = { state: 'running', current: 0, total: files.length, now: 'a.pdf',
              lines: ['云端状态：running'], results: [] };
  st.taskId = '1';
  return st;
}

ck('显示第几份 / 共几份', () => {
  const h = main(running(ready(sb)));
  if (!h.includes('正在转第 1 / 2 份')) throw new Error('没说进度');
});

ck('把云端那行状态透出来，不装作有百分比', () => {
  const h = main(running(ready(sb)));
  if (!h.includes('云端状态：running')) throw new Error('没透出云端状态');
  if (h.includes('%')) throw new Error('画了百分比 —— 云端根本给不出');
});

ck('停止按钮要说清楚只是不再等，不是真能停', () => {
  const h = main(running(ready(sb)));
  if (!h.includes('data-act="stop"')) throw new Error('没有停止按钮');
  if (!h.includes('不再等')) throw new Error('没说清停止的真实含义');
});

ck('一张表：转过的、正在转的、还没轮到的都在同一张表里', () => {
  // 🔴 这条钉住整个重构。原来是「已完成 + 正在转 + 排队中 + 刚拖进来」
  //    四段拼接 —— 会跳屏，还出过「4 个文件下面又冒出一模一样 4 个」。
  //    现在从 st.items 出发，一行一份，结果按路径贴上去。
  const st = running(ready(sb), ['D:/a.pdf', 'D:/b.pdf', 'D:/c.pdf']);
  st.task.current = 1;
  st.task.results = [{ ok: true, pdf: 'D:/a.pdf', docx: 'D:/a.docx', line: '' }];
  const h = main(st);
  if (!h.includes('a.docx')) throw new Error('转好的那份没显示产物名');
  if (!h.includes('b.pdf')) throw new Error('正在转的那份没显示');
  if (!h.includes('c.pdf')) throw new Error('还没轮到的那份没显示');
  if (!h.includes('等着')) throw new Error('没标明哪些还没轮到');
  // 每份只占一行 —— 数 class="it" 的个数，不数文件名出现次数
  // （title 属性里也有路径，那不算重复）
  // 主表的行都带 title=路径；待办区那几行没有，正好排除掉
  const rows = (h.match(/<div class="it[^>]*title="D:/g) || []).length;
  if (rows !== 3) throw new Error('主表该 3 行，实际 ' + rows + ' 行');
});

ck('点开始之后待转清单要留着，那张表靠它画', () => {
  // 🔴 跟 2026-09-08 那次相反：当时为了修「下面又列一遍」把 items 清了，
  //    那是打在症状上的补丁。换成一张表之后，清了反而没东西可画。
  const sb2 = mkSandbox();
  const st = ready(sb2);
  st.items = [1, 2, 3, 4].map((i) => ({
    ok: true, path: 'D:/' + i + '.pdf', pages: 1, scan_pages: [],
  }));
  st.items.forEach((x) => { st.picked[x.path] = true; });
  sb2.window.P2W_RENDER = () => {};
  sb2.window.P2W_HTTP = {
    get: () => Promise.resolve({ rows: [] }),
    post: () => Promise.resolve({ task_id: 'T1', total: 4 }),
  };
  vm.runInContext(R('app/renderer/actions.js'), sb2);
  sb2.window.P2W_ACTS.start();
  return new Promise((r) => setImmediate(r)).then(() => {
    if (st.items.length !== 4) {
      throw new Error('待转清单被清了，转换中的表就画不出来了');
    }
  });
});

console.log('');
console.log('待办（转换中还能继续加）：');

ck('没有待办时也把这条路说出来', () => {
  const h = main(running(ready(sb)));
  if (!h.includes('转换中也可以把 PDF 拖进来')) {
    throw new Error('不说的话没人知道转着还能加');
  }
  if (!h.includes('data-act="pickMore"')) throw new Error('没有「再加几份」');
});

ck('有待办时说清几份、能单独移除', () => {
  const st = running(ready(sb));
  st.pending = [{ ok: true, path: 'D:/new1.pdf', pages: 7, scan_pages: [] },
                { ok: true, path: 'D:/new2.pdf', pages: 3, scan_pages: [] }];
  const h = main(st);
  if (!h.includes('待办 2 份，这批转完自动接上')) throw new Error('没说清待办情况');
  if (!h.includes('new1.pdf')) throw new Error('待办的文件名没显示');
  if (!h.includes('7 页')) throw new Error('没显示页数');
  if (!h.includes('data-act="delPending" data-arg="D:/new1.pdf"')) {
    throw new Error('待办不能单独移除');
  }
});

ck('待办不混进主表', () => {
  // 🔴 混了就得在一张表里区分「这批的」和「下批的」，
  //    那正是重构前那个 bug 的土壤。
  const st = running(ready(sb), ['D:/a.pdf']);
  st.pending = [{ ok: true, path: 'D:/new1.pdf', pages: 7, scan_pages: [] }];
  const h = main(st);
  const iMain = h.indexOf('a.pdf');
  const iPend = h.indexOf('new1.pdf');
  if (iPend < iMain) throw new Error('待办跑到主表前面去了');
  if (!h.includes('待办')) throw new Error('待办没有自己的标题');
});

ck('正在体检待办时要说话', () => {
  const st = running(ready(sb));
  st.pendingBusy = true;
  const h = main(st);
  if (!h.includes('正在看这几份')) throw new Error('体检期间一声不吭');
});

ck('转完之后待办区只剩「上一批的报告」', () => {
  const st = done(ready(sb), [OK1]);
  st.pending = [];
  st.lastResults = [BAD1];
  const h = main(st);
  if (!h.includes('data-act="toggleLastReport"')) throw new Error('看不了上一批的报告');
  if (h.includes('data-act="pickMore"')) {
    throw new Error('结果页还给「再加几份」—— 顶上已经有「再转一批」了');
  }
});

ck('上一批全都干净就不给报告按钮', () => {
  const st = done(ready(sb), [OK1]);
  st.lastResults = [OK1];          // 全成功、没扫描页、公式全转成
  const h = main(st);
  if (h.includes('data-act="toggleLastReport"')) {
    throw new Error('没什么可报的却摆了个按钮');
  }
});

console.log('\n转完：');

function done(st, results) {
  st.items = results.map((r) => ({
    ok: true, path: r.pdf, pages: r.pages || 1, scan_pages: [],
  }));
  st.items.forEach((x) => { st.picked[x.path] = true; });
  st.task = { state: 'done', current: results.length, total: results.length,
              now: '', lines: [], results: results };
  st.taskId = '1';
  return st;
}


ck('转完给每份的结果和打开入口', () => {
  const h = main(done(ready(sb), [OK1]));
  if (!h.includes('公式是 Word 原生公式')) throw new Error('没显示汇总');
  if (!h.includes('data-act="openFile"')) throw new Error('没有打开入口');
  if (!h.includes('data-act="openFolder"')) throw new Error('没有文件夹入口');
  if (!h.includes('1 成 / 1 份')) throw new Error('没给这一批的总账');
});

ck('用了缓存的那份要标出来', () => {
  // 🔴 秒回的得说清楚为什么，不标的话用户会以为根本没转。
  const st = done(ready(sb), [Object.assign({}, OK1, { cached: true })]);
  const h = main(st);
  if (!h.includes('缓存')) throw new Error('没标出这份是缓存命中的');
  if (!h.includes('没扣额度')) throw new Error('没说清缓存意味着什么');
});

ck('公式没转全的写进悬停说明', () => {
  const st = done(ready(sb), [Object.assign({}, OK1, {
    math_note: '第 3、7 个公式没转成，保留了 LaTeX 原文',
  })]);
  const h = main(st);
  if (!h.includes('第 3、7 个公式没转成')) throw new Error('math_note 又白写了');
});

ck('失败的那份要显示原因', () => {
  const h = main(done(ready(sb), [BAD1]));
  if (!h.includes('云端解析失败')) throw new Error('没显示失败原因');
});

ck('有次品就给「打开次品」', () => {
  // 次品是花了额度换来的：正文表格图片都在，只是公式没转全。
  const st = done(ready(sb), [Object.assign({}, BAD1, {
    degraded: 'D:/b【公式未完全转换】.docx',
  })]);
  const h = main(st);
  if (!h.includes('打开次品')) throw new Error('次品拿不到');
});

ck('有失败时才给「看报告」', () => {
  if (!main(done(ready(sb), [OK1, BAD1])).includes('data-act="toggleReport"')) {
    throw new Error('有失败却不给报告');
  }
  if (main(done(ready(sb), [OK1])).includes('data-act="toggleReport"')) {
    throw new Error('全都干净还给报告 —— 没什么可报的');
  }
});

ck('中途停了要说明白', () => {
  const st = done(ready(sb), [OK1]);
  st.task.state = 'cancelled';
  const h = main(st);
  if (!h.includes('已停止')) throw new Error('没说明是被停的');
});

ck('报告页的返回按钮在报告前面', () => {
  // 🔴 内容区是 .fill（min-height:100%），拼在它后面的东西会被顶到
  //    第一屏之外 —— 620x440 的窗口里等于不存在。同一个坑栽过三次。
  const st = done(ready(sb), [OK1, BAD1]);
  st.showReport = true;
  const h = main(st);
  const iBtn = h.indexOf('data-act="toggleReport"');
  const iLog = h.indexOf('class="log"');
  if (iBtn < 0 || iLog < 0) throw new Error('报告页少东西');
  if (iBtn > iLog) throw new Error('返回按钮在报告后面，会被挤出屏幕');
});

console.log('');
console.log('待办晋升（转完自动接上）：');

// 驱动 actions 的沙箱：假的 render / HTTP，记下都请求了什么。
function mkActs(setup) {
  const sb2 = mkSandbox();
  const st = ready(sb2);
  const asked = [];
  const posted = [];
  sb2.window.P2W_RENDER = () => {};
  sb2.window.P2W_HTTP = {
    get: (p) => {
      asked.push(p);
      if (p.indexOf('/api/convert/') === 0) {
        return Promise.resolve(st.__pollReply || { state: 'running' });
      }
      if (p === '/api/env') return Promise.resolve(st.env);
      return Promise.resolve({ rows: [] });
    },
    post: (p, body) => {
      posted.push([p, body]);
      if (p === '/api/scan') {
        return Promise.resolve({ items: (body.paths || []).map((x) => ({
          ok: true, path: x, pages: 5, scan_pages: [],
        })) });
      }
      return Promise.resolve({ task_id: 'T2', total: (body.paths || []).length });
    },
  };
  if (setup) setup(st);
  vm.runInContext(R('app/renderer/actions.js'), sb2);
  return { sb: sb2, st, asked, posted, acts: sb2.window.P2W_ACTS };
}

const tick = () => new Promise((r) => setImmediate(r));

ck('转换中拖进来的进待办，不打断这一批', async () => {
  const t = mkActs((st) => {
    st.task = { state: 'running', current: 0, total: 1, results: [] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
  });
  t.acts.addPaths(['D:/new.pdf']);
  await tick(); await tick();
  if (t.st.pending.length !== 1) throw new Error('没进待办');
  if (t.st.items.length !== 1) throw new Error('混进主列表了');
  if (t.posted.some((x) => x[0] === '/api/convert')) {
    throw new Error('打断了这一批，起了新任务');
  }
});

ck('待办去重要比两样：待办里的、正在转的', async () => {
  // 🔴 用户很可能把已经在转的某份又拖一次 —— 那份转出来会覆盖同一个
  //    .docx，白花一次额度。
  const t = mkActs((st) => {
    st.task = { state: 'running', current: 0, total: 1, results: [] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
    st.pending = [{ ok: true, path: 'D:/b.pdf', pages: 4, scan_pages: [] }];
  });
  t.acts.addPaths(['D:/a.pdf', 'D:/b.pdf', 'D:/c.pdf']);
  await tick(); await tick();
  const paths = t.st.pending.map((x) => x.path);
  if (paths.length !== 2) throw new Error('该只多出 c.pdf，实际 ' + paths.join(','));
  if (paths.indexOf('D:/c.pdf') < 0) throw new Error('新的那份没进去');
});

ck('这批转完，待办自动晋升成新一批', async () => {
  const t = mkActs((st) => {
    st.task = { state: 'running', current: 1, total: 1, results: [{ ok: true, pdf: 'D:/a.pdf' }] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
    st.pending = [{ ok: true, path: 'D:/new.pdf', pages: 5, scan_pages: [] }];
    st.__pollReply = { state: 'done', current: 1, total: 1,
                       results: [{ ok: true, pdf: 'D:/a.pdf' }], lines: [] };
  });
  t.acts.__poll();
  await tick(); await tick(); await tick();
  if (t.st.pending.length !== 0) throw new Error('待办没清空');
  if (t.st.items.length !== 1 || t.st.items[0].path !== 'D:/new.pdf') {
    throw new Error('待办没变成新一批');
  }
  if (!t.posted.some((x) => x[0] === '/api/convert')) {
    throw new Error('没起新任务');
  }
  // 上一批的结果要留着 —— 报告靠它
  if (!t.st.lastResults || !t.st.lastResults.length) {
    throw new Error('上一批的结果丢了，报告就看不了了');
  }
});

ck('中途停了不自动起新一批，待办并回待转清单', async () => {
  // 🔴 用户按了停止，不该反手又给他起一批。
  const t = mkActs((st) => {
    st.task = { state: 'running', current: 0, total: 1, results: [] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
    st.pending = [{ ok: true, path: 'D:/new.pdf', pages: 5, scan_pages: [] }];
    st.__pollReply = { state: 'cancelled', current: 0, total: 1,
                       results: [], lines: [] };
  });
  t.acts.__poll();
  await tick(); await tick(); await tick();
  if (t.posted.some((x) => x[0] === '/api/convert')) {
    throw new Error('停了还自动起新一批');
  }
  if (t.st.pending.length !== 0) throw new Error('待办没并回去');
  if (!t.st.items.some((x) => x.path === 'D:/new.pdf')) {
    throw new Error('待办没并进待转清单，那几份就没人管了');
  }
});

ck('体检回来时这批已经转完了，也要自己补一次晋升', async () => {
  // 🔴 扫一个文件夹要十几秒。等它回来时轮询可能早就拿到 done 了，
  //    而那一刻 pending 还是空的，轮询走的是「没有待办」那条路。
  //    不自己补判断的话，这几份会一直躺着没人管。
  const t = mkActs((st) => {
    st.task = { state: 'done', current: 1, total: 1,
                results: [{ ok: true, pdf: 'D:/a.pdf' }] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
  });
  t.acts.addPaths(['D:/late.pdf']);
  await tick(); await tick(); await tick();
  if (!t.posted.some((x) => x[0] === '/api/convert')) {
    throw new Error('体检回来发现已转完，却没有补晋升 —— 那几份会一直躺着');
  }
  if (t.st.items[0].path !== 'D:/late.pdf') throw new Error('没晋升成新一批');
});

ck('体检不过的不进待办', () => {
  // 它在主队列里同样会当场失败，提前挡掉比让用户等到晋升之后才看见
  // 一个红叉好。
  const src = R('app/renderer/actions.js');
  const i = src.indexOf('function addPending');
  const seg = src.slice(i, i + 1400);
  if (!/if \(x\.ok && !seen\[x\.path\]\)/.test(seg)) {
    throw new Error('addPending 没有挡住体检不过的');
  }
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

ck('转完要把用量也刷一遍，不只刷历史', async () => {
  // 🔴 账是**后端在提交那一刻就记好了**的（convert.py 的 note_pages），
  //    但界面上「今天用了 X 页」那个数字来自 /api/env。转完不重新拉
  //    一次的话，底栏还显示转之前的数，得进一趟设置页才更新 ——
  //    账准、显示滞后，这种落差最容易让人以为没记上。
  const sb = mkSandbox();
  const st = ready(sb);
  st.taskId = 'T1';
  const asked = [];
  sb.window.P2W_RENDER = () => {};
  sb.window.P2W_HTTP = {
    get: (p) => {
      asked.push(p);
      if (p.indexOf('/api/convert/') === 0) {
        return Promise.resolve({ state: 'done', current: 1, total: 1,
                                 now: '', error: '', lines: [], queued: [],
                                 results: [] });
      }
      if (p === '/api/env') return Promise.resolve(st.env);
      return Promise.resolve({ rows: [] });
    },
    post: () => Promise.resolve({}),
  };
  vm.runInContext(R('app/renderer/actions.js'), sb);

  sb.window.P2W_ACTS.__poll();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  if (asked.indexOf('/api/runs') < 0) throw new Error('没刷新历史');
  if (asked.indexOf('/api/env') < 0) throw new Error('没刷新用量');
});

ck('actions 暴露了 poll 供测试驱动', () => {
  const src = R('app/renderer/actions.js');
  if (src.indexOf('__poll') < 0) {
    throw new Error('poll 没暴露出来，这组测试驱动不了它');
  }
});

// 🔴 下面这条原来三轮的 elapsed 都写死 5 —— 而真实的 poll 每秒 +1。
//    构造得不真实，于是「数据没变就不重绘」从来没生效过，
//    这条测试却一直绿着（2026-09-08 作者真机报「任务一多滑动就卡」
//    才查出来）。现在按真实情况构造。
function pollRow(sec, extra) {
  return Object.assign({ state: 'running', current: 0, total: 2,
                         now: 'a.pdf', error: '', elapsed: sec,
                         lines: ['云端状态：running'], queued: [],
                         results: [] }, extra || {});
}

ck('只有已用时在变也不重绘（界面根本不显示它）', async () => {
  const t = mkPollSandbox([pollRow(5), pollRow(6), pollRow(7)]);
  await t.poll(); await t.poll(); await t.poll();
  if (t.count() !== 1) {
    throw new Error('只有 elapsed 在变却重绘了 ' + t.count() + ' 次（该 1 次）');
  }
});

ck('连续三轮数据一样，只重绘一次', async () => {
  const same = pollRow(5);
  const t = mkPollSandbox([same, same, same]);
  await t.poll(); await t.poll(); await t.poll();
  if (t.count() !== 1) {
    throw new Error('数据没变却重绘了 ' + t.count() + ' 次（该 1 次）');
  }
});

ck('排除表必须是反向排除，不能改成正向白名单', () => {
  // 🔴 护栏。正着列举「哪些字段进签名」的话，漏一个就是「界面该变
  //    没变」——那是 bug，比多重绘一次严重得多。这条盯着实现方向。
  const src = R('app/renderer/actions.js')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  if (!src.includes('SIG_SKIP')) throw new Error('排除表没了');
  if (!/for \(var k in d\)/.test(src)) {
    throw new Error('不再是「遍历全部、剔掉少数」的形状了');
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
