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
                   + '把整个文件夹挪到 D 盘之类的地方，再打开。' };
    }
    if (!e.node || !e.node.ok || !e.pandoc || !e.pandoc.ok) {
      var miss = [];
      if (!e.node || !e.node.ok) miss.push('node');
      if (!e.pandoc || !e.pandoc.ok) miss.push('pandoc');
      return { title: '安装包不完整',
               body: '缺少 ' + miss.join(' 和 ') + '。这两个本该跟软件一起'
                   + '打包，缺了多半是杀毒软件删过文件。重新解压一次安装包。' };
    }
    return null;
  }

  function gateView(g) {
    return '<div class="fill">'
      + '<div style="font-size:14px;font-weight:600">' + esc(g.title) + '</div>'
      + '<div class="f-dim" style="max-width:460px;line-height:1.6">'
      + esc(g.body) + '</div></div>';
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
            + esc(r.pending ? '没测完'
                 : (r.ok ? (r.ms + ' 毫秒' + (r.used ? '（用的这条）' : ''))
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

  function updateBlock(st) {
    var u = st.upd;
    var t = st.updTask;
    var head = '<div class="it"><span class="grow f-dim">软件更新</span>';

    // ① 正在下载 / 安装
    if (t && (t.state === 'downloading' || t.state === 'installing')) {
      var pct = (t.total ? Math.floor(t.got * 100 / t.total) : 0);
      var what = t.state === 'installing' ? '正在安装…'
               : (t.step === 'probing' ? '正在挑最快的线路（要一两秒）…'
                                       : '正在下载 ' + pct + '%');
      return head + '</div><div class="it">' + dot(C.run)
        + '<span class="grow">' + esc(what) + '</span>'
        + (t.via ? '<span class="rt f-dim">' + esc(t.via) + '</span>' : '')
        + '</div>';
    }

    // ② 装好了，等重启
    if (t && t.state === 'done') {
      return head + '</div><div class="it">' + dot(C.ok)
        + '<span class="grow">更新完成，换了 ' + (t.files || 0) + ' 个文件</span>'
        + btn('restartApp', '重启软件', { cls: 'primary' }) + '</div>'
        + '<div class="it"><span class="f-dim">必须重启才生效 —— '
        + '当前进程跑的还是加载时的那份旧代码。</span></div>';
    }

    // ③ 拿不到校验值，问用户
    if (t && t.state === 'need_confirm') {
      return head + '</div><div class="it">' + dot(C.bad)
        + '<span class="grow ell">没法验证这个更新包</span></div>'
        + '<div class="it"><span class="f-dim" style="line-height:1.6">'
        + esc(t.error || '') + '</span></div>'
        + '<div class="it"><span class="grow"></span>'
        + btn('updateAnyway', '知道风险，继续更新')
        + btn('checkUpdate', '算了') + '</div>';
    }

    // ④ 下载/安装失败
    if (t && t.state === 'error') {
      return head + '</div><div class="it">' + dot(C.bad)
        + '<span class="grow ell">' + esc(t.error || '更新失败') + '</span>'
        + btn('checkUpdate', '重来') + '</div>' + updLines(st);
    }

    // ⑤ 还没查 / 正在查
    if (st.updBusy) {
      return head + link('checkUpdate', '正在问 GitHub…', '', true) + '</div>';
    }
    if (!u) {
      return head + btn('checkUpdate', '检查更新') + '</div>'
        + '<div class="it"><span class="f-dim">当前版本 '
        + esc((st.env && st.env.version) || '(未知)') + '</span></div>';
    }

    // ⑥ 查过了
    var line;
    if (u.has_update) {
      line = '<div class="it">' + dot(C.run)
        + '<span class="grow">有新版本 ' + esc(u.latest || '') + '</span>'
        + (u.published ? '<span class="rt f-dim">'
                         + esc(String(u.published).slice(0, 10)) + '</span>' : '')
        + btn('startUpdate', '立即更新', { cls: 'primary' }) + '</div>';
    } else if (u.need_full) {
      line = '<div class="it">' + dot(C.bad)
        + '<span class="grow ell">' + esc(u.error || '') + '</span></div>';
    } else if (u.error) {
      line = '<div class="it">' + dot(C.bad)
        + '<span class="grow ell">' + esc(u.error) + '</span>'
        + btn('checkUpdate', '再试一次') + '</div>';
    } else {
      line = '<div class="it">' + dot(C.ok)
        + '<span class="grow">已经是最新的（' + esc(u.local || '') + '）</span>'
        + btn('checkUpdate', '再查一次') + '</div>';
    }
    return head + '</div>' + line + updNotes(st) + updLines(st);
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
      + updateBlock(st);

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
    var note = sp.length
      ? ('第 ' + sp.slice(0, 3).join('、') + ' 页没有文字层'
         + (sp.length > 3 ? ' 等 ' + sp.length + ' 页' : ''))
      : '';
    return '<div class="it" title="' + esc(x.path) + '">'
      + '<input type="checkbox" data-check="' + esc(x.path) + '"'
      + (st.picked[x.path] ? ' checked' : '') + '>'
      + '<span class="grow ell">' + esc(name) + '</span>'
      + (note ? '<span class="rt ell" style="max-width:220px">'
                + esc(note) + '</span>' : '')
      + '<span class="rt">' + (x.pages || 0) + ' 页</span>'
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

  function reportText(t) {
    var L = ['这份清单只列出「可能要人看一眼」的地方。',
             '没列出来的不代表一定对，只代表软件没发现问题。', ''];
    (t.results || []).forEach(function (r) {
      var name = base(r.pdf || r.docx || '');
      if (!r.ok) {
        L.push('✗ ' + name);
        L.push('    ' + (r.error || '没说原因'));
        if (r.degraded) L.push('    次品留在：' + r.degraded);
        return;
      }
      var bits = [];
      var miss = (r.formulas || 0) - (r.formulas_xsl || 0);
      if (miss > 0) bits.push('有 ' + miss + ' 个公式没转成，保留了 LaTeX 原文');
      var sp = r.scan_pages || [];
      if (sp.length) bits.push('第 ' + sp.join('、') + ' 页没有文字层');
      if (r.details_dropped) {
        bits.push('删掉了 ' + r.details_dropped + ' 处从图里抠出来的散字');
      }
      if (bits.length) {
        L.push('· ' + name);
        bits.forEach(function (b) { L.push('    ' + b); });
      }
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
      + link('pickOutDir', '更改')
      + (st.outDir ? link('useSourceDir', '还原') : '');

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

    var sel = st.items.filter(function (x) { return x.ok && st.picked[x.path]; });
    return shell(top,
      errBar(st) + st.items.map(function (x) { return itemRow(x, st); }).join(''),
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
      return x.ok && st.picked[x.path];
    }).map(function (it, i) {
      var r = byPath[it.path];
      if (r) return runRow(r, it);
      if (!done && i === t.current) {
        // 正在转的那一份：把云端最后一句状态显示在右边
        return '<div class="it on" title="' + esc(it.path) + '">' + dot(C.run)
          + '<span class="grow ell">' + esc(base(it.path)) + '</span>'
          + '<span class="rt ell" style="max-width:300px">'
          + esc((t.lines || []).slice(-1)[0] || '正在处理…')
          + '</span></div>';
      }
      // 还没轮到
      return '<div class="it" title="' + esc(it.path) + '">' + dot(C.dim)
        + '<span class="grow ell f-dim">' + esc(base(it.path)) + '</span>'
        + '<span class="rt f-dim">' + (it.pages || 0) + ' 页 · 等着</span>'
        + '</div>';
    }).join('');

    var top = done
      ? '<span style="font-size:13px;font-weight:600">'
        + (t.state === 'cancelled' ? '已停止' : '转换完成') + '</span>'
        + '<span class="f-dim" style="margin-left:8px">'
        + okN + ' 成 / ' + t.total + ' 份</span>'
        + '<span class="grow"></span>'
        + (worthReport(t) ? btn('toggleReport',
            st.showReport ? '返回列表' : '看报告') : '')
        + btn('newBatch', '再转一批', { cls: 'primary' })
      : '<span style="font-size:13px;font-weight:600">正在转第 '
        + ((t.current || 0) + 1) + ' / ' + t.total + ' 份</span>'
        + '<span class="grow"></span>'
        + '<span class="f-dim ell" style="max-width:240px">'
        + '云端在跑，「停止」只是不再等它</span>'
        + btn('stop', '停止');

    var bot = dot(done ? (okN === t.total ? C.ok : C.bad) : C.run)
      + '<span class="f-dim">' + esc(done ? '转完了' : (t.now || '准备中…'))
      + '</span>'
      + link('openSettings', '设置') + link('openHistory', '历史')
      + '<span class="grow"></span>';

    // 报告：本批
    if (done && st.showReport) {
      return shell(top, reportView(reportText(t)), bot);
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
    var g = gate(st);
    if (g) return shell('', errBar(st) + gateView(g), '');

    var hasTok = !!(st.env && st.env.token && st.env.token.ok);
    if (!hasTok) {
      return shell('', errBar(st) + tokenView(st),
                   link('openSettings', '设置') + link('openHistory', '历史'));
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
      : '<div class="fill"><div class="f-dim">还没转过东西</div></div>';

    return shell(btn('backMain', '← 返回')
                 + '<span class="grow"></span>'
                 + '<span class="f-dim">最近 ' + rows.length + ' 条</span>',
                 errBar(st) + body, '');
  }

  window.P2W_PAGES = { main: mainPage, history: historyPage,
                       settings: settingsPage };
})();
