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

  function slotRow(x, i, st) {
    var no = '第 ' + (i + 1) + ' 个';
    if (st.editSlot === i) {
      return '<div class="it">'
        + '<span class="f-dim" style="flex:none;width:52px">' + no + '</span>'
        + '<input id="tokenbox" type="text" spellcheck="false" '
        + 'placeholder="粘贴 token，按回车保存" '
        + 'style="flex:1;padding:4px 6px;font-family:Consolas,monospace">'
        + btn('saveSlot', st.tokenBusy ? '正在验…' : '保存',
              { cls: 'primary', off: st.tokenBusy })
        + btn('cancelSlot', '取消', { off: st.tokenBusy })
        + '</div>';
    }
    if (!x.has) {
      return '<div class="it">'
        + '<span class="f-dim" style="flex:none;width:52px">' + no + '</span>'
        + '<span class="grow f-dim">还没填</span>'
        + link('editSlot', '填这个', String(i)) + '</div>';
    }
    return '<div class="it">'
      + dot(C.ok)
      + '<span class="f-dim" style="flex:none;width:44px">' + no + '</span>'
      + '<span class="grow ell" style="font-family:Consolas,monospace">'
      + esc(x.masked) + '</span>'
      + '<span class="rt">今天用了 ' + (x.used || 0) + ' 页</span>'
      + link('editSlot', '换', String(i))
      + link('clearSlot', '删', String(i)) + '</div>';
  }

  function slotPicker(cur, max) {
    var o = '';
    for (var i = 1; i <= max; i++) {
      o += '<option value="' + i + '"' + (i === cur ? ' selected' : '')
        + '>' + i + '</option>';
    }
    return '<select data-slots style="padding:3px 6px">' + o + '</select>';
  }

  function guideText(n) {
    return ['想要更多额度就多注册几个号 —— 一个手机号能注册一个账号，微信也能',
            '单独注册一个，每个号的每日额度分开算。',
            '',
            '1. 打开 ' + TOKEN_URL,
            '   （点右上角「复制地址」，再粘到浏览器里）',
            '2. 用手机号注册登录，在这个页面创建一个 API token，复制出来',
            '3. 退出登录，改用微信注册第二个号，同样创建一个 token',
            '4. 把它们分别填进上面的 ' + n + ' 个栏位',
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
    var tk = e.tokens || { slots: 1, max_slots: 10, list: [] };
    var list = tk.list || [];
    var n = tk.slots || list.length || 1;

    var body = '<div class="it">'
      + '<span class="grow">token 栏数量</span>'
      + slotPicker(n, tk.max_slots || 10)
      + '<span class="f-dim" style="margin-left:8px">最多 '
      + (tk.max_slots || 10) + ' 个</span></div>'
      + list.map(function (x, i) { return slotRow(x, i, st); }).join('')
      + '<div class="it"><span class="grow f-dim">注册指南</span>'
      + link('copyTokenUrl', st.copied ? '已复制' : '复制地址') + '</div>'
      + '<div class="log" data-keep-scroll="guide"><span class="l">'
      + esc(guideText(n)).split(chr10()).join('</span><span class="l">')
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
  function resultRow(r) {
    var ok = !!r.ok;
    return '<div class="it" title="' + esc(ok ? r.docx : (r.error || '')) + '">'
      + dot(ok ? C.ok : C.bad)
      + '<span class="grow ell">' + esc(base(r.pdf)) + '</span>'
      + '<span class="rt ell" style="max-width:300px">'
      + esc(r.line || '') + '</span>'
      + (ok
          ? link('openFile', '打开', r.docx) + link('openFolder', '文件夹', r.docx)
          : (r.degraded ? link('openFile', '打开次品', r.degraded) : ''))
      + '</div>';
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

    var t = st.task;
    var running = window.P2W_ISRUNNING(st);
    var done = !!(t && (t.state === 'done' || t.state === 'cancelled'));

    // 🔴 **转换进行中也给「添加文件」**（作者要的双队列）。但**不给
    //    「更改输出目录」** —— 追加的文件跟着原来那一批的目录走，
    //    这里改了也不生效，摆个改不动的按钮比没有更糟。
    var top;
    if (done) {
      top = '';
    } else if (running) {
      top = btn('pickFiles', '添加文件') + btn('pickDir', '添加文件夹')
        + '<span class="grow"></span>'
        + '<span class="f-dim">转换中，新加的会排在后面</span>';
    } else {
      top = btn('pickFiles', '添加文件') + btn('pickDir', '添加文件夹')
        + btn('clearAll', '移除全部', { off: !st.items.length })
        + '<span class="grow"></span>'
        + '<span class="f-dim ell" style="max-width:260px">输出：'
        + esc(st.outDir || '跟原 PDF 放一起') + '</span>'
        + link('pickOutDir', '更改')
        + (st.outDir ? link('useSourceDir', '还原') : '');
    }

    var body;
    if (done && st.showReport) {
      // 🔴 返回按钮放在报告**前面**。老项目放后面，而内容区高度是
      //    min-height:100%，按钮被挤到屏幕外，用户被困在报告页出不来。
      body = '<div class="fill" style="justify-content:flex-start;gap:6px">'
        + '<div style="align-self:flex-start">'
        + btn('toggleReport', '← 返回列表') + '</div>'
        + '<div class="log" data-keep-scroll="report"><span class="l">'
        + esc(reportText(t)).split(chr10()).join('</span><span class="l">')
        + '</span></div></div>';
    } else if (running || done) {
      body = (t.results || []).map(resultRow).join('')
        + (running
            ? '<div class="it">' + dot(C.run)
              + '<span class="grow ell">' + esc(t.now || '准备中…') + '</span>'
              + '<span class="rt ell" style="max-width:320px">'
              + esc((t.lines || []).slice(-1)[0] || '正在处理…')
              + '</span></div>'
              // 已经排上队、还没轮到的
              + (t.queued || []).map(function (nm) {
                  return '<div class="it">' + dot(C.dim)
                    + '<span class="grow ell f-dim">' + esc(nm) + '</span>'
                    + '<span class="rt f-dim">排队中</span></div>';
                }).join('')
              // 刚拖进来、还没点「加入队列」的
              + st.items.map(function (x) { return itemRow(x, st); }).join('')
              + (st.scanning
                  ? '<div class="it"><span class="grow f-dim">正在看新拖进来的…</span></div>'
                  : '')
            : '');
    } else if (!st.items.length) {
      body = '<div class="fill">'
        + '<div style="font-size:13px">把 PDF 拖进来</div>'
        + '<div class="f-dim">或者点左上角「添加文件」</div>'
        + (st.scanning ? '<div class="f-dim">正在看这些文件…</div>' : '')
        + '</div>';
    } else {
      body = st.items.map(function (x) { return itemRow(x, st); }).join('')
        + (st.scanning
            ? '<div class="it"><span class="grow f-dim">正在看新拖进来的…</span></div>'
            : '');
    }

    var bot;
    if (running) {
      var waiting = (t.queued || []).length;
      var newSel = st.items.filter(function (x) {
        return x.ok && st.picked[x.path];
      });
      bot = dot(C.run)
        + '<span>正在转第 ' + ((t.current || 0) + 1) + ' 份，共 ' + t.total + ' 份'
        + (waiting ? '（还有 ' + waiting + ' 份排队）' : '') + '</span>'
        + '<span class="grow"></span>'
        + (newSel.length
            ? btn('appendQueue',
                  st.starting ? '正在加…' : '把选中的 ' + newSel.length + ' 份加进队列',
                  { cls: 'primary', off: st.starting })
            : '<span class="f-dim ell" style="max-width:230px">'
              + '云端在跑，停止只是不再等它</span>')
        + btn('stop', '停止');
    } else if (done) {
      var okn = (t.results || []).filter(function (r) { return r.ok; }).length;
      bot = dot(okn === t.total ? C.ok : C.bad)
        + '<span>转完了：' + okn + ' 成 / ' + t.total + ' 份'
        + (t.state === 'cancelled' ? '（中途停了）' : '') + '</span>'
        + '<span class="grow"></span>'
        + (worthReport(t) && !st.showReport ? btn('toggleReport', '看报告') : '')
        + btn('newBatch', '转下一批', { cls: 'primary' });
    } else {
      var sel = st.items.filter(function (x) {
        return x.ok && st.picked[x.path];
      });
      var pg = sel.reduce(function (a, x) { return a + (x.pages || 0); }, 0);
      var tks = (st.env && st.env.tokens) || { list: [] };
      var nTok = (tks.list || []).filter(function (x) { return x.has; }).length;
      var usedAll = (tks.list || []).reduce(function (a, x) {
        return a + (x.used || 0);
      }, 0);
      bot = dot(C.ok)
        + '<span class="f-dim">' + nTok + ' 个 token'
        + (usedAll ? ' · 今天已用 ' + usedAll + ' 页' : '') + '</span>'
        + link('openSettings', '设置') + link('openHistory', '历史')
        + '<span class="grow"></span>'
        + '<span class="f-dim">选中 ' + sel.length + ' 份 · ' + pg + ' 页</span>'
        + btn('start', st.starting ? '正在开始…' : '开始转换',
              { cls: 'primary', off: !sel.length || st.starting });
    }

    return shell(top, errBar(st) + body, bot);
  }

  // ── 历史屏 ───────────────────────────────────────────────────────────
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
