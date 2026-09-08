# -*- coding: utf-8 -*-
r"""MinerU 云端解析。**这是本项目唯一的新代码**，其余都是从
`pdf_to_word` 搬过来的。

## 它替掉的是什么

老项目里这一步是 `extract.py`（496 行）：起 MinerU 子进程、解析 stdout
拿进度、杀进程树、管缓存桶。这里换成四次 HTTP，**返回同样的东西**：

    {'ok': True, 'md': '<某个 .md 的路径>', 'auto_dir': '<含 images/ 的目录>', ...}

下游 `todocx` 只认这两个字段，所以它完全不知道前面换了人 —— 2026-09-08
实测：云端产物直接喂进去，公式 2/2 转成 Word 原生对象、表格带边框、
图片按尺寸还原，`todocx` 一行没改。

## 四步

    ① POST /api/v4/file-urls/batch          申请 OSS 上传位，拿 batch_id
    ② PUT  <签名位>                          把 PDF 传上去
    ③ GET  /api/v4/extract-results/batch/…  轮询到 state=done
    ④ GET  full_zip_url → 解压              得到 full.md + images/

## 🔴 三个实测踩出来的坑

**一、第 ② 步的 PUT 绝对不能带 `Content-Type`。** OSS 的签名里没有这一
项，带了就对不上，返回 403 且报文是空的。`urllib` 在有 body 时会**自动**
加一个 `application/x-www-form-urlencoded` —— 所以这里用 `requests`，
它不自作主张。（2026-09-08 就是这么撞出 403 的。）

**二、云端的 markdown 叫 `full.md`，不是 `<原名>.md`。** 所以找产物只能
按后缀扫，不能拼名字。老项目的 `extract` 本来就是这么写的
（`[f for f in os.listdir(d) if f.endswith('.md')]`），照抄。

**三、`state` 有 `done` / `failed` 两个终态，还有 `pending` / `running`
两个中间态。** 没有细粒度进度 —— 云端只告诉你在跑，不告诉你跑到哪。
所以这个项目没有进度条和倒计时（作者 2026-09-08 拍板：不要）。
"""
import io
import json
import hashlib
import json
import os
import shutil
import time
import zipfile

import requests

import paths

BASE = 'https://mineru.net/api/v4'

# ── 提交参数 ───────────────────────────────────────────────────────────
#
# 🔴 **提成常量是为了让它们能进缓存指纹。** 改了任何一个，指纹就变，
#    旧缓存自动失效、重新解析 —— 不用另写一套「缓存失效」逻辑
#    （本地版 extract.py 同一个做法）。
MODEL_VERSION = 'vlm'
LANGUAGE = 'ch'
ENABLE_FORMULA = True
ENABLE_TABLE = True

# 🔴 **必须开 OCR。** 本地版 docs/DESIGN.md 第二节的实测表
# （同一份 PDF 跑三种模式）：
#
#     模式   正文字符  行内公式
#     txt     10187      131
#     auto    10187      131
#     ocr      8972      213   ← 多 82 个
#
# 原因是**文字层里没有公式**：原文那句「已知不等式 [空] 的解集为」
# 中间就是空的，不 OCR 就直接放弃，OCR 才把那些图形化的公式识别成
# LaTeX。多花 40 秒换 82 个公式，值。
#
# 这个参数在服务端默认是 false —— 2026-09-08 之前这里就是 false，
# 作者拿同一份讲义两版对比，云端比本地少 30% 公式、少 78% 表格，正是这条。
IS_OCR = True

# 单次提交的硬上限，来自官方文档。超了在体检那步就拦下来，
# 不要等传完 200 MB 才被服务端拒绝。
MAX_PAGES = 600
MAX_BYTES = 200 * 1024 * 1024

# 轮询节奏。云端没有进度，只能问「好了没」——问太勤是白耗对方的限流额度，
# 问太稀用户干等。4 秒是实测那份 2 页 PDF 一次就 done 的基础上定的折中。
POLL_EVERY = 4.0
POLL_LIMIT = 900          # 最多等 60 分钟（600 页按官方上限算，够了）


# 额度/频次到顶的错误码。撞上这些**不该报给用户**，该换另一个 token 重来。
#
#   -60018  每日任务数量已达上限
#   -60019  HTML 解析额度不足
#
# 🔴 这两个码抄自官方错误码表（2026-09-08）。**没实测过** —— 要把一个号
#    刷到超额才撞得出来，那得烧掉一整天的额度。所以上层不能只认这两个码：
#    换号重试失败之后仍要把原始 msg 原样报给用户，别把未知错误吞掉。
QUOTA_CODES = (-60018, -60019)


class ApiError(Exception):
    """API 明确告诉我们出错了（带 code 和 msg），不是网络问题。

    `code` 留着给上层判断「这是不是额度到顶」—— 只看 msg 字符串去匹配
    中文提示，服务端改一版文案就失灵了。
    """

    def __init__(self, msg, code=None):
        Exception.__init__(self, msg)
        self.code = code


def _headers(token):
    return {'Authorization': 'Bearer %s' % token,
            'Content-Type': 'application/json'}

def _check(j):
    r"""API 的统一信封：`{code, msg, data}`。code 非 0 就是它明确报错。

    🔴 **HTTP 200 不等于成功。** 2026-09-08 实测：拿一个不存在的 task_id
    去查，返回的是 `HTTP 200 {"code":-60012,"msg":"task not found"}`。
    只看状态码的话会把错误当成功。
    """
    if not isinstance(j, dict):
        raise ApiError('返回的不是 JSON 对象')
    if j.get('code') not in (0, None):
        raise ApiError('%s（code %s）' % (j.get('msg') or '没说原因', j.get('code')),
                       code=j.get('code'))
    return j.get('data') or {}


def check_token(token, timeout=20):
    r"""这个 token 能不能用。返回 (能不能, 说明)。

    办法是拿一个**必然不存在**的 task_id 去查：

      · token 不对 → HTTP 401 `user authenticate failed`
      · token 对   → HTTP 200 `code -60012 task not found`

    后者说明身份过了，只是那个任务不存在 —— 正是我们想要的信号。
    **不消耗解析额度**，所以可以在用户填完 token 时当场验。
    """
    if not (token or '').strip():
        return False, '还没填 token'
    try:
        r = requests.get(BASE + '/extract/task/probe-does-not-exist',
                         headers=_headers(token), timeout=timeout)
    except Exception as e:
        return False, '连不上 mineru.net：%s' % type(e).__name__
    if r.status_code == 401:
        return False, 'token 不对（服务端说身份验证失败）'
    if r.status_code != 200:
        return False, '服务端返回 HTTP %s' % r.status_code
    try:
        code = r.json().get('code')
    except Exception:
        return False, '返回的不是 JSON'
    # -60012 = 任务不存在，正是我们要的：身份过了
    if code in (0, -60012):
        return True, ''
    return False, '服务端说：%s' % (r.json().get('msg') or code)


def _submit(pdf, token, on_log=None):
    """申请上传位并把文件传上去。返回 batch_id。"""
    name = os.path.basename(pdf)
    r = requests.post(BASE + '/file-urls/batch', headers=_headers(token),
                      timeout=60, json={
                          'enable_formula': ENABLE_FORMULA,
                          'enable_table': ENABLE_TABLE,
                          'model_version': MODEL_VERSION,
                          'language': LANGUAGE,
                          'files': [{'name': name, 'is_ocr': IS_OCR}],
                      })
    if r.status_code == 401:
        raise ApiError('token 不对')
    d = _check(r.json())
    urls = d.get('file_urls') or []
    if not d.get('batch_id') or not urls:
        raise ApiError('服务端没给上传地址')
    if on_log:
        on_log('已申请上传位')

    with io.open(pdf, 'rb') as f:
        blob = f.read()
    # 🔴 不带任何 header —— 见模块开头第一条
    up = requests.put(urls[0], data=blob, timeout=1800)
    if up.status_code != 200:
        raise ApiError('上传失败（HTTP %s）' % up.status_code)
    if on_log:
        on_log('已上传 %.1f MB' % (len(blob) / 1024.0 / 1024.0))
    return d['batch_id']


def _wait(batch_id, token, on_log=None, stop_flag=None):
    """轮询到出结果。返回 full_zip_url。"""
    last = ''
    for i in range(POLL_LIMIT):
        if stop_flag and stop_flag():
            raise ApiError('已停止')
        time.sleep(POLL_EVERY if i else 1.0)
        try:
            r = requests.get(BASE + '/extract-results/batch/' + batch_id,
                             headers=_headers(token), timeout=60)
            rows = (_check(r.json()).get('extract_result') or [])
        except ApiError:
            raise
        except Exception as e:
            # 网络抖一下不算数，下一轮还会问
            if on_log:
                on_log('查询失败，重试：%s' % type(e).__name__)
            continue
        if not rows:
            continue
        row = rows[0]
        st = row.get('state') or ''
        if st != last:
            last = st
            if on_log:
                on_log('云端状态：%s' % st)
        if st == 'done':
            url = row.get('full_zip_url')
            if not url:
                raise ApiError('服务端说完成了，却没给结果地址')
            return url
        if st == 'failed':
            raise ApiError(row.get('err_msg') or '云端解析失败')
    raise ApiError('等了太久（超过 %d 分钟）云端还没出结果'
                   % int(POLL_LIMIT * POLL_EVERY / 60))


def _fetch(zip_url, out_dir, on_log=None):
    r"""下载结果 zip 并解压。返回 (md 路径, 产物目录)。

    解压前**先清空目标目录** —— 同一份 PDF 重转时，上一次的 `images/`
    还留着的话，`todocx` 缩放图片那步会去动一批已经不属于这次结果的文件。
    """
    shutil.rmtree(out_dir, ignore_errors=True)
    paths.ensure(out_dir)
    raw = requests.get(zip_url, timeout=1800).content
    if on_log:
        on_log('已下载结果 %.1f KB' % (len(raw) / 1024.0))
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        # 🔴 zip slip：压缩包里的成员名可能是 `../../x`。**先全查一遍再解压**，
        #    任何一个越界就整包不要 —— 半解压出去的东西比不解压更难收拾。
        #    （老项目 update.py 的同一道防护，照搬。）
        root = os.path.abspath(out_dir)
        for n in z.namelist():
            p = os.path.abspath(os.path.join(root, n))
            if p != root and not p.startswith(root + os.sep):
                raise ApiError('结果包里有越界的路径，没有解压：%s' % n[:60])
        z.extractall(out_dir)

    mds = [f for f in os.listdir(out_dir) if f.lower().endswith('.md')]
    if not mds:
        raise ApiError('结果包里没有 .md 文件')
    return os.path.join(out_dir, mds[0]), out_dir


# ── 产物缓存 ───────────────────────────────────────────────────────────
#
# 同一份 PDF 用同一组参数转第二次，没道理再传一遍、再扣一次额度。
# 产物按**内容指纹**分桶：
#
#     _tmp/cache/<指纹16位>/full.md
#                          images/
#                          .fingerprint.json
#
# 指纹 = sha256(PDF 内容) + 提交参数。
#
# 🔴 **不能按文件名分桶。** 两份不同内容的「讲义.pdf」会落在同一个位置
#    互相覆盖；你把 PDF 改了重新导出、名字没变，也会拿到旧产物 ——
#    那种错最难查，因为界面上一切正常。（本地版原话，同一条教训。）
#
# 🔴 **命中缓存不算「提交过」**，所以 convert 那边不会记账 ——
#    没传给服务端，自然没扣额度。这一点比本地版更要紧：那边省的是
#    四分钟 GPU，这边省的是真金白银的页数。
CACHE_DIR = os.path.join(paths.TMP, 'cache')
CACHE_DAYS = 10
FP_NAME = '.fingerprint.json'


def fingerprint(pdf):
    """这份 PDF + 这组提交参数的唯一标识（16 位十六进制）。

    分块读，几十 MB 的 PDF 也只占 1 MB 内存、几十毫秒 —— 相对于一趟
    上传加云端解析可以忽略。
    """
    h = hashlib.sha256()
    with io.open(pdf, 'rb') as f:
        while True:
            blk = f.read(1024 * 1024)
            if not blk:
                break
            h.update(blk)
    tail = '|%s|%s|%s|%s|%s' % (MODEL_VERSION, LANGUAGE, IS_OCR,
                                ENABLE_FORMULA, ENABLE_TABLE)
    h.update(tail.encode('utf-8'))
    return h.hexdigest()[:16]


def _cache_hit(bucket):
    """这个桶里有没有能用的产物。返回 md 路径，没有就是空串。"""
    if not os.path.isfile(os.path.join(bucket, FP_NAME)):
        return ''
    try:
        names = os.listdir(bucket)
    except OSError:
        return ''
    for n in names:
        if n.lower().endswith('.md'):
            return os.path.join(bucket, n)
    return ''


def _cache_note(bucket, pdf, fp):
    """记下这个桶是怎么来的。写不成不影响转换，只是下次不认这个桶。"""
    try:
        with io.open(os.path.join(bucket, FP_NAME), 'w', encoding='utf-8') as f:
            json.dump({'fp': fp, 'pdf': os.path.basename(pdf),
                       'params': {'model_version': MODEL_VERSION,
                                  'language': LANGUAGE, 'is_ocr': IS_OCR,
                                  'enable_formula': ENABLE_FORMULA,
                                  'enable_table': ENABLE_TABLE},
                       'at': time.strftime('%Y-%m-%d %H:%M:%S')},
                      f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def purge_cache(days=CACHE_DAYS):
    """清掉好久没碰过的桶。**永不抛异常** —— 清理失败不该影响转换。"""
    try:
        if not os.path.isdir(CACHE_DIR):
            return 0
        cut = time.time() - days * 86400
        n = 0
        for name in os.listdir(CACHE_DIR):
            d = os.path.join(CACHE_DIR, name)
            try:
                if os.path.isdir(d) and os.path.getmtime(d) < cut:
                    shutil.rmtree(d, ignore_errors=True)
                    n += 1
            except OSError:
                continue
        return n
    except Exception:
        return 0


def run(pdf, out_dir, token, on_log=None, stop_flag=None):
    r"""解析一份 PDF。**不抛异常** —— 一份失败不能带倒整批。

    返回的字段刻意跟老项目 `extract.run` 对齐，下游一个字都不用改：

        ok / error / md / auto_dir / cancelled

    `stop_flag` 只能在**轮询阶段**生效：任务一旦提交出去就在云端跑着，
    我们停的是「等」，不是「算」，额度照扣。这一点跟本地版
    （`taskkill /T /F` 当场杀掉）有本质区别，界面上不要承诺能停。
    """
    rep = {'ok': False, 'error': '', 'md': '', 'auto_dir': '', 'cancelled': False,
           'code': None, 'quota': False, 'submitted': False, 'cached': False}
    try:
        if not os.path.isfile(pdf):
            rep['error'] = '文件不见了'
            return rep

        # ── 先看缓存 ──────────────────────────────────────────────────
        # 顺手清掉太老的桶。清理失败自己吞掉，不影响转换。
        purge_cache()
        fp = fingerprint(pdf)
        bucket = os.path.join(CACHE_DIR, fp)
        md = _cache_hit(bucket)
        if md:
            # 🔴 **不上传、不扣额度。** submitted 保持 False，
            #    convert 那边就不会记账 —— 因为确实没消耗。
            if on_log:
                on_log('这份转过（内容和参数都没变），直接用上次的结果，'
                       '不占额度')
            rep['ok'], rep['md'], rep['auto_dir'] = True, md, bucket
            rep['cached'] = True
            return rep

        size = os.path.getsize(pdf)
        if size > MAX_BYTES:
            rep['error'] = ('这份 %.0f MB，超过云端单次 %d MB 的上限'
                            % (size / 1024.0 / 1024.0, MAX_BYTES // 1024 // 1024))
            return rep
        bid = _submit(pdf, token, on_log=on_log)
        # 🔴 **交出去就扣额度了**，后面失败、超时、用户点停止都不退。
        #    上层靠这个标记记账 —— 只有连提交都没成功才不算数。
        rep['submitted'] = True
        url = _wait(bid, token, on_log=on_log, stop_flag=stop_flag)
        # 🔴 **解压进缓存桶，不是任务目录。** 下次同一份文件直接命中，
        #    不用再传一趟、再扣一次额度。
        md, auto = _fetch(url, bucket, on_log=on_log)
        _cache_note(bucket, pdf, fp)
        rep['ok'], rep['md'], rep['auto_dir'] = True, md, auto
        return rep
    except ApiError as e:
        msg = str(e)
        rep['error'] = msg
        rep['code'] = getattr(e, 'code', None)
        rep['quota'] = rep['code'] in QUOTA_CODES
        rep['cancelled'] = (msg == '已停止')
        return rep
    except Exception as e:
        rep['error'] = '%s: %s' % (type(e).__name__, str(e)[:160])
        return rep
