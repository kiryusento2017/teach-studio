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
const upd = sb.window.P2W_PAGES.update;

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

ck('设置页给更新入口和当前版本，正文在独立一屏', () => {
  // 🔴 更新的每个分支都要用户拿主意（装不装、验不过还装不装、失败怎么办），
  //    一行字加一个小按钮撑不起这件事 —— 正文搬到独立整屏，设置页只留入口。
  const st = ready(sb);
  st.env.version = 'v0.1.0';
  const h = settings(st);
  if (!h.includes('data-act="openUpdate"')) throw new Error('没有更新入口');
  if (!h.includes('v0.1.0')) throw new Error('没显示当前版本');
});

ck('更新页没查过时给「检查更新」和当前版本', () => {
  const st = ready(sb);
  st.env.version = 'v0.1.0';
  const h = upd(st);
  if (!h.includes('data-act="checkUpdate"')) throw new Error('没有检查更新');
  if (!h.includes('v0.1.0')) throw new Error('没显示当前版本');
  if (!h.includes('font-size:14px;font-weight:600')) {
    throw new Error('没有大标题，又压回一行去了');
  }
});

ck('设置页有新版本时把它标出来', () => {
  const st = ready(sb);
  st.upd = { has_update: true, latest: 'v0.2.0', lines: [] };
  const h = settings(st);
  if (!h.includes('有新版本 v0.2.0')) throw new Error('设置页没提示有新版本');
});

ck('查到新版本给版本号和「立即更新」', () => {
  const st = ready(sb);
  st.upd = { has_update: true, latest: 'v0.2.0', published: '2026-09-09T00:00:00Z',
             notes_brief: '修了两个问题', lines: [] };
  const h = upd(st);
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
  let h = upd(st);
  if (!h.includes('连不上 GitHub')) throw new Error('没说失败原因');
  if (!h.includes('data-act="toggleUpdLines"')) throw new Error('没给看线路的入口');
  st.updLines = true;
  h = upd(st);
  if (!h.includes('SSL 握手失败')) throw new Error('展开后没显示每条的结果');
  if (!h.includes('用的这条')) throw new Error('没标出用的哪条');
});

ck('下载中显示进度，不顶着 0% 装死', () => {
  const st = ready(sb);
  st.updTask = { state: 'downloading', got: 50, total: 200, step: 'running',
                 via: 'gh-proxy.com' };
  let h = upd(st);
  if (!h.includes('25%')) throw new Error('没显示百分比');
  // 云端后端给了 got/total，就该画进度条，不能只写个数字
  if (!h.includes('class="bar"')) throw new Error('没有进度条');
  if (!h.includes('已下 ')) throw new Error('没显示下了多少');
  // 🔴 挑线路那两秒也得说清楚在干什么
  st.updTask.step = 'probing';
  h = upd(st);
  if (!h.includes('挑最快的线路')) throw new Error('测速阶段顶着「下载 0%」装死了');
});

ck('拿不到校验值要问用户，不硬拦', () => {
  const st = ready(sb);
  st.updTask = { state: 'need_confirm', error: '拿不到 GitHub 给的校验值' };
  const h = upd(st);
  if (!h.includes('data-act="updateAnyway"')) throw new Error('没给「仍然继续」');
  if (!h.includes('拿不到 GitHub 给的校验值')) throw new Error('没说清风险');
});

ck('装完给重启按钮，并说清必须重启', () => {
  const st = ready(sb);
  st.updTask = { state: 'done', files: 12 };
  const h = upd(st);
  if (!h.includes('data-act="restartApp"')) throw new Error('没有重启按钮');
  if (!h.includes('12 个文件')) throw new Error('没说换了几个文件');
  if (!h.includes('必须重启')) throw new Error('没说清要重启才生效');
});

ck('跨大版本要重下整包时必须给出路', () => {
  // 🔴 原先这一支只有一行红字，用户被告知「不行」却不知道该干什么。
  //    云端不弹浏览器，所以出路是把下载页地址复制给他。
  const st = ready(sb);
  // ⚠️ ready() 返回的是同一个 state 对象，updTask 会从上一条测试残留下来 ——
  //    不清掉的话「装完等重启」那一支排在前面，这里根本走不到。
  st.updTask = null;
  st.upd = { has_update: false, need_full: true,
             error: '跨了大版本，增量包装不上', lines: [] };
  const h = upd(st);
  if (!h.includes('跨了大版本')) throw new Error('没说为什么');
  if (!h.includes('data-act="copyReleaseUrl"')) throw new Error('没给复制地址的出路');
  if (!h.includes('github.com/kiryusento2017/teach-studio/releases')) {
    throw new Error('没把地址摆出来给人看');
  }
  if (!h.includes('token 和转换历史都在里面')) {
    throw new Error('没说清重装会不会丢东西 —— 这是用户最担心的');
  }
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

ck('待转清单要有表头和全选/全不选', () => {
  // 一批几十份的时候，没有全选就只能一个个点。
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] },
              { ok: true, path: 'D:/b.pdf', pages: 5, scan_pages: [] }];
  const h = main(st);
  if (!h.includes('class="hd"')) throw new Error('没有表头行');
  if (!h.includes('文件（共 2 份）')) throw new Error('表头没报总份数');
  if (!h.includes('data-act="selAll"')) throw new Error('没有全选');
  if (!h.includes('data-act="selNone"')) throw new Error('没有全不选');
  if (!h.includes('>页数<')) throw new Error('表头没有页数列头');
});

ck('页数要对齐成一列', () => {
  // 不给固定宽度的话页数跟着文件名长度飘，几行下来根本对不齐。
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  const h = main(st);
  if (!h.includes('width:52px;text-align:right')) {
    throw new Error('页数没有固定列宽右对齐');
  }
});

ck('没勾的那行文件名要变淡', () => {
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  st.picked = { 'D:/a.pdf': false };
  const h = main(st);
  if (!h.includes('grow ell f-dim')) throw new Error('没勾的没调淡，看不出选没选');
});

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
  if (!h.includes('<input type="checkbox"')) throw new Error('没有勾选框');
  // 点整行都要能勾 —— checkbox 只是显示件（pointer-events:none），
  // 真正接事件的是行上的 data-act="toggle"
  if (!h.includes('data-act="toggle" data-arg="D:/讲义.pdf"')) {
    throw new Error('整行点不了，只能点那 13px 的小方块');
  }
  if (!h.includes('pointer-events:none')) {
    throw new Error('checkbox 没让开点击，会把行的点击吃掉');
  }
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

ck('拖进来默认全勾，直接就能开始', () => {
  // 🔴 picked 是三态：**键不存在 = 选中**。所以 `picked = {}` 是「全勾」
  //    而不是「全没勾」—— 用户拖一批进来直接点开始，不用先勾一遍。
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  st.picked = {};
  const h = main(st);
  if (!h.includes(' checked')) throw new Error('默认没勾上');
  const i0 = h.indexOf('data-act="start"');
  const tag0 = h.slice(h.lastIndexOf('<button', i0), h.indexOf('>', i0));
  if (tag0.includes('disabled')) throw new Error('默认全勾了却不让开始');
  if (!h.includes('选中 1 份')) throw new Error('底栏没算上默认勾的那份');
});

ck('一份都没勾就不给开始', () => {
  const st = ready(sb);
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  // 三态下「没勾」必须显式写 false，不能用空对象表示
  st.picked = { 'D:/a.pdf': false };
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


ck('报告每份都列，成功的也给统计和落盘路径', () => {
  // 🔴 只列有问题的那几份看着清爽，但「没列出来」既可能是干净、也可能是
  //    被漏了，两种情况长得一样 —— 用户没法拿它核对 Word。
  const st = ready(sb);
  st.task = { state: 'done', current: 2, total: 2, now: '', lines: [],
              results: [
                { ok: true, pdf: 'D:/a.pdf', docx: 'D:/a.docx', pages: 12,
                  formulas: 8, formulas_xsl: 8, tables: 2, images: 3,
                  scan_pages: [], details_dropped: 0 },
                { ok: false, pdf: 'D:/b.pdf', error: '崩了' }] };
  st.taskId = '1';
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 12, scan_pages: [] },
              { ok: true, path: 'D:/b.pdf', pages: 4, scan_pages: [] }];
  st.showReport = true;
  const h = main(st);
  if (!h.includes('转换报告')) throw new Error('报告没有标题');
  if (!h.includes('a.pdf')) throw new Error('成功那份没列出来');
  if (!h.includes('12 页 · 公式 8/8 · 表 2 · 图 3')) {
    throw new Error('成功那份没给统计行');
  }
  if (!h.includes('存到：D:/a.docx')) throw new Error('没给落盘路径');
  if (!h.includes('✗ 失败')) throw new Error('失败那份没标记');
  if (!h.includes('data-act="copyReport"')) throw new Error('没有复制按钮');
  if (!h.includes('不会存成文件')) throw new Error('没说报告不落盘');
});

ck('扫描页多的时候只列前 12 个', () => {
  const many = [];
  for (let i = 1; i <= 40; i++) many.push(i);
  const st = ready(sb);
  st.task = { state: 'done', current: 1, total: 1, now: '', lines: [],
              results: [{ ok: true, pdf: 'D:/s.pdf', docx: 'D:/s.docx',
                          pages: 40, formulas: 0, formulas_xsl: 0, tables: 0,
                          images: 0, scan_pages: many }] };
  st.taskId = '1';
  st.items = [{ ok: true, path: 'D:/s.pdf', pages: 40, scan_pages: [] }];
  st.showReport = true;
  const h = main(st);
  if (!h.includes('等 40 页')) throw new Error('没说一共多少页');
  if (h.includes('、13、')) throw new Error('页号没截断，整份扫描件会刷屏');
  if (!h.includes('这几页最该核对')) throw new Error('没说为什么要看');
});

ck('转换中能摊开日志，转完也还能看', () => {
  // 后端每轮都返回 lines，原先只取最后一行显示 —— 攒了一路的东西没给人看
  const st = ready(sb);
  st.task = { state: 'running', current: 0, total: 1, now: '解析中',
              lines: ['已提交，排队中', '正在解析第 3 页'], results: [] };
  st.taskId = '1';
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  let h = main(st);
  if (!h.includes('data-act="toggleLog"')) throw new Error('没有日志入口');

  st.showLog = true;
  h = main(st);
  if (!h.includes('正在解析第 3 页')) throw new Error('日志没摊开');
  if (!h.includes('class="log"')) throw new Error('没走日志那套深底样式');

  // 转完也要留着 —— 转失败时最想看的就是它
  st.task.state = 'done';
  st.showLog = false;
  h = main(st);
  if (!h.includes('data-act="toggleLog"')) throw new Error('转完就把日志入口收走了');
});

ck('日志和报告互斥，不许同时开', () => {
  const t = mkActs((st) => {
    st.task = { state: 'done', current: 1, total: 1,
                results: [{ ok: true, pdf: 'D:/a.pdf' }] };
    st.showReport = true;
  });
  t.acts.toggleLog();
  if (!t.st.showLog) throw new Error('日志没开');
  if (t.st.showReport) throw new Error('报告没关，两块会互相盖掉');
  t.acts.toggleReport();
  if (t.st.showLog) throw new Error('反过来也要互斥');
});

ck('「停止」在底栏不在顶栏', () => {
  // 同一个动作两个软件放两处，是搬漏了不是设计
  const st = ready(sb);
  st.task = { state: 'running', current: 0, total: 2, now: '', lines: [],
              results: [] };
  st.taskId = '1';
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] },
              { ok: true, path: 'D:/b.pdf', pages: 4, scan_pages: [] }];
  const h = main(st);
  const i = h.indexOf('data-act="stop"');
  if (i < 0) throw new Error('没有停止按钮');
  if (i < h.indexOf('chrome-bot')) throw new Error('停止按钮跑到顶栏去了');
});

ck('有失败的时候要单独说、而且是红的', () => {
  const st = ready(sb);
  st.task = { state: 'done', current: 2, total: 2, now: '', lines: [],
              results: [{ ok: true, pdf: 'D:/a.pdf', docx: 'D:/a.docx' },
                        { ok: false, pdf: 'D:/b.pdf', error: '崩了' }] };
  st.taskId = '1';
  st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] },
              { ok: true, path: 'D:/b.pdf', pages: 4, scan_pages: [] }];
  const h = main(st);
  if (!h.includes('成功 1 份')) throw new Error('没说成功几份');
  if (!h.includes('f-bad">失败 1 份')) throw new Error('失败份数没标红');
});

ck('转完给每份的结果和打开入口', () => {
  const h = main(done(ready(sb), [OK1]));
  if (!h.includes('公式是 Word 原生公式')) throw new Error('没显示汇总');
  if (!h.includes('data-act="openFile"')) throw new Error('没有打开入口');
  if (!h.includes('data-act="openFolder"')) throw new Error('没有文件夹入口');
  if (!h.includes('全部完成 1 份')) throw new Error('没给这一批的总账');
  // 统计在底栏，不在顶栏 —— 顶栏只放「在干什么」和动作
  if (h.indexOf('全部完成 1 份') < h.indexOf('chrome-bot')) {
    throw new Error('统计跑到顶栏去了');
  }
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
  //
  //    ⚠️ 时序必须照真实的来：**拖进来的那一刻还在转**（所以走待办），
  //    体检回来时才发现已经 done。写成「一开始就 done」是另一个场景了
  //    （那是「转完之后再拖一份」，见下一条），两者判据不同，别混。
  const t = mkActs((st) => {
    st.task = { state: 'running', current: 0, total: 1, results: [] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
  });
  t.acts.addPaths(['D:/late.pdf']);
  // 体检请求已经发出去了，回调还没跑 —— 这中间这一批转完了
  t.st.task = { state: 'done', current: 1, total: 1,
                results: [{ ok: true, pdf: 'D:/a.pdf' }] };
  await tick(); await tick(); await tick();
  if (!t.posted.some((x) => x[0] === '/api/convert')) {
    throw new Error('体检回来发现已转完，却没有补晋升 —— 那几份会一直躺着');
  }
  if (t.st.items[0].path !== 'D:/late.pdf') throw new Error('没晋升成新一批');
});

ck('转完之后再拖一份进来，不许自动开转', async () => {
  // 🔴 **这条锁的是花钱的那道口子。** 判「忙不忙」如果用 st.task 真值，
  //    转完之后它还留着 done 快照 —— 于是新拖进来的被当成「转换中追加」
  //    塞进待办，体检回来一看这批已 done，自动晋升、自动开转，
  //    用户一句话没说就掉了额度。判据必须是 isRunning || starting。
  //
  //    对照发布说明里既定的原则：中途按停止都不自动起新一批，
  //    「待办会并回待转清单由你决定」—— 转完了更没理由替用户做主。
  const t = mkActs((st) => {
    st.task = { state: 'done', current: 1, total: 1,
                results: [{ ok: true, pdf: 'D:/a.pdf' }] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
  });
  t.acts.addPaths(['D:/late.pdf']);
  await tick(); await tick(); await tick();
  if (t.posted.some((x) => x[0] === '/api/convert')) {
    throw new Error('没等用户发话就自动开转了 —— 白花一次 MinerU 额度');
  }
  if (!t.st.items.some((x) => x.path === 'D:/late.pdf')) {
    throw new Error('该进待转清单等命令，结果哪儿都没去');
  }
  if (t.st.pending.length) throw new Error('不该进待办，这批已经转完了');
});

ck('点开始那一瞬拖进来的，要进待办不能进清单', async () => {
  // 🔴 请求已经发出去、task 还没回来的那段窗口。判据漏了 starting 的话，
  //    这几份会被当成新的一批塞进 items —— 可这批的 paths 早发出去了，
  //    它们永远不会被转，界面上却一直显示「未处理」。
  const t = mkActs((st) => {
    st.starting = true;
    st.task = null;
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
    st.picked['D:/a.pdf'] = true;
  });
  t.acts.addPaths(['D:/late.pdf']);
  await tick(); await tick();
  if (!t.st.pending.some((x) => x.path === 'D:/late.pdf')) {
    throw new Error('starting 窗口里拖进来的没进待办，那几份会永远躺着');
  }
});

ck('「再转一批」移走成功的、留下失败的、不动没转过的', async () => {
  // 🔴 四件事一起验：
  //    1. 转成功的**移出列表** —— Word 已经在硬盘上了，留在待转清单里
  //       跟没转过的长得一模一样（都是没勾的白底行），看着像还堵在队列里
  //    2. 转失败的留下并勾上 = 一键重试，这才是这个按钮的价值
  //    3. **根本没转过的一根手指都不许动** —— st.items 里会混着摁停止时
  //       并回来的待办、晋升时 start() 失败留下的那批，它们不在 results 里
  //    4. 移走的同时把 picked 里的键删掉，理由见下一条
  const t = mkActs((st) => {
    st.task = { state: 'done', current: 2, total: 2,
                results: [{ ok: true, pdf: 'D:/a.pdf', docx: 'D:/a.docx' },
                          { ok: false, pdf: 'D:/b.pdf', error: '崩了' }] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] },
                { ok: true, path: 'D:/b.pdf', pages: 4, scan_pages: [] },
                { ok: true, path: 'D:/c.pdf', pages: 5, scan_pages: [] }];
    st.lastResults = [{ ok: true, pdf: 'D:/old.pdf' }];
  });
  t.acts.newBatch();
  if (t.st.items.some(function (x) { return x.path === 'D:/a.pdf'; })) {
    throw new Error('转成功的没移走，还堵在待转清单里');
  }
  if (t.st.items.length !== 2) {
    throw new Error('移多了或移少了，剩 ' + t.st.items.length + ' 份');
  }
  if ('D:/a.pdf' in t.st.picked) {
    throw new Error('移走了却把 picked 的键留着 —— 见下一条');
  }
  if (t.st.picked['D:/b.pdf'] !== true) throw new Error('失败的没自动勾上');
  if (t.st.picked['D:/c.pdf'] === false) {
    throw new Error('没转过的那份被动了 —— 用户会以为文件被吃了');
  }
  if (t.st.lastResults !== null) {
    throw new Error('lastResults 没清，会隔着一批串味、报告指错批次');
  }
});

ck('移走的时候必须把 picked 的键一起删掉', async () => {
  // 🔴 picked 是三态：**键不存在才等于选中**。移走文件只删列表、不删键的话，
  //    那个 false 会一直留着；等同一份 PDF 哪天又被拖进来，它就默认不勾，
  //    跟「拖进来默认全勾」直接打架，而且只在「转过 → 再拖一次」时才现形。
  //
  //    ⚠️ 云端眼下有个巧合的补救：addPaths 里有 `if (x.ok) picked[x.path] = true`，
  //    会把残留值盖掉。本地版的 addPaths **不设**，全靠三态 —— 所以那边是真
  //    会中招。这条测的是「移走时清干净」这个约定本身，不指望 addPaths 兜底。
  const t = mkActs((st) => {
    st.task = { state: 'done', current: 1, total: 1,
                results: [{ ok: true, pdf: 'D:/a.pdf', docx: 'D:/a.docx' }] };
    st.taskId = 'T1';
    st.items = [{ ok: true, path: 'D:/a.pdf', pages: 3, scan_pages: [] }];
  });
  t.acts.newBatch();
  if (t.st.picked['D:/a.pdf'] === false) {
    throw new Error('picked 里留了个 false，同一份再拖进来会默认不勾');
  }
  if (Object.keys(t.st.picked).length !== 0) {
    throw new Error('picked 没清干净，剩：' + Object.keys(t.st.picked).join(','));
  }
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
  if (!h.includes('还没有转换记录')) throw new Error('空白页');
  if (!h.includes('转过的每一份都会记在这儿')) throw new Error('空态没有副标题');
});

ck('有历史时提示能看完整报错', () => {
  // 失败那行的完整报错藏在 title 里，不说没人会去悬停
  const st = ready(sb);
  st.page = 'history';
  st.runs = [{ ok: false, pdf: 'D:/a.pdf', file: 'a.pdf',
               error: '超时', error_full: '连接超时，等了 60 秒',
               time: '2026-09-09 10:00:00' }];
  const h = hist(st);
  if (!h.includes('鼠标停在失败那行上能看完整报错')) throw new Error('没给提示');
  if (!h.includes('共 1 份')) throw new Error('没报总数');
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
  //    ⚠️ 窗口也不能写死字符数：2026-09-09 给 poll 加了三道防重绘的闸，
  //    函数一长，404 那段就被挤出原来那 1600 字符的窗口，测试红了但代码
  //    是对的。改成截到**下一个同级函数**为止，函数多长都盖得住。
  const i = src.indexOf('function poll()');
  const NL = String.fromCharCode(10);
  const j = src.indexOf(NL + '  function ', i + 10);
  const seg = src.slice(i, j > i ? j : src.length);
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

ck('不在主屏时不重绘（在历史页翻记录不该被打断）', async () => {
  // 🔴 历史 / 设置 / 关于这几屏根本不显示任务状态，每秒重绘一次纯粹是
  //    把用户的滚动位置往回拽。st.task 照样更新，切回主屏时自然是新的。
  const a = { state: 'running', current: 0, total: 2, now: 'a.pdf',
              error: '', lines: ['x'], results: [] };
  const b = { state: 'running', current: 1, total: 2, now: 'b.pdf',
              error: '', lines: ['y'], results: [{ ok: true }] };
  const t = mkPollSandbox([a, b]);
  t.st.page = 'history';
  await t.poll(); await t.poll();
  if (t.count() !== 0) {
    throw new Error('不在主屏还重绘了 ' + t.count() + ' 次');
  }
  if (!t.st.task || t.st.task.current !== 1) {
    throw new Error('数据也没更新 —— 只是不画，不是不收');
  }
});

ck('结构没变就只改那两处文字，整页不动', async () => {
  // 还在转同一份、只是状态那句话变了 —— 没必要把整页 innerHTML 换掉
  const a = { state: 'running', current: 0, total: 2, now: '正在解析',
              error: '', lines: ['第 1 页'], results: [] };
  const b = { state: 'running', current: 0, total: 2, now: '正在排版',
              error: '', lines: ['第 2 页'], results: [] };
  const t = mkPollSandbox([a, b]);
  // 让抓手「存在」，好让 patchConv 走通（沙箱默认返回 null）
  const patched = {};
  t.sb.document.getElementById = (id) => ({
    set textContent(v) { patched[id] = v; },
  });
  await t.poll();          // 第一轮：结构签名还是空的，整页画一次
  const after1 = t.count();
  await t.poll();          // 第二轮：结构没变，只 patch
  if (t.count() !== after1) {
    throw new Error('结构没变却整页重画了');
  }
  if (patched.convnow !== '正在排版') {
    throw new Error('底栏状态没跟上：' + patched.convnow);
  }
  if (patched.convline !== '第 2 页') {
    throw new Error('当前行那句话没跟上：' + patched.convline);
  }
});

ck('抓手不在就老实整页重画', async () => {
  // patchConv 找不到 convnow（比如正开着报告屏）时必须 falseback，
  // 不能因为「结构没变」就什么都不做 —— 那样界面会僵在旧状态。
  const a = { state: 'running', current: 0, total: 2, now: 'a',
              error: '', lines: ['1'], results: [] };
  const b = { state: 'running', current: 0, total: 2, now: 'b',
              error: '', lines: ['2'], results: [] };
  const t = mkPollSandbox([a, b]);   // 沙箱的 getElementById 恒返回 null
  await t.poll(); await t.poll();
  if (t.count() !== 2) {
    throw new Error('抓手不在时该整页重画 2 次，实际 ' + t.count());
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
