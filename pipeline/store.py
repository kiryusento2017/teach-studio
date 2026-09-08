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

# 能存几个 token —— **用户自己在设置里定，1 到 10 个**（作者 2026-09-08 定）。
#
# 为什么要多个：mineru 一个手机号注册一个号、微信再注册一个，号与号之间
# 额度独立。攒几个号，每天可用的页数就翻几倍。
#
# 上限 10 是拍的，不是技术限制 —— 再多这个设置页就没法看了，而且真需要
# 十几个号的量级早该去买官方套餐，不该靠攒小号。
DEFAULT_SLOTS = 2
MAX_SLOTS = 10

# 一个号一天有多少页「最高优先级」额度。
#
# 🔴 **这个数字没有 100% 确认。** 官方文档写的是 1000 页，而且措辞是
#    「超过的部分优先级降低」，听起来超了不是不给用、只是排队变慢；
#    但错误码表里又有 -60018「每日任务数量已达上限」那种硬拒绝。
#    到底哪个说了算，2026-09-08 还没实测出来。
#
#    所以这个数**只用来挑号**（同样一份文件优先给用得少的那个），
#    **绝不用来拦人** —— 真的到顶了以服务端返回的错误码为准。
#    数字偏大偏小都不会导致转换失败，最多是多撞一次墙。
DAILY_PAGES = 1000

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
    r"""文件里存着的**全部** token，不按当前槽位数截断。

    调小槽位数时多出来的那几个就藏在这儿 —— 见 `set_slot_count`。
    查重必须用这个而不是 `token_slots()`，理由见那边。
    """
    d = _raw()
    raw = d.get('tokens')
    if not isinstance(raw, list):
        raw = [d.get('token') or '']          # 老格式
    return [(x or '').strip() if isinstance(x, str) else '' for x in raw]


def slot_count():
    r"""现在开着几个槽。范围 1~`MAX_SLOTS`，没设过就是 `DEFAULT_SLOTS`。

    存坏了（有人手改了文件、写了 0 或者 "abc"）一律回落到默认值，
    **不抛异常** —— 设置文件坏掉不该让整个软件打不开。
    """
    try:
        n = int(_raw().get('slots') or DEFAULT_SLOTS)
    except Exception:
        return DEFAULT_SLOTS
    return max(1, min(n, MAX_SLOTS))


def set_slot_count(n):
    r"""改槽位数。

    🔴 **调小不会丢 token。** 多出来的原样留在文件里，只是不显示、也不
       参与调度；调回去又出现。

       为什么这么设计：本来打算调小就截断，那就必须在界面上弹一句
       「这会删掉第 3、4 个 token，确定吗」。用户填 token 是件麻烦事
       （要去网站复制），为了省一次误删，多存几行字算便宜的。
    """
    try:
        n = int(n)
    except Exception:
        return False
    n = max(1, min(n, MAX_SLOTS))

    # 🔴 **填过的一律往前排，空栏留在后面。**
    #
    #    不这么做会出一件很吓人的事：用户第 1 栏空着、token 填在第 2 栏，
    #    他把栏数调到 1 —— 前 1 栏正好是那个空的，`usable_tokens()` 当场
    #    变空，软件退回「还没填 token」那一屏。token 其实还在文件里，
    #    但用户看到的就是「我的 token 没了」。
    #
    #    紧凑排列之后，减栏只会挤掉**多出来的**号，不会挤掉唯一那个。
    filled = [t for t in all_tokens() if t]
    keep = filled + [''] * max(0, n - len(filled))
    return _write(TOKEN_FILE, {'slots': n, 'tokens': keep})


def token_slots():
    r"""每个槽的原文，长度等于 `slot_count()`，没填的位置是空串。

    **兼容老格式**：早先存的是 `{"token": "sk-x"}`（只有一个），
    读到那种就当成 0 号槽。不做迁移写回 —— 用户下次改任何一个槽时
    自然就写成新格式了，没必要为了改个格式去动他的凭据文件。
    """
    n = slot_count()
    out = all_tokens()
    return (out + [''] * n)[:n]


def usable_tokens():
    """去掉空槽，按槽位顺序返回。一个都没填就是空列表。"""
    return [t for t in token_slots() if t]


def set_token_slot(i, tok):
    r"""写第 i 个槽。传空串等于清掉这一个（别的槽不动）。

    🔴 写回时带上**藏起来的那些**（槽位数调小时留下的），
       否则填一次 token 就把它们抹了。
    """
    n = slot_count()
    if not (0 <= i < n):
        return False
    all_ = all_tokens()
    all_ = all_ + [''] * max(0, n - len(all_))
    all_[i] = (tok or '').strip()
    if not any(all_):
        try:
            os.remove(TOKEN_FILE)
        except OSError:
            pass
        return True
    return _write(TOKEN_FILE, {'slots': n, 'tokens': all_})


def get_token():
    """第一个能用的 token。一个都没有就是空串。

    留着是因为「有没有配过 token」这个判断到处在用，语义正好。
    """
    t = usable_tokens()
    return t[0] if t else ''


def set_token(tok):
    """写 0 号槽。老调用点和测试还在用。"""
    return set_token_slot(0, tok)


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
