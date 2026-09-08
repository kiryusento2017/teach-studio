# -*- coding: utf-8 -*-
r"""落盘的三样东西：API token（两个）、每天的页数记账、转换历史。

## 🔴 token 的存放规矩

存在 `logs/token.json`，而 `logs/` 在 `.gitignore` 里。**它是凭据，
绝不能进版本库、绝不能进安装包、绝不能写进日志或诊断文件。**

不加密 —— 加密要有密钥，密钥又得存在同一台机器上，等于把锁挂在门上。
真正的边界是文件系统权限：软件装在用户自己的目录里，能读这个文件的人
本来就能读他所有的东西。**但「不加密」不等于「可以到处抄」**：
显示时一律打码（见 `masked`），日志和报错里一个字符都不许出现。

## 历史

跟 `pdf_to_word` 的 `maint.note_run` 同一个形状，但砍掉了那边的
`note_error`（那个函数在老项目里**零调用点**，诊断里「最近一次错误」
永远是空的 —— 见老项目台账第四十二节。这里不重复那个错误：
不做就不做，不留一个没人调的空壳）。
"""
import hashlib
import io
import json
import os
import time

import paths

TOKEN_FILE = os.path.join(paths.LOGS, 'token.json')
USAGE_FILE = os.path.join(paths.LOGS, 'usage.json')
RUNS_FILE = os.path.join(paths.LOGS, 'runs.json')

# 能存几个 token —— **不设固定栏数**（作者 2026-09-08 改定）。
#
# 为什么要多个：mineru 一个手机号注册一个号、微信再注册一个，号与号之间
# 额度独立。攒几个号，每天可用的页数就翻几倍。
#
# 原来是「先在设置里选几栏、再往栏里填」，多一层概念，还会冒出「空栏」
# 这种既不算有 token 也不算没有的中间态。现在**栏数就是 token 数**：
# 界面上一个「+ 添加」，每一栏自己带「换」和「删」。
#
# 🔴 `MAX_TOKENS` 不是功能限制，是**防手滑的天花板**。每个 token 都得去
#    mineru 注册一个账号，正常人不会有 50 个；留这个数是万一哪天代码出
#    bug 往里塞，不至于把 token.json 撑爆、把设置页卡死。
MAX_TOKENS = 50

# 一个号一天的额度。**作者 2026-09-08 从后台确认，两条是分开算的：**
#
#     文件解析个数   5000 个/天   ← 硬上限，撞了报 -60018「每日任务数量已达上限」
#     优先解析页数   1000 页/天   ← 软上限，超了**不是不给用**，是排队降优先级
#
# 这解释了为什么那个错误码叫「任务**数量**已达上限」而不是页数。
#
# 记账记的是页数（`DAILY_PAGES`），因为它才是实际会碰到的那条：一份讲义
# 二三十页，五十份就到 1000 了；而 5000 个文件正常人一天传不完。
#
# 🔴 页数这条是**软**的 —— 所以这个数**只用来挑号**（同样一份文件优先
#    给用得少的那个），**绝不用来拦人**。超了照样能转，只是慢。真到顶了
#    以服务端返回的错误码为准。
DAILY_PAGES = 1000

# 文件个数那条硬上限。**目前不记账** —— 一天 5000 个文件，正常用法碰不到，
# 为它维护一份账不值。真撞上了 -60018 会被 `mark_exhausted` 兜住：
# 那个号当天记满、排到最后，自动换下一个。
DAILY_FILES = 5000

# 每条历史带完整路径和完整报错，不设上限会越滚越大。跟老项目取同一个数。
RUNS_KEEP = 200


def _read(path, fallback):
    try:
        with io.open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


def _write(path, obj):
    r"""**永不抛异常** —— 记账不能把转换搞崩。写不进去就算了。"""
    try:
        paths.ensure(os.path.dirname(path))
        with io.open(path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(obj, ensure_ascii=False, indent=2))
        return True
    except Exception:
        return False


# ── token ──────────────────────────────────────────────────────────────

def _raw():
    d = _read(TOKEN_FILE, {})
    return d if isinstance(d, dict) else {}


def all_tokens():
    r"""存着的全部 token，按界面上的先后顺序。**不含空串。**

    兼容两种老格式，都不做迁移写回（下次增删改时自然就写成新格式了，
    没必要为了改格式去动用户的凭据文件）：

        {"token": "sk-x"}                     最早，只能存一个
        {"slots": 3, "tokens": ["a","","c"]}  中间那版，有固定栏数和空栏

    中间那版的空栏在这里被滤掉 —— 现在没有「空栏」这个概念了。
    """
    d = _raw()
    raw = d.get('tokens')
    if not isinstance(raw, list):
        raw = [d.get('token') or '']          # 最早那版
    out = [(x or '').strip() if isinstance(x, str) else '' for x in raw]
    return [t for t in out if t]


def token_count():
    """现在有几个 token。"""
    return len(all_tokens())


def usable_tokens():
    """能用来转换的那些。现在等同于 `all_tokens()`（不存空串了）。

    名字留着 —— 调度那边一直调的是这个，改名要动好几处，
    而这个名字本身说的就是它的用途。
    """
    return all_tokens()


def _save_tokens(rows):
    """落盘。一个都不剩就把文件删掉，别留个空壳。"""
    rows = [t for t in rows if t]
    if not rows:
        try:
            os.remove(TOKEN_FILE)
        except OSError:
            pass
        return True
    return _write(TOKEN_FILE, {'tokens': rows})


def add_token(tok):
    """在末尾添一个。返回 (成功, 说明)。"""
    tok = (tok or '').strip()
    if not tok:
        return False, '没填内容'
    rows = all_tokens()
    if tok in rows:
        return False, '这个 token 已经是第 %d 个了' % (rows.index(tok) + 1)
    if len(rows) >= MAX_TOKENS:
        return False, '最多 %d 个' % MAX_TOKENS
    rows.append(tok)
    return _save_tokens(rows), ''


def set_token_slot(i, tok):
    """换掉第 i 个。传空串等于**删掉这一个**，后面的往前挪。"""
    rows = all_tokens()
    if not (0 <= i < len(rows)):
        return False
    tok = (tok or '').strip()
    if not tok:
        del rows[i]
    else:
        rows[i] = tok
    return _save_tokens(rows)


def remove_token(i):
    """删掉第 i 个。"""
    return set_token_slot(i, '')


def get_token():
    """第一个能用的 token。一个都没有就是空串。

    留着是因为「有没有配过 token」这个判断到处在用，语义正好。
    """
    t = usable_tokens()
    return t[0] if t else ''


def set_token(tok):
    """只留这一个 token（有几个删几个）。老调用点和测试还在用。"""
    tok = (tok or '').strip()
    return _save_tokens([tok] if tok else [])


def masked(tok=None):
    r"""给界面看的打码版：`sk-abcd...wxyz1234`。

    🔴 **任何要显示、要写日志、要进报错的地方都只能用这个**，
    不许把原文带出这个模块以外（除了真正发请求那一处）。
    """
    t = tok if tok is not None else get_token()
    if not t:
        return ''
    if len(t) <= 12:
        return t[:2] + '***'
    return '%s...%s' % (t[:7], t[-8:])


# ── 每天用掉多少页 ─────────────────────────────────────────────────────
#
# 为什么要记这个：mineru **没有查额度的接口**（2026-09-08 翻遍官方文档）。
# 想在两个号之间挑一个，只能自己记。
#
# 🔴 **这个数一定偏小。** 只记通过本软件转掉的页数 —— 用户自己在 mineru
#    网页上传的、用别的工具调同一个 token 的，这里无从知道。所以它是
#    「至少用了这么多」，只配用来挑号，不配用来拦人。

def _fp(tok):
    r"""token 的指纹，12 位十六进制。

    🔴 **记账文件里存指纹，不存原文。** 它跟 token.json 一样躺在 logs/ 下，
       凭据只该出现在一个地方。指纹不可逆，泄露了也换不出 token。

    换了 token 指纹就变，旧账自然作废 —— 正好是想要的：新号该从零算起。
    """
    return hashlib.sha256((tok or '').encode('utf-8')).hexdigest()[:12]


def _today():
    r"""今天是几号（本地时区）。

    🔴 mineru 按哪个时区、几点整重置额度，2026-09-08 查不到。用本地日期
       是个近似，最坏情况是日切前后几小时算歪。歪了也不要紧 —— 真到顶了
       以服务端的错误码为准，这里只影响「先试哪个号」。
    """
    return time.strftime('%Y-%m-%d')


def usage_today():
    """今天的账：`{指纹: 页数}`。没有就是空字典。"""
    d = _read(USAGE_FILE, {})
    if not isinstance(d, dict):
        return {}
    day = d.get(_today())
    return day if isinstance(day, dict) else {}


def note_pages(tok, pages):
    r"""记一笔。**永不抛异常** —— 记账失败不能影响转换本身。

    只保留最近 7 天，免得这文件一年后变成几千行。
    """
    try:
        pages = int(pages or 0)
    except Exception:
        return False
    if not tok or pages <= 0:
        return False
    d = _read(USAGE_FILE, {})
    if not isinstance(d, dict):
        d = {}
    day = _today()
    if not isinstance(d.get(day), dict):
        d[day] = {}
    fp = _fp(tok)
    d[day][fp] = int(d[day].get(fp) or 0) + pages
    for k in sorted(d)[:-7]:
        d.pop(k, None)
    return _write(USAGE_FILE, d)


def mark_exhausted(tok):
    r"""服务端说这个号今天到顶了 —— 把账直接记满。

    为什么要这一下：一批文件里第一份撞了墙，后面每一份都还去撞一次，
    等于每份都白传一趟。记满之后 `pick_order` 自然把它排到最后。
    """
    used = used_today(tok)
    if used < DAILY_PAGES:
        note_pages(tok, DAILY_PAGES - used)
    return True


def used_today(tok):
    """这个号今天（经本软件）用掉多少页。"""
    return int(usage_today().get(_fp(tok)) or 0)


def left_today(tok):
    """还剩多少页。可能是负的 —— 负数照样能排序，不夹到 0。"""
    return DAILY_PAGES - used_today(tok)


def pick_order(pages=0, toks=None):
    r"""该按什么顺序试这些 token。

    规矩很简单：**今天用得少的排前面**。

    作者 2026-09-08 要的是「开转前先看本地账，够不够，不够就下一个」——
    那正是这个排序的效果。**没有单独写一层「够不够」的筛选**，因为它是
    冗余的：剩得多的号必然先够，所以「够的排前面」和「剩得多的排前面」
    排出来永远是同一个顺序，那一层判断一次都不会改变结果。

    作者问过的场景：1 号只剩 3 页、这份要 30 页 —— 一份 PDF **拆不开**
    （拆了出来是两份 Word，跨页的表格和公式会断在中间），只能整份挑一个号。
    2 号剩得多，自然排前面，连撞墙那一趟上传都省了。

    `pages` 留着不是为了排序，是为了让调用方能问一句「全都不够吗」——
    见 `all_short`。
    """
    toks = usable_tokens() if toks is None else [t for t in (toks or []) if t]
    if len(toks) <= 1:
        return toks
    return sorted(toks, key=lambda t: -left_today(t))


def all_short(pages, toks=None):
    r"""这些号今天剩的，**是不是一个都不够这一份**。

    🔴 **只用来提醒，不用来拦人。** 本地账只算得到经本软件用掉的量，天生
       偏小；官方措辞又是「超出部分优先级降低」，超额未必是硬拒绝、可能
       只是排队变慢。所以答案是「是」也照样上传试一次，真到顶了以服务端
       返回的错误码为准。
    """
    toks = usable_tokens() if toks is None else [t for t in (toks or []) if t]
    if not toks:
        return False
    try:
        pages = int(pages or 0)
    except Exception:
        return False
    if pages <= 0:
        return False
    return all(left_today(t) < pages for t in toks)


# ── 转换历史 ───────────────────────────────────────────────────────────

def runs(limit=None):
    r = _read(RUNS_FILE, [])
    if not isinstance(r, list):
        return []
    return r if limit is None else r[:limit]


def note_run(rep):
    r"""转完一份记一条。**永不抛异常。**

    存完整路径不脱敏 —— 出问题时路径本身常常就是病根（老项目那条教训）。
    但**不存 token**，一个字符都不存。
    """
    import time
    row = {
        'time': time.strftime('%Y-%m-%d %H:%M:%S'),
        'file': os.path.basename(rep.get('pdf') or ''),
        'pdf': rep.get('pdf') or '',
        'docx': rep.get('docx') or '',
        'ok': bool(rep.get('ok')),
        'pages': rep.get('pages') or 0,
        'formulas': '%s/%s' % (rep.get('formulas_xsl') or 0,
                               rep.get('formulas') or 0),
        'tables': rep.get('tables') or 0,
        'images': rep.get('images') or 0,
        'error': (rep.get('error') or '')[:120],
        'error_full': rep.get('error') or '',
        'degraded': rep.get('degraded') or '',
    }
    rows = runs()
    rows.insert(0, row)
    del rows[RUNS_KEEP:]
    return _write(RUNS_FILE, rows)
