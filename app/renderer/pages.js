// pages.js — 把状态画成界面
//
// 老项目这个文件 1821 行，这份约 380 —— 砍掉的全是云端版不存在的屏：
// 显卡不达标、装 GPU 运行库、装 C++ 运行库、下模型、环境检测整页、
// 升级备份列表、进度条、倒计时、两轮识别的阶段名。
//
// 云端只给 pending/running/done，没有细粒度进度，所以这里**不画进度条、
// 不画倒计时**（作者 2026-09-08 拍板）。给的是「第几份 / 共几份」和云端
// 状态那一行字 —— 都是真的，不编。
//
// 🔴 类名沿用 index.html 里那套（跟老项目同一份样式表）：
//    `.grow.ell` 撑开并省略号、`.rt` 右侧灰字、`.note` 中间说明、
//    `dot` 靠内联颜色、链接是 `button.link`。**不要自造类名** ——
//    样式表里没有的类写了也不生效，界面会散架。

(function () {
  var C = { ok: '#15803d', bad: '#b91c1c', run: '#1d4ed8', dim: '#8c8c8c' };

  // 🔴 **这张表是分发义务，不是装饰。** 本软件按 GPL-3.0-or-later 发，
  //    用到的组件里 pandoc 是 GPL-2.0+、PyMuPDF 是 AGPL-3.0，都要求
  //    分发时保留许可信息。加组件就往这儿加一行。
  //    ⚠️ 跟本地版那张表**不一样**：云端不跑本地模型，没有 PyTorch；
  //    多了后端那几个（FastAPI / uvicorn / pydantic / requests / lxml）。
  var LICENSES = [
    ['MinerU', 'Apache-2.0'],
    ['pandoc', 'GPL-2.0+'],
    ['PyMuPDF', 'AGPL-3.0'],
    ['KaTeX', 'MIT'],
    ['lxml', 'BSD-3-Clause'],
    ['FastAPI', 'MIT'],
    ['uvicorn', 'BSD-3-Clause'],
    ['pydantic', 'MIT'],
    ['requests', 'Apache-2.0'],
    ['Node.js', 'MIT'],
    ['Electron', 'MIT'],
  ];

  // 更新失败要重下整包时给用户的地址。跟 pipeline/update.py 的 OWNER/REPO
  // 是同一个仓库 —— 那边改了这里也要改。
  var RELEASE_URL = 'https://github.com/kiryusento2017/teach-studio/releases';

  function fmtMB(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function base(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function chr10() { return String.fromCharCode(10); }

  function dot(color) {
    return '<span class="dot" style="background:' + color + '"></span>';
  }

  function btn(act, text, o) {
    o = o || {};
    return '<button data-act="' + act + '"'
      + (o.arg ? ' data-arg="' + esc(o.arg) + '"' : '')
      + (o.cls ? ' class="' + o.cls + '"' : '')
      + (o.title ? ' title="' + esc(o.title) + '"' : '')
      + (o.off ? ' disabled' : '') + '>' + esc(text) + '</button>';
  }

  function link(act, text, arg, off) {
    return btn(act, text, { cls: 'link', arg: arg, off: off });
  }

  function shell(top, body, bot) {
    return '<div class="chrome-top">' + top + '</div>'
      + '<div class="main" data-keep-scroll="main">' + body + '</div>'
      + '<div class="chrome-bot">' + bot + '</div>';
  }

  function errBar(st) {
    if (!st.err) return '';
    return '<div class="note bad">' + esc(st.err) + ' '
      + link('dismissErr', '知道了') + '</div>';
  }

  // ── 缺东西的时候拦一屏 ───────────────────────────────────────────────
  //
  // 🔴 **每一屏都给出路**，不给死胡同 —— 老项目那条教训：拦截屏把用户
  //    挡在门外却不说该干什么，等于软件不能用。
  function gate(st) {
    var e = st.env;
    if (!e) return null;
    if (!e.writable) {
      return { title: '这个文件夹写不了',
               body: '软件装在了没有写权限的位置（比如 C:\\Program Files）。'
                   + '把整个文件夹挪到 D 盘之类的地方，再打开。',
               retry: '我挪好了，重新检查' };
    }
    if (!e.node || !e.node.ok || !e.pandoc || !e.pandoc.ok) {
      var miss = [];
      if (!e.node || !e.node.ok) miss.push('node');
      if (!e.pandoc || !e.pandoc.ok) miss.push('pandoc');
      return { title: '安装包不完整',
               body: '缺少 ' + miss.join(' 和 ') + '。这两个本该跟软件一起'
                   + '打包，缺了多半是杀毒软件删过文件。重新解压一次安装包。',
               retry: '重新检查' };
    }
    return null;
  }

  // 🔴 **拦截屏必须给按钮。** 只放一段字的话，用户照提示把文件夹挪好了
  //    回来一看 —— 没有任何可点的东西，只能关掉软件重开，而他并不知道
  //    重开就行。本地版这两屏都是「主按钮 + 退出」，照搬。
  //    reload 走 window.location.reload()（重走一遍开机自检）、
  //    quit 走 window.close()，都是浏览器 API，不用加 IPC 通道。
  function gateView(g) {
    return '<div class="fill">'
      + '<div style="font-size:14px;font-weight:600">' + esc(g.title) + '</div>'
      + '<div class="f-dim" style="max-width:460px;line-height:1.6">'
      + esc(g.body) + '</div>'
      + '<div style="display:flex;gap:8px">'
      + btn('reload', g.retry || '重新检查', { cls: 'primary' })
      + btn('quit', '退出') + '</div></div>';
  }

  // ── 还没填 token 时的引导 ────────────────────────────────────────────
  //
  // 🔴 **这一屏不放输入框。** token 只在设置页里填 —— 同一件事两个地方
  //    都能改，迟早两边说法不一致（老项目那类坑）。这里只负责把人送过去。
  function tokenView(st) {
    return '<div class="fill" style="gap:8px">'
      + '<div style="font-size:14px;font-weight:600">还没填 token</div>'
      + '<div class="f-dim" style="max-width:460px;line-height:1.6">'
      + '解析在 MinerU 的服务器上跑，要用你自己的 API token，注册免费。'
      + '可以注册多个账号各填一个，额度叠加着用。</div>'
      + '<div style="display:flex;gap:8px">'
      + btn('openSettings', '去设置里填', { cls: 'primary' })
      + '</div></div>';
  }

  // ── 设置页 ───────────────────────────────────────────────────────────
  var TOKEN_URL = 'https://mineru.net/apiManage/token';

  // 一行输入框。改某一个和添一个新的共用这一行 —— 只是标题不同。
  function tokenEditRow(st, label) {
    return '<div class="it">'
      + '<span class="f-dim" style="flex:none;width:52px">' + esc(label) + '</span>'
      + '<input id="tokenbox" type="text" spellcheck="false" '
      + 'placeholder="粘贴 token，按回车保存" '
      + 'style="flex:1;padding:4px 6px;font-family:Consolas,monospace">'
      + btn('saveSlot', st.tokenBusy ? '正在验…' : '保存',
            { cls: 'primary', off: st.tokenBusy })
      + btn('cancelSlot', '取消', { off: st.tokenBusy })
      + '</div>';
  }

  function tokenRow(x, i, st) {
    if (st.editSlot === i) return tokenEditRow(st, '第 ' + (i + 1) + ' 个');
    return '<div class="it">'
      + dot(C.ok)
      + '<span class="f-dim" style="flex:none;width:44px">'
      + (i + 1) + '</span>'
      + '<span class="grow ell" style="font-family:Consolas,monospace">'
      + esc(x.masked) + '</span>'
      + '<span class="rt">今天用了 ' + (x.used || 0) + ' 页</span>'
      + link('editSlot', '换', String(i))
      + link('clearSlot', '删', String(i)) + '</div>';
  }

  function guideText() {
    return ['想要更多额度就多注册几个号 —— 一个手机号能注册一个账号，微信也能',
            '单独注册一个，每个号的每日额度分开算。',
            '',
            '1. 打开 ' + TOKEN_URL,
            '   （点右上角「复制地址」，再粘到浏览器里）',
            '2. 用手机号注册登录，在这个页面创建一个 API token，复制出来',
            '3. 退出登录，改用微信注册第二个号，同样创建一个 token',
            '4. 回到这里点「+ 添加」，一个一个粘进去',
            '',
            '转换的时候软件自动挑「今天用得最少」的那个号；某个号额度到顶了，',
            '会自动换下一个接着转，不用你管。',
            '',
            '注意：这里显示的用量只算通过本软件转掉的。你自己在 mineru 网页上',
            '传的文件，软件看不到，所以这个数只多不少地偏小。'].join(chr10());
  }

  // ── 更新区块 ─────────────────────────────────────────────────────────
  //
  // 🔴 **每一屏都挂着「各条线路怎么样」**，包括失败那屏 —— 用户看到
  //    「连不上 GitHub」时最想知道的就是「到底哪条不通」，而那份明细
  //    是查更新时顺手就有的（六条并发全跑了），不给等于白扔。
  function updLines(st) {
    var u = st.upd || {};
    var rows = u.lines || [];
    if (!rows.length) return '';
    if (!st.updLines) {
      return '<div class="it"><span class="grow f-dim">'
        + '这次走了 ' + rows.length + ' 条线路</span>'
        + link('toggleUpdLines', '看看都怎么样') + '</div>';
    }
    return '<div class="it"><span class="grow f-dim">各条线路</span>'
      + link('toggleUpdLines', '收起') + '</div>'
      + rows.map(function (r) {
          var bad = !r.ok;
          return '<div class="it">' + dot(bad ? C.bad : C.ok)
            + '<span class="grow ell f-dim">' + esc(r.name || r.id) + '</span>'
            + '<span class="rt ell" style="max-width:200px">'
            // 🔴 写明是**响应**。这个数是查版本时的往返延迟，不是下载速度 ——
            //    只写「320 毫秒」摆在线路表里，很容易被当成网速读。
            //    （本地版有单独的测速功能所以那一列放实测字节率，
            //      云端没测速，就老老实实说这是响应。）
            + esc(r.pending ? '没测完'
                 : (r.ok ? ('响应 ' + r.ms + 'ms'
                            + (r.used ? '（用的这条）' : ''))
                         : (r.error || '不通')))
            + '</span></div>';
        }).join('');
  }

  function updNotes(st) {
    var u = st.upd || {};
    var brief = u.notes_brief || u.notes || '';
    var full = u.notes_full || '';
    if (!brief && !full) return '';
    var text = (st.updNotes && full) ? full : brief;
    return '<div class="log" data-keep-scroll="updnotes"><span class="l">'
      + esc(text).split(chr10()).join('</span><span class="l">')
      + '</span></div>'
      + (full && full !== brief
          ? '<div class="it"><span class="grow"></span>'
            + link('toggleUpdNotes', st.updNotes ? '收起说明' : '完整说明')
            + '</div>'
          : '');
  }

  // ── 更新 · 独立整屏 ───────────────────────────────────────────────────
  //
  // 🔴 原先这是设置页里的一个区块，每个分支压成一行 `.it`。改回整屏是因为
  //    这几屏**都要用户拿主意**（装不装、验不过还装不装、失败了怎么办），
  //    而一行字加一个小按钮撑不起「拿主意」这件事 —— 本地版一直是
  //    「14px/600 标题 + 说明 + 按钮组」，照搬。
  //
  //    ⚠️ 线路那张表**没有**跟着搬本地版的 radio + 测速按钮：那需要后端
  //    支持指定线路和实测速度，云端两样都没有（updateStart 永远发 line:''）。
  //    只搬形态，不编功能。

  function updShell(title, body, buttons, st) {
    return shell(
      btn('backMain', '← 返回') + '<span class="grow"></span>'
        + '<span class="f-dim">检查更新</span>',
      '<div class="fill" style="justify-content:flex-start;'
        + 'padding-top:18px;gap:10px">'
        + '<div style="font-size:14px;font-weight:600">' + title + '</div>'
        + (body || '')
        + (buttons ? '<div style="display:flex;gap:8px">' + buttons + '</div>' : '')
        + '</div>',
      '');
  }

  function updDim(text) {
    return '<div class="f-dim" style="max-width:460px;line-height:1.6">'
      + text + '</div>';
  }

  function updatePage(st) {
    var u = st.upd;
    var t = st.updTask;
    var ver = esc((st.env && st.env.version) || '(未知)');

    // ① 正在下载 / 安装
    if (t && (t.state === 'downloading' || t.state === 'installing')) {
      var pct = (t.total ? Math.floor(t.got * 100 / t.total) : 0);
      var title = t.state === 'installing' ? '正在安装…'
                : (t.step === 'probing' ? '正在挑最快的线路…'
                                        : '正在下载 ' + pct + '%');
      var bar = (t.state === 'downloading' && t.total)
        ? '<div class="bar" style="width:320px"><i style="width:'
          + pct + '%"></i></div>'
        : '';
      var size = (t.total)
        ? updDim('已下 ' + fmtMB(t.got) + ' / ' + fmtMB(t.total)
                 + (t.via ? '　·　经 ' + esc(t.via) : ''))
        : (t.step === 'probing' ? updDim('要一两秒') : '');
      return updShell(esc(title), bar + size
        + updDim('下完会自动装好，不用你动手。'), '', st);
    }

    // ② 装好了，等重启
    if (t && t.state === 'done') {
      return updShell('更新完成',
        updDim('已更新 ' + (t.files || 0) + ' 个文件'
               + (t.via ? '　·　来自 ' + esc(t.via) : '') + '<br>'
               + '必须重启才生效 —— 当前进程跑的还是加载时的那份旧代码。'),
        btn('restartApp', '立即重启', { cls: 'primary' })
          + btn('backMain', '稍后重启'), st);
    }

    // ③ 拿不到校验值，问用户
    if (t && t.state === 'need_confirm') {
      return updShell('没法验证这个更新包',
        updDim(esc(t.error || '')
               + '<br>装不装由你定 —— 包是从 GitHub Release 下来的，'
               + '只是这次没拿到用来核对的校验值。'),
        btn('updateAnyway', '知道风险，继续更新', { cls: 'primary' })
          + btn('checkUpdate', '算了'), st);
    }

    // ④ 下载/安装失败
    if (t && t.state === 'error') {
      return updShell('这次更新没成',
        updDim(esc(t.error || '更新失败')) + updLines(st),
        btn('checkUpdate', '重来', { cls: 'primary' })
          + btn('backMain', '关闭'), st);
    }

    // ⑤ 正在查
    if (st.updBusy) {
      return updShell('正在查看有没有新版本…',
        updDim('在问 GitHub，几条线路一起跑，用最先通的那条。'), '', st);
    }

    // ⑥ 还没查
    if (!u) {
      return updShell('检查更新',
        updDim('当前版本 ' + ver + '<br>'
               + '更新包只换业务代码，Electron 和 pandoc 那些不动，'
               + '所以很小。'),
        btn('checkUpdate', '检查更新', { cls: 'primary' }), st);
    }

    // ⑦ 有新版本
    if (u.has_update) {
      return updShell('有新版本 ' + esc(u.latest || ''),
        updDim('当前 ' + ver
               + (u.published ? '　·　发布于 '
                  + esc(String(u.published).slice(0, 10)) : '')
               + (u.size ? '　·　' + fmtMB(u.size) : ''))
          + updNotes(st) + updLines(st),
        btn('startUpdate', '立即更新', { cls: 'primary' })
          + btn('backMain', '暂不更新'), st);
    }

    // ⑧ 得重下整包 —— 必须给出路
    //
    // 🔴 云端不弹浏览器（2026-09-08 的决定），所以出路是**复制地址**，
    //    不是「去下载页」。给了地址用户自己粘，百分百可控。
    if (u.need_full) {
      return updShell('这次要重新下载整个安装包',
        updDim(esc(u.error || '')
               + '<br>增量更新只换业务代码，跨大版本时依赖也变了，'
               + '换一半会跑不起来。<br>'
               + '把下面这个地址复制到浏览器，下最新的完整包，'
               + '装到原来那个文件夹就行 —— token 和转换历史都在里面，不会丢。')
          + '<div class="f-dim mono" style="font-size:11px">'
          + esc(RELEASE_URL) + '</div>' + updLines(st),
        btn('copyReleaseUrl', st.copied ? '已复制' : '复制下载页地址',
            { cls: 'primary' })
          + btn('backMain', '关闭'), st);
    }

    // ⑨ 查失败
    if (u.error) {
      return updShell('暂时没法检查更新',
        updDim(esc(u.error)) + updLines(st),
        btn('checkUpdate', '再试一次', { cls: 'primary' })
          + btn('backMain', '关闭'), st);
    }

    // ⑩ 已是最新
    return updShell('已经是最新版本',
      updDim('当前 ' + esc(u.local || ver)) + updLines(st),
      btn('checkUpdate', '再查一次') + btn('backMain', '关闭'), st);
  }

  function settingsPage(st) {
    var e = st.env || {};
    var tk = e.tokens || { count: 0, max: 50, list: [] };
    var list = tk.list || [];
    var n = list.length;
    var full = n >= (tk.max || 50);
    var adding = (st.editSlot === 'new');

    var body = '<div class="it">'
      + '<span class="grow">token（' + n + ' 个）</span>'
      + (full
          ? '<span class="f-dim">已经 ' + n + ' 个了</span>'
          : btn('addSlot', '+ 添加', { off: adding }))
      + '</div>'
      + (n
          ? list.map(function (x, i) { return tokenRow(x, i, st); }).join('')
          : (adding ? '' : '<div class="it"><span class="grow f-dim">'
                           + '一个都还没有，点右上角「+ 添加」</span></div>'))
      + (adding ? tokenEditRow(st, '新的') : '')
      + '<div class="it"><span class="grow f-dim">注册指南</span>'
      + link('copyTokenUrl', st.copied ? '已复制' : '复制地址') + '</div>'
      + '<div class="log" data-keep-scroll="guide"><span class="l">'
      + esc(guideText()).split(chr10()).join('</span><span class="l">')
      + '</span></div>'
      // 更新是独立一屏（要用户拿主意的东西不塞进设置页的行里），
      // 这儿只留入口 + 一句当前版本。
      + '<div class="it"><span class="grow">软件更新</span>'
      + (st.upd && st.upd.has_update
          ? '<span class="rt" style="color:' + C.run + '">有新版本 '
            + esc(st.upd.latest || '') + '</span>'
          : '<span class="rt f-dim">' + esc((st.env && st.env.version)
            || '(未知)') + '</span>')
      + btn('openUpdate', '检查更新') + '</div>';

    return shell(btn('backMain', '← 返回')
                 + '<span class="grow"></span>'
                 + '<span class="f-dim">设置</span>',
                 errBar(st) + body, '');
  }

  // ── 待转清单 ─────────────────────────────────────────────────────────
  function itemRow(x, st) {
    var name = base(x.path);
    if (!x.ok) {
      return '<div class="it" title="' + esc(x.path) + '">'
        + dot(C.bad)
        + '<span class="grow ell f-dim">' + esc(name) + '</span>'
        + '<span class="rt f-bad ell" style="max-width:260px">'
        + esc(x.note || x.error || '读不了') + '</span>'
        + link('removeOne', '移除', x.path) + '</div>';
    }
    var sp = x.scan_pages || [];
    var note = '';
    if (sp.length) {
      // 每一页都没文字层就别列页号了 —— 列出来是一长串，还不如直接说整份。
      note = sp.length === x.pages
        ? '整份没有文字层'
        : ('第 ' + sp.slice(0, 3).join('、') + ' 页没有文字层'
           + (sp.length > 3 ? ' 等 ' + sp.length + ' 页' : ''));
    }

    // 🔴 **点整行都能勾**，checkbox 只是个显示件（pointer-events:none 让
    //    点击穿透到行上）。只让点那 13px 的小方块的话，一批几十份光是勾
    //    就够受的。行上挂 data-act，末尾的「移除」是 button 自带 data-act，
    //    点击委托往上找最近的那个，所以点移除不会误触发勾选。
    var on = st.picked[x.path] !== false;
    return '<div class="it" data-act="toggle" data-arg="' + esc(x.path) + '"'
      + ' title="' + esc(x.path) + '">'
      + '<input type="checkbox" style="pointer-events:none"'
      + (on ? ' checked' : '') + '>'
      + '<span class="grow ell' + (on ? '' : ' f-dim') + '">' + esc(name) + '</span>'
      + (note ? '<span class="rt f-warn ell" style="max-width:200px">'
                + esc(note) + '</span>' : '')
      + '<span class="rt" style="width:52px;text-align:right">'
      + (x.pages || 0) + ' 页</span>'
      + link('removeOne', '移除', x.path) + '</div>';
  }

  // ── 转换中 / 转完的行 ────────────────────────────────────────────────
  // 转完一份之后那一行。**成功和失败给的东西不一样**：
  //
  //   成功 → 打开 / 文件夹；秒回的标「缓存」；公式没转全的写进 title
  //   失败 → 原因；有次品就给「打开次品」——次品也是花了额度换来的，
  //          正文、表格、图片都在，只是公式没转全，名字里带着标记，
  //          不会被当成正品
  function runRow(r, it) {
    var name = base((it && it.path) || r.pdf || r.docx || '');
    if (r.ok) {
      // 🔴 悬停能看到具体是第几个公式没转成 —— math_note 里写着，
      //    不显示的话那个字段等于白写。
      var tip = (r.docx || '') + (r.math_note ? (chr10() + r.math_note) : '');
      return '<div class="it" title="' + esc(tip) + '">'
        + dot(C.ok)
        + '<span class="grow ell">' + esc(base(r.docx || name)) + '</span>'
        // 🔴 秒回的那几份得说清楚为什么 —— 不标的话用户会以为根本没转。
        + (r.cached
            ? '<span class="rt f-dim" title="这份 PDF 和参数都没变，'
              + '直接用了上次的识别结果，没有再传一遍、也没扣额度">缓存</span>'
            : '')
        + (r.line ? '<span class="rt ell" style="max-width:220px">'
            + esc(r.line) + '</span>' : '')
        + link('openFile', '打开', r.docx)
        + link('openFolder', '文件夹', r.docx) + '</div>';
    }
    return '<div class="it" title="' + esc(r.error || '') + '">'
      + dot(C.bad)
      + '<span class="grow ell f-dim">' + esc(name) + '</span>'
      + '<span class="rt f-bad ell" style="max-width:240px">'
      + esc(r.cancelled ? '已停止' : ('失败：' + (r.error || ''))) + '</span>'
      + (r.degraded
          ? link('openFile', '打开次品', r.degraded)
            + link('openFolder', '文件夹', r.degraded)
          : '') + '</div>';
  }

  function worthReport(t) {
    return (t.results || []).some(function (r) {
      return !r.ok || (r.scan_pages || []).length
        || ((r.formulas || 0) - (r.formulas_xsl || 0)) > 0
        || (r.details_dropped || 0) > 0;
    });
  }

  // 🔴 **每一份都列，成功的也列。** 原先只列有问题的那几份 —— 看着清爽，
  //    可用户没法确认「我这份到底转没转、软件看没看过」：没列出来既可能
  //    是干净，也可能是被漏了，两种情况长得一模一样。
  //    列全了才能拿着它一份份核对 Word。
  function reportText(t) {
    var L = ['转换报告',
             '列出来的是最可能出问题的地方，没列出来的不代表一定对。',
             ''];
    (t.results || []).forEach(function (r) {
      var name = base(r.pdf || r.docx || '');
      L.push(name + (r.ok ? '' : '   ✗ 失败'));
      if (!r.ok) {
        L.push('    ' + (r.cancelled ? '已停止' : (r.error || '没说原因')));
        if (r.degraded) L.push('    次品留在：' + r.degraded);
      } else {
        L.push('    ' + [(r.pages || 0) + ' 页',
                         '公式 ' + (r.formulas_xsl || 0) + '/' + (r.formulas || 0),
                         '表 ' + (r.tables || 0),
                         '图 ' + (r.images || 0)].join(' · '));
        var miss = (r.formulas || 0) - (r.formulas_xsl || 0);
        if (miss > 0) {
          L.push('    有 ' + miss + ' 个公式没转成'
                 + (r.math_note ? '：' + r.math_note : '，保留了 LaTeX 原文'));
        }
        var sp = r.scan_pages || [];
        if (sp.length) {
          // 页号截前 12 个 —— 整份扫描件能列出上百个数字，那不是信息是噪音
          L.push('    第 ' + sp.slice(0, 12).join('、') + ' 页没有文字层'
                 + (sp.length > 12 ? ' 等 ' + sp.length + ' 页' : '')
                 + '（整页当图片认的，这几页最该核对）');
        }
        if (r.details_dropped) {
          L.push('    图里的文字有 ' + r.details_dropped + ' 处没有放进正文'
                 + '（它们本来就印在图上，Word 里那张图还在）');
        }
        // 落盘路径。报告是拿去核对 Word 的，不给路径就得自己翻。
        L.push('    存到：' + (r.docx || ''));
      }
      L.push('');
    });
    return L.join(chr10());
  }

  // ── 主屏 ─────────────────────────────────────────────────────────────
  // ── 待办区 ───────────────────────────────────────────────────────────
  //
  // 转换中新拖进来的文件放这儿，**不混进主列表**。这一批转完自动晋升成
  // 新一批（见 actions.promotePending），不用用户点。
  //
  // 🔴 为什么不混进主列表：混了就得在一张表里区分「这批的」和「下批的」，
  //    而那正是「4 个文件下面又冒出一模一样 4 个」那个 bug 的土壤。
  //    分开摆，一眼看清哪些在转、哪些排着。
  function pendingBox(st, done) {
    var ps = st.pending || [];
    var lastOk = !!(st.lastResults && st.lastResults.length
                    && worthReport({ results: st.lastResults }));
    var lastBtn = lastOk
      ? link('toggleLastReport',
             st.showLastReport ? '返回列表' : '上一批的报告')
      : '';

    // 🔴 **转完之后这一块只剩「上一批的报告」。**
    //    那时待办要么已经晋升成新一批、要么本来就没有；而「再加几份」在
    //    结果页没有意义 —— 顶上已经有「再转一批」，那是回待转清单的正路，
    //    两个入口做同一件事只会让人犹豫。
    if (done) {
      return lastOk
        ? '<div class="it" style="font-size:11px"><span class="grow"></span>'
          + lastBtn + '</div>'
        : '';
    }

    var head = '<div class="it" style="font-size:11px">'
      + '<span class="grow f-dim">'
      + (st.pendingBusy
          ? '正在看这几份…'
          : ps.length
            ? ('待办 ' + ps.length + ' 份，这批转完自动接上')
            : '转换中也可以把 PDF 拖进来，排在这批后面转')
      + '</span>'
      + link('pickMore', '再加几份') + lastBtn + '</div>';
    if (!ps.length) return head;
    return head + ps.map(function (x) {
      return '<div class="it" style="font-size:11px">'
        + '<span style="flex:none;width:18px"></span>'
        + '<span class="grow ell f-dim">' + esc(base(x.path)) + '</span>'
        + '<span class="rt">' + (x.pages || 0) + ' 页</span>'
        + link('delPending', '移除', x.path) + '</div>';
    }).join('');
  }

  // ── 主屏 · 待转态 ────────────────────────────────────────────────────
  function mainPick(st) {
    var top = btn('pickFiles', '添加文件') + btn('pickDir', '添加文件夹')
      + (st.items.length ? btn('clearAll', '移除全部') : '')
      + '<span class="grow"></span>'
      + '<span class="f-dim ell" style="max-width:240px" title="'
      + esc(st.outDir || '跟原 PDF 放一起') + '">输出：'
      + esc(st.outDir || '跟原 PDF 放一起') + '</span>'
      + btn('pickOutDir', '更改')
      + (st.outDir ? btn('useSourceDir', '还原') : '');

    // 🔴 **正在读文件夹时必须说话。** 逐份体检要时间，书多的话十几秒；
    //    这期间界面一个字不变，用户只会以为软件卡死了 ——「反应很慢」
    //    的抱怨多半来自这里，而不是真的慢。（本地版实测 456 份 16 秒。）
    if (st.scanning) {
      return shell(top,
        errBar(st)
        + '<div class="fill">'
        + '<div style="font-size:13px;font-weight:600">正在读取…</div>'
        + '<div class="f-dim">逐份检查页数和文字层，文件夹里书多的话要等几秒</div>'
        + (st.items.length
            ? '<div class="f-dim">已经在列表里的 ' + st.items.length
              + ' 份不受影响</div>'
            : '')
        + '</div>',
        dot(C.dim) + '<span class="f-dim">读取中…</span>');
    }

    // 空列表也要**铺满**，拖放区是整个主区，不是居中一个小方框。
    if (!st.items.length) {
      return shell(top,
        errBar(st)
        + '<div class="fill' + (st.dragging ? ' drop' : '') + '">'
        + '<div style="font-size:14px;font-weight:600">'
        + (st.dragging ? '松手就行' : '把 PDF 拖进来') + '</div>'
        + '<div class="f-dim">单个文件、多个文件、整个文件夹都行</div>'
        + '<div style="display:flex;gap:8px;margin-top:4px">'
        + btn('pickFiles', '选文件') + btn('pickDir', '选文件夹')
        + '</div></div>',
        botPick(st, []));
    }

    var sel = st.items.filter(function (x) {
      return x.ok && st.picked[x.path] !== false;
    });

    // 表头：跟列表同宽、粘在顶上。右边那个空 span 是给每行末尾的「移除」
    // 让位的，不留的话「页数」列头会比行里的页数偏右一个按钮的宽度。
    var head = '<div class="hd">'
      + '<span style="width:13px"></span>'
      + '<span class="grow">文件（共 ' + st.items.length + ' 份）</span>'
      + link('selAll', '全选') + link('selNone', '全不选')
      + '<span style="width:52px;text-align:right">页数</span>'
      + '<span style="width:30px"></span></div>';

    return shell(top,
      errBar(st) + head
        + st.items.map(function (x) { return itemRow(x, st); }).join(''),
      botPick(st, sel));
  }

  function botPick(st, sel) {
    var tks = (st.env && st.env.tokens) || { list: [] };
    var nTok = tks.count || (tks.list || []).length;
    var usedAll = (tks.list || []).reduce(function (a, x) {
      return a + (x.used || 0);
    }, 0);
    var pg = sel.reduce(function (a, x) { return a + (x.pages || 0); }, 0);
    return dot(C.ok)
      + '<span class="f-dim">' + nTok + ' 个 token'
      + (usedAll ? ' · 今天已用 ' + usedAll + ' 页' : '') + '</span>'
      + link('openSettings', '设置') + link('openHistory', '历史')
      + link('openAbout', '关于')
      + '<span class="grow"></span>'
      + '<span class="f-dim">' + (sel.length
          ? ('选中 ' + sel.length + ' 份 · ' + pg + ' 页')
          : '还没选中') + '</span>'
      + btn('start', st.starting ? '正在开始…' : '开始转换',
            { cls: 'primary', off: !sel.length || st.starting });
  }

  // ── 主屏 · 转换中 / 转完 ─────────────────────────────────────────────
  //
  // 🔴 **一张表。** 从 `st.items` 出发，把结果按路径贴到对应行上 ——
  //    行的状态在变，表本身不变，不跳屏。
  //
  //    原来是「已完成 + 正在转 + 排队中 + 刚拖进来」四段拼接，除了跳屏
  //    还出过一个 bug：点开始之后待选清单没清，同一批文件在下面又原样
  //    列了一遍。一张表的结构里那种事压根不可能发生。
  function mainRun(st) {
    var t = st.task;
    if (!t) {
      return shell('', '<div class="fill"><div class="f-dim">正在开始…</div></div>', '');
    }
    var done = t.state === 'done' || t.state === 'cancelled';
    var res = t.results || [];
    var okN = 0;
    res.forEach(function (r) { if (r.ok) okN++; });

    var byPath = {};
    res.forEach(function (r) { byPath[r.pdf] = r; });

    var rows = st.items.filter(function (x) {
      return x.ok && st.picked[x.path] !== false;
    }).map(function (it, i) {
      var r = byPath[it.path];
      if (r) return runRow(r, it);
      if (!done && i === t.current) {
        // 正在转的那一份：把云端最后一句状态显示在右边
        // id 是给轮询的局部更新用的抓手 —— 见 actions.js 的 patchConv。
        return '<div class="it on" title="' + esc(it.path) + '">' + dot(C.run)
          + '<span class="grow ell">' + esc(base(it.path)) + '</span>'
          + '<span class="rt ell" id="convline" style="max-width:300px">'
          + esc((t.lines || []).slice(-1)[0] || '正在处理…')
          + '</span></div>';
      }
      // 还没轮到
      return '<div class="it" title="' + esc(it.path) + '">' + dot(C.dim)
        + '<span class="grow ell f-dim">' + esc(base(it.path)) + '</span>'
        + '<span class="rt f-dim">' + (it.pages || 0) + ' 页 · 等着</span>'
        + '</div>';
    }).join('');

    // 🔴 **顶栏只放「在干什么」，统计和动作都在底栏。**「停止」原先挂在
    //    顶栏右端 —— 本地版一直放底栏，同一个动作两个软件放两处纯粹是
    //    搬漏了。底栏本来就是状态栏，「现在什么情况 + 能干什么」放一起。
    var top = done
      ? '<span style="font-size:13px;font-weight:600">'
        + (t.state === 'cancelled' ? '已停止' : '转换完成') + '</span>'
        + '<span class="grow"></span>'
        + (worthReport(t) ? btn('toggleReport',
            st.showReport ? '返回列表' : '看报告') : '')
        + btn('newBatch', '再转一批', { cls: 'primary' })
      : '<span style="font-size:13px;font-weight:600">正在转第 '
        + ((t.current || 0) + 1) + ' / ' + t.total + ' 份</span>'
        + '<span class="grow"></span>'
        + '<span class="f-dim ell" style="max-width:300px">'
        + '云端在跑，「停止」只是不再等它</span>';

    // 转完那句话。**失败的份数要单独说、并且是红的** ——
    //「3 成 / 3 份」既容易读成「三成」，也把「几份没成」藏起来了。
    var badN = t.total - okN;
    var doneText = t.state === 'cancelled'
      ? '已停止 · 成功 ' + okN + ' 份'
      : (badN
          ? '成功 ' + okN + ' 份 · <span class="f-bad">失败 ' + badN + ' 份</span>'
          : '全部完成 ' + t.total + ' 份');

    var bot = dot(done ? (okN === t.total ? C.ok : C.bad) : C.run)
      + '<span class="f-dim" id="convnow">'
      + (done ? doneText : esc(t.now || '准备中…')) + '</span>'
      + link('openSettings', '设置') + link('openHistory', '历史')
      + link('openAbout', '关于')
      + '<span class="grow"></span>'
      // 🔴 转完之后也留着「日志」—— 转失败时最想看的就是它。
      //    数据一直都在（后端每轮都返回 lines），原先只取最后一行显示，
      //    等于攒了一路的东西没给人看。
      + btn('toggleLog', st.showLog ? '返回列表' : '日志')
      + (done ? '' : btn('stop', '停止'));

    // 日志：把云端每轮返回的那几行摊开
    if (st.showLog) {
      var lg = t.lines || [];
      return shell(top,
        '<div class="fill" style="justify-content:flex-start;gap:6px">'
        + '<div class="log" data-keep-scroll="convlog">'
        + (lg.length
            ? lg.map(function (x) {
                return '<span class="l">' + esc(x) + '</span>';
              }).join('')
            : '<span class="l">（还没有输出。刚交上去的时候云端会安静'
              + '一阵子，排队和解析都要时间）</span>')
        + '</div></div>',
        bot);
    }

    // 报告：本批
    //
    // 🔴 报告不落盘（底栏那句话就是说这个），不给复制等于看完就没了 ——
    //    用户想把「哪几页要核对」发给别人都做不到。文本顺手存进
    //    st.reportText，copyReport 从那儿取，不用再算一遍。
    if (done && st.showReport) {
      var rtxt = reportText(t);
      st.reportText = rtxt;
      return shell(top, reportView(rtxt),
        dot(okN === t.total ? C.ok : C.bad)
        + '<span class="f-dim">这份报告只在这儿看，不会存成文件</span>'
        + btn('copyReport', st.copied ? '已复制' : '复制')
        + '<span class="grow"></span>');
    }
    // 报告：上一批（晋升之后还能看 —— 那些 Word 已经在用户硬盘里了）
    if (st.showLastReport && st.lastResults && st.lastResults.length
        && worthReport({ results: st.lastResults })) {
      return shell(top,
        pendingBox(st, done)
        + reportView(reportText({ results: st.lastResults })), bot);
    }

    return shell(top,
      errBar(st)
      + (rows || '<div class="fill"><div class="f-dim">没有要转的文件</div></div>')
      + pendingBox(st, done),
      bot);
  }

  // 报告的壳。**返回按钮在内容前面** —— 内容区是 .fill（min-height:100%），
  // 拼在它后面的东西会被顶到第一屏之外，620x440 的窗口里等于不存在。
  function reportView(text) {
    return '<div class="fill" style="justify-content:flex-start;gap:6px">'
      + '<div style="align-self:flex-start">'
      + btn('toggleReport', '← 返回列表') + '</div>'
      + '<div class="log" data-keep-scroll="report"><span class="l">'
      + esc(text).split(chr10()).join('</span><span class="l">')
      + '</span></div></div>';
  }

  function mainPage(st) {
    if (!st.ready) {
      return shell('', '<div class="fill"><div class="f-dim">正在启动…</div></div>', '');
    }

    // 🔴 **后台没起来要单独说，而且要给重试。** 这一屏必须排在 gate 前面：
    //    env 都没拿到，gate() 第一句 `if (!e) return null` 直接放行，
    //    人就一路滑到「请填 token」那屏去了 —— 后台都没起来，填了也没用。
    //    报错原文用 mono 左对齐摊开，那是给人抄去问的，不是给人读的。
    if (st.envError) {
      return shell(
        '<span class="f-dim" style="padding:0 4px">PDF 转 Word</span>',
        '<div class="fill">'
          + '<div style="font-size:14px;font-weight:600">连不上后台服务</div>'
          + '<div class="f-dim mono" style="max-width:460px;'
          + 'white-space:pre-wrap;text-align:left">' + esc(st.envError) + '</div>'
          + '<div style="display:flex;gap:8px">'
          + btn('reload', '重试', { cls: 'primary' })
          + btn('quit', '退出') + '</div></div>',
        '');
    }

    var g = gate(st);
    if (g) return shell('', errBar(st) + gateView(g), '');

    var hasTok = !!(st.env && st.env.token && st.env.token.ok);
    if (!hasTok) {
      return shell('', errBar(st) + tokenView(st),
                   link('openSettings', '设置') + link('openHistory', '历史')
                   + link('openAbout', '关于'));
    }
    return (window.P2W_ISRUNNING(st) || st.task) ? mainRun(st) : mainPick(st);
  }

  function historyPage(st) {
    var rows = st.runs || [];
    var body = rows.length
      ? rows.map(function (r) {
          var ok = !!r.ok;
          return '<div class="it" title="'
            + esc(ok ? r.docx : (r.error_full || r.error || '')) + '">'
            + dot(ok ? C.ok : C.bad)
            + '<span class="f-dim" style="flex:none;width:86px">'
            + esc((r.time || '').slice(5, 16)) + '</span>'
            + '<span class="grow ell">' + esc(r.file || base(r.pdf)) + '</span>'
            + '<span class="rt ell" style="max-width:280px">'
            + esc(ok ? (r.pages + ' 页 · 公式 ' + r.formulas
                        + ' · 表 ' + r.tables + ' · 图 ' + r.images)
                     : (r.error || '失败')) + '</span>'
            + link('openFile', '打开', ok ? r.docx : (r.degraded || r.pdf))
            + link('openFolder', '文件夹', ok ? r.docx : r.pdf)
            + '</div>';
        }).join('')
      : '<div class="fill">'
        + '<div style="font-size:14px;font-weight:600">还没有转换记录</div>'
        + '<div class="f-dim">转过的每一份都会记在这儿，关掉软件也还在</div>'
        + '</div>';

    // 失败那行的完整报错藏在 title 里 —— 不说的话没人会想到去悬停。
    var tip = rows.length
      ? '<div class="note f-dim">共 ' + rows.length
        + ' 份 · 鼠标停在失败那行上能看完整报错</div>'
      : '';

    return shell(btn('backMain', '← 返回')
                 + '<span class="grow"></span>'
                 + '<span class="f-dim">最近 ' + rows.length + ' 条</span>',
                 errBar(st) + tip + body, '');
  }

  // ── 关于 ─────────────────────────────────────────────────────────────
  //
  // 版本号取 /api/env 的 version（打包时写进 version.json，没打包过就是
  // 「(未知)」）。sha 后端没给，想显示得先在 /api/env 里加字段。
  function aboutView(st) {
    var ver = (st.env && st.env.version) || '(未知)';
    var rows = LICENSES.map(function (x) {
      return '<span style="display:inline-block;min-width:120px">'
        + esc(x[0]) + ' <span class="f-dim">' + esc(x[1]) + '</span></span>';
    }).join('');
    return shell(
      btn('backMain', '← 返回') + '<span class="grow"></span>'
        + '<span class="f-dim">关于</span>',
      '<div class="fill" style="justify-content:flex-start;'
        + 'padding-top:16px;gap:10px">'
        + '<div style="font-size:15px;font-weight:600">PDF 转 Word · 云端版</div>'
        + '<div class="f-dim mono">' + esc(ver) + '</div>'
        + '<div class="f-dim" style="line-height:1.8;text-align:left">'
        + '作者　终末诗篇<br>'
        + '许可　GPL-3.0-or-later<br>'
        + '项目　github.com/kiryusento2017/teach-studio'
        + '</div>'
        + '<div class="f-dim" style="max-width:94%;text-align:left;'
        + 'line-height:1.9;font-size:11px">'
        + '本软件用到了以下开源组件：<br>' + rows
        + '<br><br>公式转成 Word 原生公式用的 <span class="mono">MML2OMML.XSL</span>'
        + '，版权归 Microsoft 所有，随 Office 分发。'
        + '</div></div>',
      '');
  }

  window.P2W_PAGES = { main: mainPage, history: historyPage,
                       settings: settingsPage, about: aboutView,
                       update: updatePage };
})();
