# -*- coding: utf-8 -*-
r"""一份 PDF → 一份 Word。把三步串起来的编排层。

    probe       看一眼：几页、能不能打开、哪几页没有文字层
      ↓
    mineru_api  传给 MinerU 云端解析（**唯一联网的一步**）
      ↓
    todocx      出 Word：公式走自带的 MML2OMML.XSL（runtime/xsl/）

**编排层不做判断**，只负责串和汇总。每一步该报什么、降级到哪，都由那一步
自己决定 —— 这样每步都能单独测，编排层也能整体 mock 掉三步来测。

**不抛异常**：一份书失败不能带倒整批（用户常常一次拖进来一整个文件夹）。

## 跟 pdf_to_word 那版的差别

砍掉的：

    on_progress          云端只有 pending/running/done，没有细粒度进度，
                         那一整套两轮识别的阶段名、pass1_sec/pass2_sec/
                         elements、stages 全部没有意义（作者 2026-09-08：
                         「那就不要进度条和倒计时」）
    torchdep.explain_…   本地版用它把 WinError 1114 翻成人话，云端没有 dll
    cached               本地版有识别结果缓存桶，云端每次都是新任务

留下的：体检 → 解析 → 出 Word 这个骨架，以及 `summary_line` 一字未改。
"""
import probe
import mineru_api
import store
import todocx


def pdf_to_word(pdf, out_docx, work_dir, token, on_log=None,
                prefer_xsl=True, stop_flag=None, **kw):
    r"""转一份。返回汇总报告，**不抛异常**。

    `on_log(一行字)` 是给界面看的粗粒度进度（已上传 / 云端状态 / 已下载），
    **不是百分比** —— 云端给不出百分比。
    """
    rep = {'ok': False, 'error': '', 'cancelled': False,
           'pdf': pdf, 'docx': out_docx,
           'pages': 0, 'scan_pages': [], 'formulas': 0, 'formulas_xsl': 0,
           'tables': 0, 'images': 0, 'math_engine': '', 'math_note': '',
           'auto_dir': '', 'degraded': '', 'details_dropped': 0,
           'token_used': '', 'all_quota_used': False, 'quota_warn': False}

    # ── ① 体检 ────────────────────────────────────────────────────────
    p = probe.probe_pdf(pdf)
    if not p['ok']:
        rep['error'] = p['error']
        return rep
    rep['pages'] = p['pages']
    rep['scan_pages'] = p['scan_pages']

    # 🔴 **页数上限在这儿拦，不要等传完再被服务端拒。** 一份 600 页的 PDF
    #    可能有几十上百 MB，传上去再被退回来，用户白等一趟还看不懂报错。
    if rep['pages'] > mineru_api.MAX_PAGES:
        rep['error'] = ('这份 %d 页，超过云端单次 %d 页的上限。'
                        '拆成几份再转。'
                        % (rep['pages'], mineru_api.MAX_PAGES))
        return rep

    # ── ② 云端解析（多个 token 依次试）────────────────────────────────
    #
    # 🔴 **一份 PDF 拆不开。** 30 页的讲义不能 3 页给 1 号、27 页给 2 号 ——
    #    拆了出来是两份 Word，跨页的表格和公式会断在中间。所以只能整份
    #    挑一个号，挑法见 `store.pick_order`（今天用得少的排前面）。
    #
    # 只有**额度到顶**才换号重来。别的失败（文件坏了、服务异常、网络断）
    # 换个号一样失败，重试只是白传一趟。
    toks = [token] if isinstance(token, str) else [t for t in (token or []) if t]
    toks = [t for t in toks if t]
    if not toks:
        rep['error'] = '还没填 MinerU 的 token'
        return rep

    # 🔴 **挑号放在 probe 之后**，因为要先知道这一份多少页
    #    （见 store.pick_order）。
    toks = store.pick_order(rep['pages'], toks)
    # 开转前看一眼本地账。**只提醒不拦** —— 本地账偏小，超额也未必是硬拒绝。
    if store.all_short(rep['pages'], toks):
        rep['quota_warn'] = True
        if on_log:
            on_log('提醒：按本地记的账，%d 个号今天剩的都不够这份 %d 页；'
                   '还是试一下 —— 本地账只算得到本软件用掉的量，偏小'
                   % (len(toks), rep['pages']))

    for i, tok in enumerate(toks):
        e = mineru_api.run(pdf, work_dir, tok, on_log=on_log, stop_flag=stop_flag)
        rep['token_used'] = store.masked(tok)     # 🔴 只留打码版
        if e.get('submitted'):
            store.note_pages(tok, rep['pages'])   # 交出去就扣了，记上
        if e.get('ok') or e.get('cancelled') or not e.get('quota'):
            break
        # 到这儿说明：这个号今天满了
        store.mark_exhausted(tok)
        if i + 1 < len(toks):
            if on_log:
                on_log('第 %d 个 token 今天的额度用完了，换下一个再试' % (i + 1))
        else:
            rep['all_quota_used'] = True

    if e.get('cancelled'):
        rep['error'] = '已停止'
        rep['cancelled'] = True
        return rep
    if not e['ok']:
        rep['error'] = e['error']
        if rep.get('all_quota_used'):
            rep['error'] = ('%d 个 token 今天的额度都用完了，明天再转。'
                            '（服务端原话：%s）' % (len(toks), e['error']))
        return rep
    rep['auto_dir'] = e['auto_dir']

    # ── ③ 出 Word ─────────────────────────────────────────────────────
    d = todocx.md_to_docx(e['md'], out_docx, prefer_xsl=prefer_xsl,
                          resource_path=e['auto_dir'])
    if not d['ok']:
        rep['error'] = d['error']
        # 判失败不等于没有产物。次品改了名留在原地，路径带给界面 ——
        # 云端那一趟已经花掉了额度，不该让人两手空空。
        rep['degraded'] = d.get('degraded', '')
        return rep

    rep['formulas'] = d['formulas_src']
    rep['formulas_xsl'] = d['formulas_replaced']
    rep['tables'] = d['tables']
    rep['images'] = d['images']
    rep['math_engine'] = d['math_engine']
    rep['math_note'] = d['math_note']
    # 图里的文字被拦下了几处 —— 转换报告要照实说一句，不能悄悄删。
    rep['details_dropped'] = d.get('details_dropped', 0)
    rep['ok'] = True
    return rep


def summary_line(rep):
    """一行人话，给界面和命令行共用。"""
    if not rep['ok']:
        return '失败：%s' % rep['error'][:120]
    bits = ['%d 页' % rep['pages'],
            '公式 %d' % rep['formulas'],
            '表格 %d' % rep['tables'],
            '图 %d' % rep['images']]
    # 🔴 **一个公式都没有的时候，别提公式引擎。** 老项目这里是无脑
    #    `if xsl else Pandoc`，于是一份纯文字讲义会显示「公式 0 ｜ 公式走
    #    Pandoc」—— 用户看到「Pandoc」会以为走了次等路径（那是本地版
    #    2026-09-01 明确废弃的降级路），实际上根本没有公式要转。
    #    2026-09-08 真实端到端跑出来的。
    if rep['formulas']:
        bits.append('公式是 Word 原生公式' if rep['math_engine'] == 'xsl'
                    else '公式走 Pandoc')
    # 有公式没转成就说出来。以前这个事实只写进 math_note，而
    # summary_line 不读它、前端 0 处引用 —— 等于写进了没人看的字段。
    miss = (rep.get('formulas') or 0) - (rep.get('formulas_xsl') or 0)
    if miss > 0:
        bits.append('%d 个公式没转成' % miss)
    if rep['scan_pages']:
        n = len(rep['scan_pages'])
        bits.append('第 %s 页无文字层%s'
                    % (','.join(str(x) for x in rep['scan_pages'][:4]),
                       ' 等 %d 页' % n if n > 4 else ''))
    return ' ｜ '.join(bits)
