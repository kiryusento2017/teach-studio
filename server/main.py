# -*- coding: utf-8 -*-
r"""本地 HTTP 服务。绑 127.0.0.1，端口由系统分配。

**老项目那份是 1730 行，这份不到 400。** 砍掉的全是云端版不存在的东西：
模型下载、GPU 运行库、C++ 运行库、依赖升级与备份回滚、磁盘清理、
诊断文件、自动更新、下载源测速。

## 🔴 主动避开老项目审查出来的坑（2026-09-08 三个 agent 查出三十余条）

**一、任务表淘汰只淘汰终态。** 老项目那条互斥判据是
`any(t['state']=='running')`，淘汰时若把 running 的挤掉，互斥就漏了。

**二、轮询返回要深拷贝 `lines` / `results`。** 老项目返回的是
`dict(t, ...)` 浅拷贝，序列化发生在锁**外**，而工作线程同时在
`del t['lines'][0:n]` —— 输出会被截断。这里在锁内就拷好。

**三、忙碌判据只写一处。** 老项目同一条规则抄在四个地方，其中一处漏了
后来新增的字典（`_UPGI`），于是清理能删掉正在安装的 wheel。
这里只有 `_busy()` 一个函数，谁要判都调它。

**四、不留「做好了没人调」的东西。** 老项目有五处功能写完、接口通了、
前端一个字都没引用。这份里每个接口都有前端调用点，没有备用品。
"""
import io
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'pipeline'))

import uvicorn                                        # noqa: E402
from fastapi import FastAPI                           # noqa: E402
from fastapi.responses import JSONResponse            # noqa: E402
from pydantic import BaseModel                        # noqa: E402

import convert                                        # noqa: E402
import mineru_api                                     # noqa: E402
import paths                                          # noqa: E402
import probe                                          # noqa: E402
import store
import update                                          # noqa: E402
import todocx                                         # noqa: E402
import tomath                                         # noqa: E402

app = FastAPI(title='PDF 转 Word（云端版）')

_LOCK = threading.Lock()
_TASKS = {}
# 只留最近几个**已结束**的任务。转一批就是一条，不清理会一直涨。
_TASKS_KEEP = 5


def _busy():
    """现在有没有正在跑的转换。**判忙只有这一个入口。**"""
    return any(t.get('state') == 'running' for t in _TASKS.values())


# ── 环境自检 ───────────────────────────────────────────────────────────

@app.get('/api/env')
def env():
    r"""开机自检。云端版要查这几样：

      node            跑 KaTeX 把 LaTeX 转 MathML
      pandoc          生成 docx 骨架
      token           没有它什么都干不了
      writable        装在没写权限的地方就干不了活

    🔴 **不查 Office 了**（2026-09-08 作者定）。`MML2OMML.XSL` 现在随软件
       打包在 `runtime/xsl/`（见 `tomath.bundled_xsl`），用户不用装 Office，
       这里也就没什么可查的。万一那个文件被杀毒删了，转换时会带着说明
       失败，不在开机这一步拦人。

    🔴 **没有显卡检查、没有模型检查** —— 那是本地版的事。
    """
    node_ok = tomath.node_available()
    tok = store.get_token()
    return {
        # 这份发行版是哪个 Release。打包脚本写进 version.json；
        # 开发环境读不到就是 '(未知)'，界面照实显示，不瞎猜。
        'version': update.local_version().get('tag') or '(未知)',
        'node': {'ok': bool(node_ok)},
        'pandoc': {'ok': todocx.pandoc_available()},
        'token': {'ok': bool(tok), 'masked': store.masked(tok)},
        # 每个 token 的状态。**只给打码版和用量**，原文永远不出后端。
        'tokens': {
            'count': store.token_count(),
            'max': store.MAX_TOKENS,
            'daily_pages': store.DAILY_PAGES,
            'list': [{'masked': store.masked(t),
                      'used': store.used_today(t)}
                     for t in store.all_tokens()],
        },
        'writable': os.access(ROOT, os.W_OK),
    }


# ── token ──────────────────────────────────────────────────────────────

class TokenReq(BaseModel):
    token: str = ''
    # 改第几个（从 0 数）。**-1 = 添加一个新的**，这是默认值 ——
    # 想不带 slot 就调用的话，语义是「加一个」，而不是「改第一个」。
    slot: int = -1


# 🔴 **这里本来还有一个 `GET /api/token`。删了。**
#
#    它能用、有测试、逻辑也对 —— 但前端一次都没调过，因为 token 的状态
#    在 `/api/env` 里已经给了。同一件事两个出口，其中一个从没被使用，
#    正是老项目那个「功能做好了、接口通了、没人按下那一下」的形状
#    （2026-09-08 在那边一口气查出五处）。
#
#    2026-09-08 建这个项目时自己也犯了一次，靠「把后端路由和前端调用点
#    对一遍」这道核实抓出来的。留着它就是留一个将来会和 /api/env 说法
#    不一致的隐患。


@app.post('/api/token')
def token_set(req: TokenReq):
    r"""存 token。**存之前先验一次** —— 验不过就不存。

    验的办法不消耗解析额度（拿一个不存在的 task_id 去查，看是 401 还是
    「任务不存在」），所以可以当场验，不用等用户转第一份才发现填错了。
    """
    i = int(req.slot)
    tok = (req.token or '').strip()
    n = store.token_count()

    # ── 删掉一个 ──────────────────────────────────────────────────────
    if not tok:
        if not (0 <= i < n):
            return JSONResponse({'detail': '没有第 %d 个 token' % (i + 1)},
                                status_code=400)
        store.remove_token(i)
        return {'ok': True, 'count': store.token_count()}

    # ── 换掉一个 / 添一个 ─────────────────────────────────────────────
    adding = (i < 0)
    if not adding and not (0 <= i < n):
        return JSONResponse({'detail': '没有第 %d 个 token' % (i + 1)},
                            status_code=400)

    # 🔴 **同一个 token 不许存两遍。** 存重了两条其实是一个号，
    #    调度会以为有双倍额度，撞墙撞两次才发现。
    for j, other in enumerate(store.all_tokens()):
        if j != i and other == tok:
            return JSONResponse(
                {'detail': '这个 token 已经是第 %d 个了' % (j + 1)},
                status_code=400)

    if adding and n >= store.MAX_TOKENS:
        return JSONResponse({'detail': '最多 %d 个' % store.MAX_TOKENS},
                            status_code=400)

    # 🔴 **存之前先验一次** —— 验不过不存，免得转到一半才发现填错了。
    #    验的办法不消耗解析额度（拿一个不存在的 task_id 去查，
    #    看是 401 还是「任务不存在」）。
    good, why = mineru_api.check_token(tok)
    if not good:
        return JSONResponse({'detail': why}, status_code=400)

    if adding:
        ok, why2 = store.add_token(tok)
        if not ok:
            return JSONResponse({'detail': why2}, status_code=400)
    else:
        store.set_token_slot(i, tok)
    return {'ok': True, 'count': store.token_count(),
            'masked': store.masked(tok)}


# ── 体检 ───────────────────────────────────────────────────────────────

class ScanReq(BaseModel):
    paths: list = []


@app.post('/api/scan')
def scan(req: ScanReq):
    """把拖进来的东西摊平成 PDF 清单并逐份体检。**纯读**，不写任何东西。"""
    pdfs = []
    for p in req.paths:
        if os.path.isdir(p):
            pdfs.extend(probe.scan_dir(p))
        elif p.lower().endswith('.pdf'):
            pdfs.append(p)
    seen, uniq = set(), []
    for p in pdfs:
        k = os.path.normcase(os.path.abspath(p))
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    items = probe.probe_many(uniq)
    # 页数超上限的在这儿就标出来，别等传完 200 MB 才被服务端退回来
    for it in items:
        if it.get('ok') and (it.get('pages') or 0) > mineru_api.MAX_PAGES:
            it['ok'] = False
            it['note'] = ('这份 %d 页，超过云端单次 %d 页上限'
                          % (it['pages'], mineru_api.MAX_PAGES))
    return {'items': items}


# ── 转换 ───────────────────────────────────────────────────────────────

class ConvertReq(BaseModel):
    paths: list = []
    out_dir: str = ''


def _work(task_id, out_dir):
    r"""后台线程：逐份转。一份失败不影响其余。

    **待转清单在任务表里**（`_TASKS[id]['paths']`），不是参数 —— 因为
    转换进行中用户还能往后面加（见 `/api/convert/{id}/append`）。

    🔴 **整体套一层兜底。** 这是后台线程，异常会被 Python 悄悄吞掉，
    任务就永远停在 running —— 界面转圈转到天荒地老，用户只会以为软件慢。
    （老项目实测撞见过：漏一个 import，四条测试全部等到超时才失败。）
    """
    try:
        _work_inner(task_id, out_dir)
    except Exception as e:
        with _LOCK:
            t = _TASKS.get(task_id)
            if t is not None:
                t['state'] = 'done'
                t['error'] = '%s: %s' % (type(e).__name__, str(e)[:200])


def _work_inner(task_id, out_dir):
    work_root = paths.ensure(os.path.join(paths.TMP, 'cloud', task_id))

    def stopped():
        with _LOCK:
            t = _TASKS.get(task_id)
            return bool(t and t.get('cancel'))

    i = 0
    while True:
        # 🔴 **「拿下一份」和「收工」必须在同一把锁里定下来。**
        #
        #    分开写就有这个缝：这边刚判完「没有下一份了」、还没来得及把
        #    state 改成 done，用户那边正好 append 进来一份 —— append 看到
        #    state 还是 running 就把文件塞进队列，然后这边收工退出。
        #    结果：队列里躺着一份永远没人转的文件，界面显示「转完了」。
        with _LOCK:
            t = _TASKS.get(task_id)
            if t is None:
                return
            if t.get('cancel'):
                t['state'] = 'cancelled'
                t['current'] = len(t['paths'])
                return
            if i >= len(t['paths']):
                t['state'] = 'done'
                t['current'] = len(t['paths'])
                return
            pdf = t['paths'][i]
            t['current'] = i
            t['total'] = len(t['paths'])
            t['now'] = os.path.basename(pdf)
            t['lines'] = []

        def on_log(s, _tid=task_id):
            with _LOCK:
                tt = _TASKS.get(_tid)
                if tt is None:
                    return
                tt['lines'].append(s)
                del tt['lines'][:-30]

        dest = out_dir or os.path.dirname(pdf)
        paths.ensure(dest)
        base = os.path.splitext(os.path.basename(pdf))[0]
        rep = convert.pdf_to_word(
            pdf, os.path.join(dest, base + '.docx'),
            os.path.join(work_root, '%03d' % i),
            # 🔴 **每一份都重新读一次可用 token**，不能在循环外算一次 ——
            #    上一份可能刚好把某个号用满了。真正的排序在 convert 里做，
            #    那边 probe 完才知道这一份多少页，才比得出「够不够」。
            store.usable_tokens(),
            on_log=on_log, stop_flag=stopped)
        rep['line'] = convert.summary_line(rep)
        store.note_run(rep)
        with _LOCK:
            t = _TASKS.get(task_id)
            if t is None:
                return
            t['results'].append(rep)
        i += 1


@app.post('/api/convert')
def start_convert(req: ConvertReq):
    pdfs = [p for p in (req.paths or []) if p.lower().endswith('.pdf')]
    if not pdfs:
        return JSONResponse({'detail': '没有可转的 PDF'}, status_code=400)
    if not store.get_token():
        return JSONResponse({'detail': '还没填 MinerU 的 token'}, status_code=400)

    with _LOCK:
        if _busy():
            return JSONResponse({'detail': '还有一批在转，等它转完'},
                                status_code=409)
        # 🔴 只淘汰**已结束**的。把 running 的挤掉会让上面那道互斥失效。
        done = [(k, v) for k, v in _TASKS.items()
                if v.get('state') in ('done', 'cancelled')]
        if len(done) > _TASKS_KEEP:
            done.sort(key=lambda kv: kv[1].get('started') or 0)
            for k, _v in done[:len(done) - _TASKS_KEEP]:
                _TASKS.pop(k, None)

        tid = '%d' % int(time.time() * 1000)
        _TASKS[tid] = {'state': 'running', 'started': time.time(),
                       'current': 0, 'total': len(pdfs), 'now': '',
                       'paths': list(pdfs),
                       'results': [], 'lines': [], 'error': '', 'cancel': False}

    threading.Thread(target=_work, args=(tid, req.out_dir or ''),
                     daemon=True).start()
    return {'ok': True, 'task_id': tid, 'total': len(pdfs)}


@app.post('/api/convert/{task_id}/append')
def append_convert(task_id: str, req: ConvertReq):
    r"""往正在转的那一批后面追加文件（作者 2026-09-08 要的「双队列」）。

    以前正转着就不让加，用户得干等一批转完。现在加进来的排在后面，
    当前这份转完自动接上去。

    🔴 **输出目录跟着原来那一批**，`req.out_dir` 不生效 —— 一批文件散落在
       两个目录里，用户回头找不着。想换目录就等这批转完再开一批。
    """
    pdfs = [p for p in (req.paths or []) if p.lower().endswith('.pdf')]
    if not pdfs:
        return JSONResponse({'detail': '没有可转的 PDF'}, status_code=400)
    with _LOCK:
        t = _TASKS.get(task_id)
        if t is None:
            return JSONResponse({'detail': '没有这个任务'}, status_code=404)
        if t.get('cancel'):
            return JSONResponse({'detail': '这一批正在停，加不进去了'},
                                status_code=409)
        if t.get('state') != 'running':
            return JSONResponse({'detail': '这一批已经转完了，直接开新的一批'},
                                status_code=409)
        # 队列里已经有的不重复加 —— 用户可能把同一批文件又拖了一次
        have = set(t['paths'])
        add = [p for p in pdfs if p not in have]
        t['paths'].extend(add)
        t['total'] = len(t['paths'])
        return {'ok': True, 'added': len(add), 'skipped': len(pdfs) - len(add),
                'total': t['total']}


@app.get('/api/convert/{task_id}')
def poll(task_id: str):
    r"""查进度。

    🔴 **在锁内就把 list 拷成新的。** 老项目返回 `dict(t, ...)` 是浅拷贝，
    真正序列化发生在锁**外**，而工作线程同时在 `del t['lines'][0:n]` ——
    结果是日志被截断，而前端所有 catch 都是静默的，界面上一点痕迹都没有。
    """
    with _LOCK:
        t = _TASKS.get(task_id)
        if t is None:
            return JSONResponse({'detail': '没有这个任务'}, status_code=404)
        # 还没轮到的那些（当前这份之后的），界面上要能看见排了几份
        # `.get` 不是 `[...]` —— 测试里会手搓任务条目，少一个键不该让查进度崩
        queued = [os.path.basename(p)
                  for p in (t.get('paths') or [])[t['current'] + 1:]]
        return {
            'state': t['state'], 'current': t['current'], 'total': t['total'],
            'now': t['now'], 'error': t['error'],
            'elapsed': int(time.time() - t['started']),
            'lines': list(t['lines']),
            'queued': queued,
            'results': [dict(r) for r in t['results']],
        }


@app.post('/api/convert/{task_id}/cancel')
def cancel(task_id: str):
    r"""停止。

    ⚠️ **停的是「等」，不是「算」。** 任务一旦提交出去就在 MinerU 那边跑，
    额度照扣。跟本地版 `taskkill /T /F` 当场杀掉有本质区别 ——
    界面上不要承诺「立刻停」。
    """
    with _LOCK:
        t = _TASKS.get(task_id)
        if t is None:
            return JSONResponse({'detail': '没有这个任务'}, status_code=404)
        t['cancel'] = True
    return {'ok': True}


# ── 检查更新 ───────────────────────────────────────────────────────────
#
# 整套逻辑在 pipeline/update.py，从本地版 pdf_to_word 搬来的（那边攒了
# 三轮实测：镜像会挂、会变、而且是双向地变，所以候选写一串、并发实测、
# 谁快用谁）。这里只是把它接到 HTTP 上。

_UPD = {'state': 'idle', 'got': 0, 'total': 0, 'error': '',
        'via': '', 'files': 0, 'step': ''}


@app.get('/api/update/check')
def check_update():
    r"""查有没有新版本。**由后端发请求，不是前端。**

    前端页面的 CSP 只放行 `connect-src http://127.0.0.1:*`；让前端直连
    GitHub 就得放宽 CSP —— 拿安全性换一个小功能不划算。走后端还能顺带
    做超时和错误兜底。

    写成 `def` 不是 `async def`：里面是同步的网络请求，会卡住事件循环。
    """
    return update.check()


class UpdateReq(BaseModel):
    # 界面上手动指定的线路 id（空 = 自动挑最快的）。它不是地址，
    # 只是一个在 GH_MIRRORS 里查表的键，查不到就回到自动。
    line: str = ''
    # 用户已经知道「拿不到官方校验值」并且选择继续。
    allow_unverified: bool = False


def _upd_work(prefer, allow_unverified):
    r"""后台线程：下载 → 安装。**整体套兜底**，异常吞掉就永远停在 running。"""
    try:
        _upd_inner(prefer, allow_unverified)
    except Exception as e:
        with _LOCK:
            _UPD.update({'state': 'error',
                         'error': '%s: %s' % (type(e).__name__, str(e)[:200])})


def _upd_inner(prefer, allow_unverified):
    def on_prog(got, total):
        with _LOCK:
            _UPD['got'], _UPD['total'] = got, total

    def on_phase(p):
        with _LOCK:
            _UPD['step'] = p

    # 🔴 **重新 check 一次，不信前端传来的地址。** 前端只能说「用哪条线路」，
    #    下载地址由后端自己去查 —— 否则页面上一个转义漏洞就能让软件去下
    #    任意 URL 的东西并解压覆盖到安装目录。
    info = update.check()
    asset = info.get('asset') or {}
    if not info.get('has_update') or not asset.get('url'):
        with _LOCK:
            _UPD.update({'state': 'error',
                         'error': info.get('error') or '没查到可下载的更新包'})
        return

    dest = os.path.join(paths.ensure(os.path.join(paths.TMP, 'update')),
                        asset.get('name') or 'update.zip')

    # 🔴 **故意不传 size。** probe_mirrors 有条「小包不测速」的捷径
    #    （<5 MB 直接返回 bps 全 0），更新包正好落在里面 —— 于是排序排了个
    #    寂寞，每次都用名单第一条，那条要是不通就干等满 30 秒超时。
    #    代价对比：多花 2 秒测速 vs 第一条不通干等 30 秒。测。
    ok, err, via = update.download(
        asset['url'], dest, on_progress=on_prog, digest=asset.get('digest', ''),
        allow_unverified=allow_unverified, prefer=prefer, on_phase=on_phase)

    if not ok and err.startswith('NEED_CONFIRM:'):
        # 拿不到校验值 —— **报警但不阻拦**，把情况透给界面让用户自己决定。
        with _LOCK:
            _UPD.update({'state': 'need_confirm', 'via': via,
                         'error': ('拿不到 GitHub 给的校验值，没法确认下回来的'
                                   '是不是原件。更新包会覆盖软件里的程序文件，'
                                   '所以这一步有风险。')})
        return
    if not ok:
        with _LOCK:
            _UPD.update({'state': 'error', 'error': err, 'via': via})
        return

    with _LOCK:
        _UPD.update({'state': 'installing', 'via': via})

    ok2, err2, n = update.apply_update(dest)
    with _LOCK:
        if ok2:
            _UPD.update({'state': 'done', 'error': '', 'files': n})
            # 装好了把包删掉，别在安装目录里留垃圾
            try:
                os.remove(dest)
                os.rmdir(os.path.dirname(dest))
            except Exception:
                pass
        else:
            _UPD.update({'state': 'error', 'files': n,
                         'error': '下载好了但安装失败：%s' % err2})


@app.post('/api/update/download')
def start_update(req: UpdateReq):
    r"""开始下载并安装更新。**转换进行中不许更新** —— 覆盖的是正在跑的
    那些 .py 文件，当前这批会转到一半崩掉。
    """
    with _LOCK:
        if _busy():
            return JSONResponse({'detail': '还有一批在转，转完再更新'},
                                status_code=409)
        if _UPD['state'] in ('downloading', 'installing'):
            return JSONResponse({'detail': '已经在更新了'}, status_code=409)
        _UPD.update({'state': 'downloading', 'got': 0, 'total': 0,
                     'error': '', 'via': '', 'files': 0, 'step': ''})
    threading.Thread(target=_upd_work,
                     args=(req.line or '', bool(req.allow_unverified)),
                     daemon=True).start()
    return {'ok': True}


@app.get('/api/update/download')
def update_status():
    with _LOCK:
        return dict(_UPD)


# ── 历史 ───────────────────────────────────────────────────────────────

@app.get('/api/runs')
def list_runs(limit: int = store.RUNS_KEEP):
    try:
        n = max(1, min(int(limit), store.RUNS_KEEP))
        return {'ok': True, 'rows': store.runs(n)}
    except Exception as e:
        return {'ok': False, 'rows': [],
                'error': '%s: %s' % (type(e).__name__, e)}


def main():
    cfg = uvicorn.Config(app, host='127.0.0.1', port=0, log_level='warning')
    server = uvicorn.Server(cfg)

    def announce():
        while not getattr(server, 'started', False):
            time.sleep(0.05)
        port = server.servers[0].sockets[0].getsockname()[1]
        print('PDF2WORD_PORT=%d' % port, flush=True)

    threading.Thread(target=announce, daemon=True).start()
    server.run()


if __name__ == '__main__':
    main()
