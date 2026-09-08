# -*- coding: utf-8 -*-
r"""后端接口与流水线。

用 FastAPI 的 TestClient，不真起端口。**不碰真实的 MinerU API** ——
凡是要联网的地方都 mock 掉，否则每跑一次测试就烧一次额度，而且没网就红。
只有一条标了 `_live` 的用例会真连，默认跳过。
"""
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'pipeline'))
sys.path.insert(0, os.path.join(ROOT, 'server'))

from fastapi.testclient import TestClient  # noqa: E402

import main as srv       # noqa: E402
import mineru_api        # noqa: E402
import store             # noqa: E402

client = TestClient(srv.app)


# ── 🔴 全局隔离：测试永不碰真实的 logs/ ────────────────────────────────
#
# 2026-09-08 栽过一次：有个测试类没隔离，直接操作真实的
# logs/token.json，而当天 `set_token` 的语义刚从「覆盖第一个」改成
# 「只留这一个」—— 跑一次测试就把用户的两个 token 覆盖成一个，
# 人家的 API 凭据没了。
#
# 靠「每个测试类自己记得隔离」是靠不住的：加新测试的人不一定知道这条
# 规矩，而漏了**不会报错**，只会安静地写坏真实文件。所以在模块级别兜住。
_REAL_STORE_PATHS = {}
_TEST_HOME = [None]


def setUpModule():
    _TEST_HOME[0] = tempfile.mkdtemp(prefix='p2w_tests_')
    for name in ('TOKEN_FILE', 'USAGE_FILE', 'RUNS_FILE'):
        _REAL_STORE_PATHS[name] = getattr(store, name)
        setattr(store, name,
                os.path.join(_TEST_HOME[0], name.lower() + '.json'))


def tearDownModule():
    for name, real in _REAL_STORE_PATHS.items():
        setattr(store, name, real)
    if _TEST_HOME[0]:
        shutil.rmtree(_TEST_HOME[0], ignore_errors=True)


class Test测试自身的隔离(unittest.TestCase):
    r"""护栏：确认测试真的没在碰真实文件。

    这条测试存在的理由就是上面那次事故 —— 那种破坏是**静默**的，
    不会有任何测试变红，只有用户下次打开软件发现 token 少了。
    """

    def test_三个落盘路径都指向临时目录(self):
        home = _TEST_HOME[0]
        self.assertTrue(home)
        for name in ('TOKEN_FILE', 'USAGE_FILE', 'RUNS_FILE'):
            p = os.path.abspath(getattr(store, name))
            self.assertTrue(p.startswith(os.path.abspath(home)),
                            '%s 指向 %s，不在临时目录里' % (name, p))

    def test_没指向项目里的logs目录(self):
        real_logs = os.path.abspath(os.path.join(ROOT, 'logs'))
        for name in ('TOKEN_FILE', 'USAGE_FILE', 'RUNS_FILE'):
            p = os.path.abspath(getattr(store, name))
            self.assertFalse(p.startswith(real_logs),
                             '%s 还指着真实的 logs/：%s' % (name, p))



def _pdf(path, pages=1, text='hello world enough characters'):
    import pymupdf
    d = pymupdf.open()
    for _ in range(pages):
        p = d.new_page()
        if text:
            p.insert_text((72, 100), text, fontsize=12)
    d.save(path)
    d.close()


class Test自带的XSL(unittest.TestCase):
    r"""「用户不用装 Office」这个承诺，**只能靠这几条验**。

    🔴 开发机装了 Office。什么都不做直接跑，`find_xsl()` 可能命中注册表
       那条路，测出来的「能用」是假的 —— 用户机器上没有那条路。所以下面
       第三条把注册表和候选目录**全堵死**，只留自带的那份。

    真正的确认还是得在没装 Office 的机器上跑一次（2026-09-08 还没打包，
    做不了）。这几条是打包之前能给出的最强证据。
    """

    def test_自带的XSL在打包位置上(self):
        import tomath
        p = tomath.bundled_xsl()
        self.assertTrue(p, 'runtime/xsl/MML2OMML.XSL 不见了，打出来的包会缺文件')
        self.assertTrue(os.path.isfile(p))

    def test_自带的优先于本机Office(self):
        r"""顺序不能反 —— 反了就变成「用开发机的 Office」，用户那边没有。"""
        import tomath
        self.assertEqual(tomath.find_xsl(), tomath.bundled_xsl())

    def test_把本机Office全堵死照样转得出公式(self):
        r"""这条是核心：模拟一台没装 Office 的机器。"""
        import unittest.mock as mock
        import tomath
        with mock.patch.object(tomath, 'registry_candidates', lambda: []),              mock.patch.object(tomath, 'XSL_CANDIDATES', []):
            self.assertEqual(tomath.find_xsl(), tomath.bundled_xsl())
            out = tomath.batch_to_omml([r'x^{2} + \frac{1}{2}'])
            self.assertEqual(len(out), 1)
            self.assertIsNotNone(out[0], '转不出来：' + tomath.last_error())


class Test环境自检(unittest.TestCase):

    def test_只查云端版真正需要的四样(self):
        r"""🔴 **没有显卡检查、没有模型检查。** 那是本地版的事，云端版查了
        只会把用户挡在一个跟他无关的门外。

        🔴 **也不查 Office**（2026-09-08 起 XSL 随软件打包）。这条断言是
        等号不是子集，多一个键就会红 —— 谁再把 office 加回来立刻知道。"""
        d = client.get('/api/env').json()
        self.assertEqual(set(d),
                         {'version', 'node', 'pandoc', 'token', 'tokens', 'writable'})

    def test_不把token原文吐给前端(self):
        r"""🔴 token 是凭据。接口只回打码版，原文永远不出后端进程。"""
        old = store.get_token()
        try:
            store.set_token('sk-abcdefghijklmnopqrstuvwxyz')
            d = client.get('/api/env').json()
            self.assertNotIn('abcdefghijkl', json.dumps(d))
            self.assertIn('...', d['token']['masked'])
        finally:
            store.set_token(old)


class Test体检(unittest.TestCase):

    def setUp(self):
        self.w = tempfile.mkdtemp(prefix='p2wc_')

    def tearDown(self):
        shutil.rmtree(self.w, ignore_errors=True)

    def test_能认出页数(self):
        p = os.path.join(self.w, 'a.pdf')
        _pdf(p, pages=3)
        d = client.post('/api/scan', json={'paths': [p]}).json()
        self.assertEqual(len(d['items']), 1)
        self.assertTrue(d['items'][0]['ok'])
        self.assertEqual(d['items'][0]['pages'], 3)

    def test_同一个文件拖两次只算一份(self):
        p = os.path.join(self.w, 'a.pdf')
        _pdf(p)
        d = client.post('/api/scan', json={'paths': [p, p]}).json()
        self.assertEqual(len(d['items']), 1)

    def test_超过云端页数上限的在体检就拦下(self):
        r"""🔴 **不能等传完 200 MB 再被服务端退回来。** 用户白等一趟，
        而且拿到的是服务端的英文报错，看不懂。"""
        p = os.path.join(self.w, 'big.pdf')
        _pdf(p, pages=2)
        old = mineru_api.MAX_PAGES
        mineru_api.MAX_PAGES = 1
        try:
            d = client.post('/api/scan', json={'paths': [p]}).json()
        finally:
            mineru_api.MAX_PAGES = old
        it = d['items'][0]
        self.assertFalse(it['ok'])
        self.assertIn('上限', it['note'])

    def test_文件夹会被摊平(self):
        for n in ('a.pdf', 'b.pdf'):
            _pdf(os.path.join(self.w, n))
        io.open(os.path.join(self.w, 'c.txt'), 'w').write('x')
        d = client.post('/api/scan', json={'paths': [self.w]}).json()
        self.assertEqual(len(d['items']), 2)



class Test转换(unittest.TestCase):

    def setUp(self):
        self.w = tempfile.mkdtemp(prefix='p2wc_')
        self._old_tok = store.get_token()
        self._old_run = srv.convert.pdf_to_word
        store.set_token('sk-test-token-abcdefgh')
        srv._TASKS.clear()

    def tearDown(self):
        srv.convert.pdf_to_word = self._old_run
        store.set_token(self._old_tok)
        srv._TASKS.clear()
        shutil.rmtree(self.w, ignore_errors=True)

    def _fake(self, ok=True, err=''):
        def f(pdf, out_docx, work_dir, token, on_log=None, **kw):
            if on_log:
                on_log('云端状态：running')
            return {'ok': ok, 'error': err, 'cancelled': False,
                    'pdf': pdf, 'docx': out_docx, 'pages': 3,
                    'scan_pages': [], 'formulas': 5, 'formulas_xsl': 5,
                    'tables': 1, 'images': 2, 'math_engine': 'xsl',
                    'math_note': '', 'auto_dir': '', 'degraded': '',
                    'details_dropped': 0}
        return f

    def _wait(self, tid, timeout=20):
        t0 = time.time()
        while time.time() - t0 < timeout:
            d = client.get('/api/convert/%s' % tid).json()
            if d['state'] in ('done', 'cancelled'):
                return d
            time.sleep(0.05)
        raise AssertionError('等超时了')

    def test_没token不许开转(self):
        store.set_token('')
        p = os.path.join(self.w, 'a.pdf')
        _pdf(p)
        r = client.post('/api/convert', json={'paths': [p]})
        self.assertEqual(r.status_code, 400)
        self.assertIn('token', r.json()['detail'])

    def test_转完能拿到结果和产物路径(self):
        srv.convert.pdf_to_word = self._fake()
        p = os.path.join(self.w, 'a.pdf')
        _pdf(p)
        r = client.post('/api/convert', json={'paths': [p], 'out_dir': self.w})
        d = self._wait(r.json()['task_id'])
        self.assertEqual(d['state'], 'done')
        self.assertEqual(len(d['results']), 1)
        self.assertTrue(d['results'][0]['ok'])
        self.assertIn('line', d['results'][0])

    def test_一份失败不影响其余(self):
        calls = []

        def mixed(pdf, out_docx, work_dir, token, on_log=None, **kw):
            calls.append(pdf)
            bad = pdf.endswith('b.pdf')
            f = self._fake(ok=not bad, err='云端解析失败' if bad else '')
            return f(pdf, out_docx, work_dir, token, on_log=on_log)

        srv.convert.pdf_to_word = mixed
        ps = []
        for n in ('a.pdf', 'b.pdf', 'c.pdf'):
            q = os.path.join(self.w, n)
            _pdf(q)
            ps.append(q)
        r = client.post('/api/convert', json={'paths': ps, 'out_dir': self.w})
        d = self._wait(r.json()['task_id'])
        self.assertEqual(len(calls), 3, '中间那份失败之后就不转了')
        self.assertEqual([x['ok'] for x in d['results']], [True, False, True])

    def test_还有一批在转就不许再开一批(self):
        r"""🔴 两批同时跑会抢同一个 token 的额度和同一个临时目录。"""
        import threading
        gate = threading.Event()

        def slow(pdf, out_docx, work_dir, token, on_log=None, **kw):
            gate.wait(10)
            return self._fake()(pdf, out_docx, work_dir, token)

        srv.convert.pdf_to_word = slow
        p = os.path.join(self.w, 'a.pdf')
        _pdf(p)
        r1 = client.post('/api/convert', json={'paths': [p], 'out_dir': self.w})
        self.assertEqual(r1.status_code, 200)
        r2 = client.post('/api/convert', json={'paths': [p], 'out_dir': self.w})
        self.assertEqual(r2.status_code, 409)
        gate.set()
        self._wait(r1.json()['task_id'])

    def test_查一个不存在的任务要给404(self):
        r"""🔴 必须是 404 而不是 200 —— 前端靠状态码决定要不要停轮询。
        老项目就是因为这条链断了，撞到 404 会每秒空转一次。"""
        r = client.get('/api/convert/nope')
        self.assertEqual(r.status_code, 404)

    def test_任务表只留最近几个已结束的(self):
        srv.convert.pdf_to_word = self._fake()
        p = os.path.join(self.w, 'a.pdf')
        _pdf(p)
        for _ in range(srv._TASKS_KEEP + 3):
            r = client.post('/api/convert', json={'paths': [p], 'out_dir': self.w})
            self._wait(r.json()['task_id'])
        self.assertLessEqual(len(srv._TASKS), srv._TASKS_KEEP + 1)

    def test_淘汰不许碰正在跑的(self):
        r"""🔴 「还有一批在转吗」这道互斥判据靠的就是任务表里那条 running
        记录。把它挤掉，互斥当场失效。"""
        srv._TASKS.clear()
        for i in range(srv._TASKS_KEEP + 3):
            srv._TASKS['old%d' % i] = {'state': 'done', 'started': i,
                                       'results': [], 'lines': []}
        srv._TASKS['live'] = {'state': 'running', 'started': 999,
                              'results': [], 'lines': []}
        srv.convert.pdf_to_word = self._fake()
        p = os.path.join(self.w, 'a.pdf')
        _pdf(p)
        r = client.post('/api/convert', json={'paths': [p], 'out_dir': self.w})
        self.assertEqual(r.status_code, 409, '有 running 却放行了')
        self.assertIn('live', srv._TASKS, '正在跑的被淘汰了')

    def test_轮询返回的是拷贝不是内部那份(self):
        r"""🔴 老项目返回的是浅拷贝，序列化发生在锁**外**，而工作线程同时
        在 `del t['lines'][0:n]` —— 日志会被悄悄截断。这里在锁内就拷好。"""
        srv._TASKS.clear()
        srv._TASKS['x'] = {'state': 'running', 'started': time.time(),
                           'current': 0, 'total': 1, 'now': '', 'error': '',
                           'lines': ['a'], 'results': [{'ok': True}],
                           'cancel': False}
        d = client.get('/api/convert/x').json()
        d['lines'].append('污染')
        d['results'][0]['ok'] = False
        self.assertEqual(srv._TASKS['x']['lines'], ['a'], '内部 lines 被改到了')
        self.assertTrue(srv._TASKS['x']['results'][0]['ok'], '内部 results 被改到了')


class Test历史(unittest.TestCase):

    def setUp(self):
        self._f = store.RUNS_FILE
        self.w = tempfile.mkdtemp(prefix='p2wc_')
        store.RUNS_FILE = os.path.join(self.w, 'runs.json')

    def tearDown(self):
        store.RUNS_FILE = self._f
        shutil.rmtree(self.w, ignore_errors=True)

    def test_记一条能读回来(self):
        store.note_run({'pdf': 'D:/a.pdf', 'docx': 'D:/a.docx', 'ok': True,
                        'pages': 3, 'formulas': 5, 'formulas_xsl': 5,
                        'tables': 1, 'images': 2, 'error': ''})
        rows = store.runs()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['formulas'], '5/5')

    def test_超过上限就扔掉最老的(self):
        for i in range(store.RUNS_KEEP + 5):
            store.note_run({'pdf': 'D:/%d.pdf' % i, 'ok': True, 'pages': 1})
        self.assertEqual(len(store.runs()), store.RUNS_KEEP)

    def test_历史里绝不能出现token(self):
        r"""🔴 转换报告里带着 token 的话，用户把日志发给别人就等于交出账号。"""
        store.note_run({'pdf': 'D:/a.pdf', 'ok': True, 'pages': 1,
                        'error': ''})
        raw = io.open(store.RUNS_FILE, encoding='utf-8').read()
        self.assertNotIn('sk-', raw)

    def test_文件坏了当没有历史不炸(self):
        io.open(store.RUNS_FILE, 'w', encoding='utf-8').write('不是 json')
        self.assertEqual(store.runs(), [])


class Test云端客户端(unittest.TestCase):
    r"""不联网。只验那些**不需要网络**就能验的性质。"""

    def test_空token当场判掉不发请求(self):
        ok, why = mineru_api.check_token('')
        self.assertFalse(ok)
        self.assertIn('还没填', why)

    def test_HTTP200也可能是失败(self):
        r"""🔴 实测过：拿不存在的 task_id 去查，返回的是
        `HTTP 200 {"code":-60012}`。只看状态码会把错误当成功。"""
        with self.assertRaises(mineru_api.ApiError):
            mineru_api._check({'code': -60012, 'msg': 'task not found'})
        self.assertEqual(mineru_api._check({'code': 0, 'data': {'x': 1}}), {'x': 1})

    def test_文件太大在本地就拦下(self):
        w = tempfile.mkdtemp(prefix='p2wc_')
        try:
            p = os.path.join(w, 'big.pdf')
            io.open(p, 'wb').write(b'x' * 1024)
            old = mineru_api.MAX_BYTES
            mineru_api.MAX_BYTES = 100
            try:
                r = mineru_api.run(p, os.path.join(w, 'out'), 'sk-x')
            finally:
                mineru_api.MAX_BYTES = old
            self.assertFalse(r['ok'])
            self.assertIn('上限', r['error'])
        finally:
            shutil.rmtree(w, ignore_errors=True)

    def test_文件不见了不抛异常(self):
        r = mineru_api.run('D:/根本没有这个.pdf', 'D:/x', 'sk-x')
        self.assertFalse(r['ok'])
        self.assertIn('不见了', r['error'])

    def test_结果包里有越界路径就整包不要(self):
        r"""🔴 zip slip。半解压出去的东西比不解压更难收拾，所以**先全查一遍
        再解压**，任何一个越界就整包拒绝。"""
        import zipfile
        w = tempfile.mkdtemp(prefix='p2wc_')
        try:
            zp = os.path.join(w, 'evil.zip')
            with zipfile.ZipFile(zp, 'w') as z:
                z.writestr('full.md', '# ok')
                z.writestr('../../escaped.txt', 'evil')
            import requests

            class FakeResp(object):
                content = io.open(zp, 'rb').read()

            old = requests.get
            requests.get = lambda *a, **k: FakeResp()
            try:
                with self.assertRaises(mineru_api.ApiError):
                    mineru_api._fetch('http://x/y.zip', os.path.join(w, 'out'))
            finally:
                requests.get = old
            self.assertFalse(os.path.isfile(os.path.join(w, 'escaped.txt')))
        finally:
            shutil.rmtree(w, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)


class Test汇总那一行(unittest.TestCase):
    r"""界面上每份文件后面那句话。**说错了比不说更糟** —— 用户据此判断
    这份转得好不好。"""

    def _rep(self, **kw):
        d = {'ok': True, 'pages': 1, 'formulas': 0, 'formulas_xsl': 0,
             'tables': 0, 'images': 0, 'math_engine': '', 'scan_pages': [],
             'error': ''}
        d.update(kw)
        return d

    def test_没有公式时压根不提公式引擎(self):
        r"""🔴 2026-09-08 真实端到端跑出来的：一份纯文字讲义显示
        「公式 0 ｜ 公式走 Pandoc」—— 用户看到 Pandoc 会以为走了次等路径
        （那是本地版明确废弃的降级路），而实际上根本没有公式要转。"""
        import convert
        line = convert.summary_line(self._rep(formulas=0, math_engine=''))
        self.assertNotIn('Pandoc', line)
        self.assertNotIn('公式走', line)

    def test_有公式就说是Word原生公式(self):
        r"""🔴 **别在界面上提 Office。** 用户没装 Office，说「公式走 Office」
        他只会困惑。他要知道的是「这公式是真的、能编辑」。"""
        import convert
        line = convert.summary_line(
            self._rep(formulas=5, formulas_xsl=5, math_engine='xsl'))
        self.assertIn('公式是 Word 原生公式', line)
        self.assertNotIn('Office', line)

    def test_公式没转全要说出来(self):
        import convert
        line = convert.summary_line(
            self._rep(formulas=10, formulas_xsl=7, math_engine='xsl'))
        self.assertIn('3 个公式没转成', line)

    def test_失败时只说失败原因(self):
        import convert
        line = convert.summary_line({'ok': False, 'error': '云端解析失败'})
        self.assertTrue(line.startswith('失败：'))
        self.assertIn('云端解析失败', line)


class Test前后端契约(unittest.TestCase):
    r"""🔴 **这个项目栽过一次，老项目栽过五次。**

    形状是：后端写好了接口、逻辑对、测试也有 —— 前端一个字都没引用。
    它不会报错，只会安静地变成一个将来跟别处说法不一致的隐患。

    2026-09-08 建这个项目当天就自己犯了一次（`GET /api/token` 和
    `/api/env` 同时给 token 状态，前端只用后者），靠这道检查抓出来的。
    """

    def _routes(self):
        import re
        out = set()
        for r in srv.app.routes:
            for m in (getattr(r, 'methods', None) or []):
                if m in ('GET', 'POST') and r.path.startswith('/api'):
                    out.add('%s %s' % (m, re.sub(r'\{[^}]*\}', '{}', r.path)))
        return out

    def _called(self):
        import re
        js = ''
        for n in ('actions.js', 'app.js'):
            with io.open(os.path.join(ROOT, 'app', 'renderer', n),
                         encoding='utf-8') as f:
                js += f.read()
        out = set()
        # 三段：开头的字面量前缀 / 中间拼的变量 / 结尾的字面量后缀
        #
        # 中间那段只许出现变量拼接会用到的字符（词、点、方括号、加号、
        # 空白）。放宽成「除了引号都行」会出事：贪婪匹配吃掉空格之后
        # 回溯，把第二个加号也吞进中间段，后缀就永远匹配不到
        # （2026-09-08 实测踩到，/append 硬是识别不出来）。
        #
        #   HTTP.get('/api/env')                              → GET /api/env
        #   HTTP.get('/api/convert/' + id)                    → GET /api/convert/{}
        #   HTTP.post('/api/convert/' + id + '/append', {})   → POST /api/convert/{}/append
        #
        # 🔴 **后缀是解析出来的，不是硬编码的。** 这里原先写的是
        #    「只要前端出现过 /api/convert/ 拼接，就当 /cancel 也被调了」——
        #    那等于放水：2026-09-08 加 /append 时，接口在后端躺着没人调，
        #    这道检查却照样绿。每加一个子路径都要回来改一次的检查，
        #    迟早有人忘记改。
        pat = (r"(?:HTTP\.(get|post)|(httpGet))\('([^']*)'"
               r"([\w\s.\[\]+]*)"
               # 后缀组**不带加号** —— 加号已经归中间段了。带上的话，
               # 中间段贪婪吃掉加号之后，可选组不会为了它回溯，后缀永远是空。
               r"(?:\s*'([^']*)')?")
        for m in re.finditer(pat, js):
            verb = (m.group(1) or 'get').upper()
            path = re.sub(r'\?.*$', '', m.group(3))
            tail = re.sub(r'\?.*$', '', m.group(5) or '')
            if path.endswith('/'):
                path += '{}'
            out.add('%s %s' % (verb, path + tail))
        return out

    def test_后端每个接口前端都真的在用(self):
        dead = self._routes() - self._called()
        self.assertFalse(dead, '这些接口没有任何前端调用点：%s' % sorted(dead))

    def test_前端调的接口后端都有(self):
        import re
        known = self._routes()
        for c in self._called():
            if c.startswith('GET /api/convert/') or c.startswith('POST /api/convert/'):
                continue          # 动态段，上面那条已经覆盖
            self.assertIn(c, known, '前端调了一个不存在的接口：%s' % c)


class Test失败路径(unittest.TestCase):
    r"""**一份失败不能带倒整批，而且必须给人话。**

    联网的东西失败方式特别多：断网、token 过期、服务端 200 但信封里报错、
    该给的字段没给。这些全都得落到「ok=False + 一句能看懂的原因」，
    绝不能抛异常穿到上层。
    """

    def setUp(self):
        self.w = tempfile.mkdtemp(prefix='p2wc_fail_')
        self.pdf = os.path.join(self.w, 'a.pdf')
        _pdf(self.pdf)
        import requests
        self.requests = requests
        self._post = requests.post

    def tearDown(self):
        self.requests.post = self._post
        shutil.rmtree(self.w, ignore_errors=True)

    def _run(self):
        return mineru_api.run(self.pdf, os.path.join(self.w, 'out'), 'sk-x')

    def test_断网(self):
        def dead(*a, **k):
            raise self.requests.ConnectionError('断网了')
        self.requests.post = dead
        r = self._run()
        self.assertFalse(r['ok'])
        self.assertTrue(r['error'])

    def test_token过期给的是人话不是401(self):
        class R(object):
            status_code = 401

            def json(self):
                return {'msg': 'user authenticate failed'}
        self.requests.post = lambda *a, **k: R()
        r = self._run()
        self.assertFalse(r['ok'])
        self.assertIn('token', r['error'])

    def test_HTTP200但信封里报错也算失败(self):
        r"""🔴 实测过：MinerU 的错误是装在 200 的信封里的。"""
        class R(object):
            status_code = 200

            def json(self):
                return {'code': -60001, 'msg': '文件格式不支持'}
        self.requests.post = lambda *a, **k: R()
        r = self._run()
        self.assertFalse(r['ok'])
        self.assertIn('文件格式不支持', r['error'])

    def test_服务端没给上传位(self):
        class R(object):
            status_code = 200

            def json(self):
                return {'code': 0, 'data': {'batch_id': 'b', 'file_urls': []}}
        self.requests.post = lambda *a, **k: R()
        r = self._run()
        self.assertFalse(r['ok'])
        self.assertIn('上传地址', r['error'])

    def test_任何失败都不抛异常(self):
        def boom(*a, **k):
            raise RuntimeError('什么奇怪的错误')
        self.requests.post = boom
        r = self._run()          # 不该抛
        self.assertFalse(r['ok'])
        self.assertIn('RuntimeError', r['error'])


class Test多个token(unittest.TestCase):
    r"""攒多个 mineru 账号轮着用。

    背景：mineru 一个手机号能注册一个账号、微信能再注册一个，号与号之间
    额度独立。作者 2026-09-08 先定了「设置里选 1~10 栏」，同一天改成
    **不设栏数**：想加几个加几个，每一行自带「换」「删」。

    改的理由是「栏」这层概念是多余的 —— 它还会冒出「空栏」这种既不算
    有 token 也不算没有的中间态，增删改各要考虑一遍。现在栏数 = token 数。
    """

    def setUp(self):
        import store
        self.store = store
        self.w = tempfile.mkdtemp(prefix='p2wt_')
        self._tf, self._uf = store.TOKEN_FILE, store.USAGE_FILE
        store.TOKEN_FILE = os.path.join(self.w, 'token.json')
        store.USAGE_FILE = os.path.join(self.w, 'usage.json')

    def tearDown(self):
        self.store.TOKEN_FILE, self.store.USAGE_FILE = self._tf, self._uf
        shutil.rmtree(self.w, ignore_errors=True)

    # ── 增删改 ────────────────────────────────────────────────────────

    def test_一开始一个都没有(self):
        self.assertEqual(self.store.all_tokens(), [])
        self.assertEqual(self.store.token_count(), 0)
        self.assertEqual(self.store.get_token(), '')

    def test_添在末尾(self):
        st = self.store
        self.assertEqual(st.add_token('sk-a'), (True, ''))
        self.assertEqual(st.add_token('sk-b'), (True, ''))
        self.assertEqual(st.all_tokens(), ['sk-a', 'sk-b'])

    def test_重复的加不进去(self):
        r"""🔴 存重了两条其实是一个号，调度会以为有双倍额度。"""
        st = self.store
        st.add_token('sk-a')
        ok, why = st.add_token('sk-a')
        self.assertFalse(ok)
        self.assertIn('第 1 个', why)
        self.assertEqual(st.token_count(), 1)

    def test_空的加不进去(self):
        self.assertFalse(self.store.add_token('')[0])
        self.assertFalse(self.store.add_token('   ')[0])

    def test_换掉某一个(self):
        st = self.store
        st.add_token('sk-a')
        st.add_token('sk-b')
        st.set_token_slot(0, 'sk-new')
        self.assertEqual(st.all_tokens(), ['sk-new', 'sk-b'])

    def test_删掉某一个后面的往前挪(self):
        st = self.store
        for t in ('sk-a', 'sk-b', 'sk-c'):
            st.add_token(t)
        st.remove_token(1)
        self.assertEqual(st.all_tokens(), ['sk-a', 'sk-c'])

    def test_越界的改不动也删不掉(self):
        st = self.store
        st.add_token('sk-a')
        self.assertFalse(st.set_token_slot(5, 'sk-x'))
        self.assertFalse(st.set_token_slot(-1, 'sk-x'))
        self.assertFalse(st.remove_token(9))
        self.assertEqual(st.all_tokens(), ['sk-a'])

    def test_删光了连文件一起删掉(self):
        r"""别留一个 {"tokens": []} 的空壳在磁盘上。"""
        st = self.store
        st.add_token('sk-a')
        st.remove_token(0)
        self.assertFalse(os.path.isfile(st.TOKEN_FILE))
        self.assertEqual(st.all_tokens(), [])

    def test_有个防手滑的天花板(self):
        r"""不是功能限制 —— 每个 token 都要去 mineru 注册一个账号，
        正常没人有 50 个。留着是防代码出 bug 往里塞。"""
        st = self.store
        for i in range(st.MAX_TOKENS):
            self.assertTrue(st.add_token('sk-%03d' % i)[0])
        ok, why = st.add_token('sk-one-more')
        self.assertFalse(ok)
        self.assertIn('50', why)

    # ── 老格式 ────────────────────────────────────────────────────────

    def test_认得最早那版的单个token(self):
        io.open(self.store.TOKEN_FILE, 'w', encoding='utf-8').write(
            '{"token": "sk-old"}')
        self.assertEqual(self.store.all_tokens(), ['sk-old'])
        self.assertEqual(self.store.get_token(), 'sk-old')

    def test_认得中间那版的空栏格式(self):
        r"""中间那版有固定栏数，没填的位置是空串。空栏在这儿被滤掉 ——
        现在没有「空栏」这个概念了。"""
        io.open(self.store.TOKEN_FILE, 'w', encoding='utf-8').write(
            '{"slots": 4, "tokens": ["sk-a", "", "sk-c", ""]}')
        self.assertEqual(self.store.all_tokens(), ['sk-a', 'sk-c'])

    def test_设置文件坏了也不崩(self):
        io.open(self.store.TOKEN_FILE, 'w', encoding='utf-8').write('不是 json')
        self.assertEqual(self.store.all_tokens(), [])
        self.assertEqual(self.store.usable_tokens(), [])

    # ── 记账 ──────────────────────────────────────────────────────────

    def test_记账文件里不许出现token原文(self):
        r"""🔴 记账文件跟 token.json 一样躺在 logs/ 下。凭据只该有一个出处。"""
        st = self.store
        st.note_pages('sk-secret-value-here', 30)
        raw = io.open(st.USAGE_FILE, encoding='utf-8').read()
        self.assertNotIn('sk-secret-value-here', raw)
        self.assertEqual(st.used_today('sk-secret-value-here'), 30)

    def test_页数会累加(self):
        st = self.store
        st.note_pages('sk-a', 10)
        st.note_pages('sk-a', 25)
        self.assertEqual(st.used_today('sk-a'), 35)
        self.assertEqual(st.used_today('sk-b'), 0)

    def test_零页和负数不记(self):
        st = self.store
        st.note_pages('sk-a', 0)
        st.note_pages('sk-a', -5)
        st.note_pages('', 10)
        self.assertEqual(st.used_today('sk-a'), 0)

    def test_只留最近七天(self):
        st = self.store
        d = {}
        for i in range(1, 21):
            d['2026-08-%02d' % i] = {'x': 1}
        io.open(st.USAGE_FILE, 'w', encoding='utf-8').write(json.dumps(d))
        st.note_pages('sk-a', 1)
        kept = json.loads(io.open(st.USAGE_FILE, encoding='utf-8').read())
        self.assertLessEqual(len(kept), 7)

    def test_额度到顶就记满(self):
        st = self.store
        st.mark_exhausted('sk-a')
        self.assertGreaterEqual(st.used_today('sk-a'), st.DAILY_PAGES)
        self.assertLessEqual(st.left_today('sk-a'), 0)

    def test_换掉token之后账从零算起(self):
        r"""账是按 token 指纹记的，换了 token 指纹跟着变，旧账自然作废。"""
        st = self.store
        st.add_token('sk-old')
        st.note_pages('sk-old', 500)
        st.set_token_slot(0, 'sk-brand-new')
        self.assertEqual(st.used_today('sk-brand-new'), 0)

    # ── 挑号 ──────────────────────────────────────────────────────────

    def test_用得少的排前面(self):
        r"""作者问过的场景：1 号只剩 3 页、这份要 30 页，怎么办 ——

        一份 PDF 拆不开（拆了是两份 Word，跨页的表格公式会断），
        所以只能整份挑一个号。按剩余排序，2 号自然排前面。
        """
        st = self.store
        st.add_token('sk-a')
        st.add_token('sk-b')
        st.note_pages('sk-a', st.DAILY_PAGES - 3)     # 1 号只剩 3 页
        self.assertEqual(st.pick_order(), ['sk-b', 'sk-a'])

    def test_剩得多的排前面就等于够的排前面(self):
        r"""🔴 为什么没有单独一层「够不够」的筛选：剩得多的号必然先够，
        两种排法结果永远相同。写了那一层等于写了一段永远不改变结果的
        代码 —— 2026-09-08 加过又拆掉了。"""
        st = self.store
        st.add_token('sk-a')
        st.add_token('sk-b')
        st.note_pages('sk-a', st.DAILY_PAGES - 30)    # a 剩 30
        st.note_pages('sk-b', st.DAILY_PAGES - 20)    # b 剩 20
        for pages in (0, 10, 25, 50, 999):
            self.assertEqual(st.pick_order(pages), ['sk-a', 'sk-b'], pages)

    def test_全都不够时说得出来(self):
        st = self.store
        st.add_token('sk-a')
        st.add_token('sk-b')
        st.note_pages('sk-a', st.DAILY_PAGES - 30)
        st.note_pages('sk-b', st.DAILY_PAGES - 20)
        self.assertFalse(st.all_short(25))    # a 还够
        self.assertTrue(st.all_short(50))     # 都不够
        self.assertFalse(st.all_short(0))     # 不知道页数就别乱报

    def test_可以对给定的列表排序(self):
        st = self.store
        st.note_pages('sk-x', 900)
        self.assertEqual(st.pick_order(0, ['sk-x', 'sk-y']), ['sk-y', 'sk-x'])

    def test_只有一个token时原样返回(self):
        st = self.store
        st.add_token('sk-only')
        self.assertEqual(st.pick_order(), ['sk-only'])

    def test_一个都没填时是空的(self):
        self.assertEqual(self.store.pick_order(), [])



class Test调度换号(unittest.TestCase):
    r"""额度撞墙时自动换下一个号。**不真连网**，把 mineru_api.run 换掉。"""

    def setUp(self):
        import convert
        import mineru_api
        import store
        self.convert, self.api, self.store = convert, mineru_api, store
        self.w = tempfile.mkdtemp(prefix='p2wd_')
        self._uf = store.USAGE_FILE
        store.USAGE_FILE = os.path.join(self.w, 'usage.json')
        self._probe = convert.probe.probe_pdf
        self._run = mineru_api.run
        self._todocx = convert.todocx.md_to_docx
        convert.probe.probe_pdf = lambda p: {'ok': True, 'pages': 30,
                                             'scan_pages': [], 'error': ''}
        convert.todocx.md_to_docx = lambda *a, **k: {
            'ok': True, 'error': '', 'formulas_src': 0, 'formulas_replaced': 0,
            'tables': 0, 'images': 0, 'math_engine': '', 'math_note': '',
            'details_dropped': 0}
        self.calls = []

    def tearDown(self):
        self.convert.probe.probe_pdf = self._probe
        self.api.run = self._run
        self.convert.todocx.md_to_docx = self._todocx
        self.store.USAGE_FILE = self._uf
        shutil.rmtree(self.w, ignore_errors=True)

    def _fake(self, results):
        """results: 每次调用依次返回的 (ok, quota) —— 记下用的是哪个 token。"""
        seq = list(results)

        def run(pdf, out_dir, token, **kw):
            self.calls.append(token)
            ok, quota = seq.pop(0)
            return {'ok': ok, 'error': '' if ok else '额度没了' if quota else '文件坏了',
                    'md': 'x.md', 'auto_dir': out_dir, 'cancelled': False,
                    'code': -60018 if quota else -10001,
                    'quota': quota, 'submitted': True}
        self.api.run = run

    def _go(self, tokens):
        return self.convert.pdf_to_word('a.pdf', os.path.join(self.w, 'a.docx'),
                                        self.w, tokens)

    def test_第一个号额度满了自动换第二个(self):
        self._fake([(False, True), (True, False)])
        r = self._go(['sk-a', 'sk-b'])
        self.assertTrue(r['ok'], r['error'])
        self.assertEqual(self.calls, ['sk-a', 'sk-b'])

    def test_撞满之后那个号被记满不再优先(self):
        self._fake([(False, True), (True, False)])
        self._go(['sk-a', 'sk-b'])
        self.assertGreaterEqual(self.store.used_today('sk-a'),
                                self.store.DAILY_PAGES)

    def test_不是额度问题就不换号(self):
        r"""🔴 文件坏了、服务异常，换个号一样失败 —— 重试只是白传一趟。"""
        self._fake([(False, False), (True, False)])
        r = self._go(['sk-a', 'sk-b'])
        self.assertFalse(r['ok'])
        self.assertEqual(self.calls, ['sk-a'])

    def test_全都满了要说人话并报出服务端原话(self):
        self._fake([(False, True), (False, True)])
        r = self._go(['sk-a', 'sk-b'])
        self.assertFalse(r['ok'])
        self.assertIn('都用完了', r['error'])
        self.assertIn('额度没了', r['error'])      # 服务端原话不吞

    def test_成功之后记上这份用了多少页(self):
        self._fake([(True, False)])
        self._go(['sk-a'])
        self.assertEqual(self.store.used_today('sk-a'), 30)

    def test_一个token都没有就直说(self):
        self._fake([])
        r = self._go([])
        self.assertFalse(r['ok'])
        self.assertIn('token', r['error'])

    def test_传单个字符串也认(self):
        r"""老调用点传的是一个 token 字符串，不能因为改成列表就崩。"""
        self._fake([(True, False)])
        r = self._go('sk-single')
        self.assertTrue(r['ok'], r['error'])
        self.assertEqual(self.calls, ['sk-single'])

    def test_报告里只留打码的token(self):
        self._fake([(True, False)])
        r = self._go(['sk-abcdefghijklmnop'])
        self.assertNotIn('sk-abcdefghijklmnop', str(r))
        self.assertIn('...', r['token_used'])


class Test设置接口(unittest.TestCase):
    r"""一个 POST /api/token 管增删改：

        slot 省略（-1） + 有内容  → 添一个
        slot = i        + 有内容  → 换掉第 i 个
        slot = i        + 空内容  → 删掉第 i 个
    """

    def setUp(self):
        import store
        self.store = store
        self.w = tempfile.mkdtemp(prefix='p2ws_')
        self._tf = store.TOKEN_FILE
        store.TOKEN_FILE = os.path.join(self.w, 'token.json')
        self._chk = srv.mineru_api.check_token
        srv.mineru_api.check_token = lambda t, **k: (True, '')   # 不真连网

    def tearDown(self):
        self.store.TOKEN_FILE = self._tf
        srv.mineru_api.check_token = self._chk
        shutil.rmtree(self.w, ignore_errors=True)

    def test_不带slot就是添一个(self):
        r = client.post('/api/token', json={'token': 'sk-first'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['count'], 1)
        self.assertEqual(self.store.all_tokens(), ['sk-first'])

    def test_带slot是换掉那一个(self):
        self.store.add_token('sk-a')
        self.store.add_token('sk-b')
        r = client.post('/api/token', json={'token': 'sk-new', 'slot': 0})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.store.all_tokens(), ['sk-new', 'sk-b'])

    def test_空内容是删掉那一个(self):
        self.store.add_token('sk-a')
        self.store.add_token('sk-b')
        r = client.post('/api/token', json={'token': '', 'slot': 0})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.store.all_tokens(), ['sk-b'])

    def test_删不存在的那个要拒(self):
        r = client.post('/api/token', json={'token': '', 'slot': 3})
        self.assertEqual(r.status_code, 400)

    def test_换不存在的那个要拒(self):
        r = client.post('/api/token', json={'token': 'sk-x', 'slot': 7})
        self.assertEqual(r.status_code, 400)

    def test_重复的token要拒(self):
        r"""🔴 存重了两条其实是一个号，调度会以为有双倍额度。"""
        self.store.add_token('sk-same-one')
        r = client.post('/api/token', json={'token': 'sk-same-one'})
        self.assertEqual(r.status_code, 400)
        self.assertIn('第 1 个', r.json()['detail'])

    def test_到上限不给加(self):
        for i in range(self.store.MAX_TOKENS):
            self.store.add_token('sk-%03d' % i)
        r = client.post('/api/token', json={'token': 'sk-one-more'})
        self.assertEqual(r.status_code, 400)
        self.assertIn('最多', r.json()['detail'])

    def test_删掉不用验token(self):
        r"""删一个已经不能用的 token 时，不该因为「验不过」而删不掉。"""
        self.store.add_token('sk-dead')
        srv.mineru_api.check_token = lambda t, **k: (False, 'token 不对')
        r = client.post('/api/token', json={'token': '', 'slot': 0})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.store.all_tokens(), [])

    def test_验不过就不存(self):
        r"""🔴 不验的话，用户要等到转第一份失败才知道填错了 —— 而那时候
        文件已经传上去了。验一次不消耗解析额度，没有理由不验。"""
        srv.mineru_api.check_token = lambda t, **k: (False, 'token 不对')
        r = client.post('/api/token', json={'token': 'sk-bad'})
        self.assertEqual(r.status_code, 400)
        self.assertIn('不对', r.json()['detail'])
        self.assertEqual(self.store.all_tokens(), [])

    def test_验不过时原来那些一个都不能动(self):
        r"""🔴 换 token 换错了，不该把原来能用的那个也搭进去。"""
        self.store.add_token('sk-good-old-one')
        srv.mineru_api.check_token = lambda t, **k: (False, 'token 不对')
        client.post('/api/token', json={'token': 'sk-bad', 'slot': 0})
        self.assertEqual(self.store.all_tokens(), ['sk-good-old-one'])

    def test_回复里只有打码版(self):
        r"""🔴 原文不出后端，接口回复也算「出去」。"""
        r = client.post('/api/token', json={'token': 'sk-1234567890abcdefgh'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn('1234567890', json.dumps(r.json()))
        self.assertIn('...', r.json()['masked'])

    def test_env给出每一个的状态但不给原文(self):
        self.store.add_token('sk-abcdefghijklmnopqrst')
        d = client.get('/api/env').json()
        self.assertEqual(d['tokens']['count'], 1)
        self.assertEqual(len(d['tokens']['list']), 1)
        self.assertIn('...', d['tokens']['list'][0]['masked'])
        self.assertNotIn('sk-abcdefghijklmnopqrst', json.dumps(d))

    def test_没有栏数这个概念了(self):
        r"""🔴 POST /api/slots 连同「栏数」整个删了。留一个没人调的接口
        就是这项目一直在防的形状。"""
        self.assertEqual(client.post('/api/slots', json={'slots': 3}).status_code,
                         404)
        self.assertFalse(hasattr(self.store, 'set_slot_count'))
        self.assertFalse(hasattr(self.store, 'slot_count'))



class Test转换批次(unittest.TestCase):
    r"""**一批就是一批，中途不变。**

    2026-09-09 之前这里是「双队列」：转换中还能往后端队列里追加文件
    （`POST /api/convert/{id}/append`），worker 用 while 循环读共享队列。
    整套删了，改用本地版 pdf_to_word 的做法 —— 待办只在前端排着，
    这一批转完前端自动晋升成新一批、起一个新任务。

    删它不是因为不好使，是因为「队列在转换中动态增长」逼着前端把
    「已完成 / 正在转 / 排队中 / 刚拖进来」四段拼进一张列表，而那正是
    「4 个文件下面又冒出一模一样 4 个」那个 bug 的土壤。后端这边顺带
    省掉了「取下一份和收工必须在同一把锁里」那种竞态。
    """

    def setUp(self):
        self._conv = srv.convert.pdf_to_word
        self._note = srv.store.note_run
        srv.store.note_run = lambda rep: True      # 别写真文件
        self.done = []

    def tearDown(self):
        srv.convert.pdf_to_word = self._conv
        srv.store.note_run = self._note
        for k in list(srv._TASKS):
            if k.startswith('q'):
                srv._TASKS.pop(k, None)

    def _task(self, tid, n):
        srv._TASKS[tid] = {'state': 'running', 'started': time.time(),
                           'current': 0, 'total': n, 'now': '',
                           'results': [], 'lines': [], 'error': '',
                           'cancel': False}

    def _ok(self, pdf):
        return {'ok': True, 'error': '', 'cancelled': False, 'pdf': pdf,
                'docx': pdf + '.docx', 'pages': 1, 'scan_pages': [],
                'formulas': 0, 'formulas_xsl': 0, 'tables': 0, 'images': 0,
                'math_engine': '', 'math_note': '', 'auto_dir': '',
                'degraded': '', 'details_dropped': 0}

    def test_一批转完就收工(self):
        self._task('q1', 2)
        srv.convert.pdf_to_word = lambda pdf, *a, **k: (
            self.done.append(pdf) or self._ok(pdf))
        srv._work_inner('q1', ['a.pdf', 'b.pdf'], tempfile.mkdtemp())
        self.assertEqual(self.done, ['a.pdf', 'b.pdf'])
        self.assertEqual(srv._TASKS['q1']['state'], 'done')
        self.assertEqual(srv._TASKS['q1']['current'], 2)

    def test_停了就不再往下转(self):
        self._task('q2', 2)

        def fake(pdf, *a, **k):
            self.done.append(pdf)
            srv._TASKS['q2']['cancel'] = True     # 转完第一份就按停止
            return self._ok(pdf)

        srv.convert.pdf_to_word = fake
        srv._work_inner('q2', ['a.pdf', 'b.pdf'], tempfile.mkdtemp())
        self.assertEqual(self.done, ['a.pdf'])
        self.assertEqual(srv._TASKS['q2']['state'], 'cancelled')

    def test_一份失败不带倒整批(self):
        self._task('q3', 3)

        def fake(pdf, *a, **k):
            self.done.append(pdf)
            if pdf == 'b.pdf':
                return {'ok': False, 'error': '云端解析失败', 'cancelled': False,
                        'pdf': pdf, 'docx': '', 'pages': 0, 'scan_pages': [],
                        'formulas': 0, 'formulas_xsl': 0, 'tables': 0,
                        'images': 0, 'math_engine': '', 'math_note': '',
                        'auto_dir': '', 'degraded': '', 'details_dropped': 0}
            return self._ok(pdf)

        srv.convert.pdf_to_word = fake
        srv._work_inner('q3', ['a.pdf', 'b.pdf', 'c.pdf'], tempfile.mkdtemp())
        self.assertEqual(self.done, ['a.pdf', 'b.pdf', 'c.pdf'])
        self.assertEqual(srv._TASKS['q3']['state'], 'done')
        oks = [r['ok'] for r in srv._TASKS['q3']['results']]
        self.assertEqual(oks, [True, False, True])

    def test_后台线程抛异常也不会永远卡在running(self):
        r"""🔴 后台线程的异常会被 Python 悄悄吞掉，任务就永远停在 running，
        界面转圈转到天荒地老。"""
        self._task('q4', 1)

        def boom(*a, **k):
            raise RuntimeError('什么奇怪的错误')

        srv.convert.pdf_to_word = boom
        srv._work(('q4'), ['a.pdf'], tempfile.mkdtemp())
        self.assertEqual(srv._TASKS['q4']['state'], 'done')
        self.assertIn('RuntimeError', srv._TASKS['q4']['error'])

    def test_没有追加接口了(self):
        r"""🔴 待办只在前端排着，后端不知道它的存在。留一个没人调的接口
        就是这项目一直在防的形状。"""
        self.assertFalse(hasattr(srv, 'append_convert'))
        r = client.post('/api/convert/whatever/append', json={'paths': ['a.pdf']})
        self.assertEqual(r.status_code, 404)

    def test_查进度不再返回排队清单(self):
        r"""前端从自己的 items 画表，不需要后端告诉它谁在排队。"""
        self._task('q5', 2)
        d = client.get('/api/convert/q5').json()
        self.assertNotIn('queued', d)
        self.assertEqual(set(d) & {'state', 'current', 'total', 'results'},
                         {'state', 'current', 'total', 'results'})

class Test检查更新(unittest.TestCase):
    r"""整套逻辑在 pipeline/update.py（从本地版搬来的），这里只验接到 HTTP
    上的那一层。**不真连 GitHub** —— 每跑一次测试就打一次人家的 API，
    而且没网就红。
    """

    def setUp(self):
        self._check = srv.update.check
        self._dl = srv.update.download
        self._apply = srv.update.apply_update
        srv._UPD.update({'state': 'idle', 'got': 0, 'total': 0, 'error': '',
                         'via': '', 'files': 0, 'step': ''})

    def tearDown(self):
        srv.update.check = self._check
        srv.update.download = self._dl
        srv.update.apply_update = self._apply
        srv._UPD['state'] = 'idle'

    def test_查更新走后端不走前端(self):
        r"""🔴 前端页面的 CSP 只放行 127.0.0.1，让它直连 GitHub 就得放宽
        CSP —— 拿安全性换一个小功能不划算。所以这个接口必须存在。"""
        srv.update.check = lambda: {'ok': True, 'has_update': True,
                                    'latest': 'v9.9.9', 'lines': []}
        d = client.get('/api/update/check').json()
        self.assertTrue(d['has_update'])
        self.assertEqual(d['latest'], 'v9.9.9')

    def test_状态一开始是闲着的(self):
        d = client.get('/api/update/download').json()
        self.assertEqual(d['state'], 'idle')

    def test_转换进行中不许更新(self):
        r"""🔴 更新覆盖的是正在跑的那些 .py，当前这批会转到一半崩掉。"""
        srv._TASKS['upd-busy'] = {'state': 'running', 'started': time.time(),
                                  'current': 0, 'total': 1, 'now': '',
                                  'paths': ['a.pdf'], 'results': [],
                                  'lines': [], 'error': '', 'cancel': False}
        try:
            r = client.post('/api/update/download', json={})
            self.assertEqual(r.status_code, 409)
        finally:
            srv._TASKS.pop('upd-busy', None)

    def test_已经在更新就别再点(self):
        srv._UPD['state'] = 'downloading'
        r = client.post('/api/update/download', json={})
        self.assertEqual(r.status_code, 409)

    def test_不信前端给的地址自己重新查(self):
        r"""🔴 前端只能说「用哪条线路」，下载地址由后端自己去查。

        否则页面上一个转义漏洞就能让软件去下任意 URL 的东西，
        解压覆盖到安装目录 —— 那是任意代码执行。
        """
        seen = {}

        def fake_check():
            seen['checked'] = True
            return {'ok': True, 'has_update': True, 'latest': 'v1',
                    'asset': {'url': 'https://example.invalid/real.zip',
                              'name': 'real.zip', 'digest': ''}, 'lines': []}

        def fake_dl(url, dest, **kw):
            seen['url'] = url
            return True, '', 'gh-proxy'

        srv.update.check = fake_check
        srv.update.download = fake_dl
        srv.update.apply_update = lambda p: (True, '', 7)
        srv._upd_inner('', False)
        self.assertTrue(seen.get('checked'), '没有重新查就直接下了')
        self.assertEqual(seen['url'], 'https://example.invalid/real.zip')
        self.assertEqual(srv._UPD['state'], 'done')
        self.assertEqual(srv._UPD['files'], 7)

    def test_没查到更新包就报错不下(self):
        srv.update.check = lambda: {'ok': True, 'has_update': False,
                                    'error': '仓库里还没有发布任何版本',
                                    'lines': []}
        srv._upd_inner('', False)
        self.assertEqual(srv._UPD['state'], 'error')
        self.assertIn('还没有发布', srv._UPD['error'])

    def test_拿不到校验值要问用户不能硬拦(self):
        r"""🔴 报警但不阻拦 —— 跟显卡那条规矩一样（作者：「要报警，
        但是并不要阻拦用户使用」）。硬拒绝会让更新按钮直接作废。"""
        srv.update.check = lambda: {
            'ok': True, 'has_update': True, 'latest': 'v1',
            'asset': {'url': 'https://x.invalid/a.zip', 'name': 'a.zip'},
            'lines': []}
        srv.update.download = lambda *a, **k: (False, 'NEED_CONFIRM:没有校验值', 'direct')
        srv._upd_inner('', False)
        self.assertEqual(srv._UPD['state'], 'need_confirm')
        self.assertIn('没法确认', srv._UPD['error'])

    def test_下好了装失败要说清楚是哪一步(self):
        srv.update.check = lambda: {
            'ok': True, 'has_update': True, 'latest': 'v1',
            'asset': {'url': 'https://x.invalid/a.zip', 'name': 'a.zip'},
            'lines': []}
        srv.update.download = lambda *a, **k: (True, '', 'direct')
        srv.update.apply_update = lambda p: (False, '文件被占用', 0)
        srv._upd_inner('', False)
        self.assertEqual(srv._UPD['state'], 'error')
        self.assertIn('下载好了但安装失败', srv._UPD['error'])

    def test_后台线程抛异常也不会永远卡在running(self):
        r"""🔴 后台线程的异常会被 Python 悄悄吞掉，任务就永远停在 running，
        界面转圈转到天荒地老。"""
        def boom():
            raise RuntimeError('什么奇怪的错误')
        srv.update.check = boom
        srv._upd_work('', False)
        self.assertEqual(srv._UPD['state'], 'error')
        self.assertIn('RuntimeError', srv._UPD['error'])


class Test更新模块(unittest.TestCase):
    """从本地版搬过来时裁掉了什么、留下了什么。"""

    def test_指向新仓库(self):
        import update
        self.assertEqual(update.OWNER, 'kiryusento2017')
        self.assertEqual(update.REPO, 'teach-studio')

    def test_镜像名单一条没丢(self):
        r"""这些名单是三轮实测攒出来的（镜像会挂、会变、双向地变），
        搬过来时一条都不该少。"""
        import update
        self.assertGreaterEqual(len(update.GH_MIRRORS), 8)
        self.assertGreaterEqual(len(update.API_MIRRORS), 6)
        # 直连必须在名单里 —— 某些网络下反而只有它通
        self.assertIn('direct', [m['id'] for m in update.GH_MIRRORS])
        self.assertIn('direct', [m['id'] for m in update.API_MIRRORS])

    def test_单条超时必须小于收集窗口(self):
        r"""🔴 这两个数的大小关系反了，一条真不通的线路会永远显示「未测」
        —— 它 6 秒才超时，而窗口 3 秒就到期，永远赶不上。
        （2026-09-05 作者真报过这个。）"""
        import update
        self.assertLess(update.API_TRY_TIMEOUT, update.API_DETAIL_BUDGET
                        + update.API_TRY_TIMEOUT)
        self.assertLessEqual(update.API_TRY_TIMEOUT, 5.0)

    def test_裁掉的东西没留下空壳(self):
        r"""read_upgrade / upgrade_policy / eta_words / MODEL_SOURCES 是
        本地版特有的，云端版没人调 —— 删了就要删干净，不留没人用的函数，
        也不留永远为空的字段。"""
        import update
        import sources
        for n in ('read_upgrade', 'upgrade_policy'):
            self.assertFalse(hasattr(update, n), n + ' 还在')
        for n in ('eta_words', 'download', 'MODEL_SOURCES'):
            self.assertFalse(hasattr(sources, n), 'sources.' + n + ' 还在')
        # 🔴 验的是**真实返回值**，不是扫源码找字符串 —— 第一版就是扫源码，
        #    结果把「这里本来有个 upgrade 字段，删了」这句注释也算成了残留。
        #    源码里出现某个词，跟这个字段还在不在，是两回事。
        #
        #    api_race 换成必抛 404，check() 会走「仓库还没发布版本」那条
        #    快速返回，不发真网络请求。
        old_race = update.api_race

        def boom404(url):
            raise RuntimeError('404 没找到')

        update.api_race = boom404
        try:
            out = update.check()
        finally:
            update.api_race = old_race
        self.assertNotIn('upgrade', out)
        self.assertIn('lines', out)      # 该留的还在

    def test_依赖检查留着了(self):
        r"""这套不是本地版特有的：云端版依赖变了、只推代码，照样会
        ImportError。"""
        import update
        self.assertTrue(hasattr(update, 'check_requires'))
        self.assertEqual(update.check_requires('不是 json'), [])
        miss = update.check_requires('{"requires": {"绝对没装的包": "1.0"}}')
        self.assertTrue(any('没装' in m for m in miss))


class Test产物缓存(unittest.TestCase):
    r"""同一份 PDF 转第二次，不再传一遍、不再扣一次额度。

    抄本地版 extract.py 的「指纹分桶」，但收益不同：那边命中缓存省的是
    四分钟 GPU，这边省的是**真金白银的页数额度**。
    """

    def setUp(self):
        import mineru_api
        self.api = mineru_api
        self.w = tempfile.mkdtemp(prefix='p2wk_')
        self._cache = mineru_api.CACHE_DIR
        mineru_api.CACHE_DIR = os.path.join(self.w, 'cache')
        self.pdf = os.path.join(self.w, 'a.pdf')
        io.open(self.pdf, 'wb').write(b'%PDF-1.4 fake content here')

    def tearDown(self):
        self.api.CACHE_DIR = self._cache
        shutil.rmtree(self.w, ignore_errors=True)

    def _make_bucket(self, pdf=None):
        """手搓一个「上次转过」的桶。"""
        fp = self.api.fingerprint(pdf or self.pdf)
        b = os.path.join(self.api.CACHE_DIR, fp)
        os.makedirs(os.path.join(b, 'images'), exist_ok=True)
        io.open(os.path.join(b, 'full.md'), 'w', encoding='utf-8').write('# 上次的结果')
        self.api._cache_note(b, pdf or self.pdf, fp)
        return b

    # ── 指纹 ──────────────────────────────────────────────────────────

    def test_同一份文件算两次一样(self):
        self.assertEqual(self.api.fingerprint(self.pdf),
                         self.api.fingerprint(self.pdf))

    def test_内容不同指纹就不同(self):
        other = os.path.join(self.w, 'b.pdf')
        io.open(other, 'wb').write(b'%PDF-1.4 something else')
        self.assertNotEqual(self.api.fingerprint(self.pdf),
                            self.api.fingerprint(other))

    def test_换个文件名和目录不影响指纹(self):
        r"""🔴 这条就是作者问的那个场景：两个完全一样的文件、不同目录、
        不同文件名 —— 指纹必须一样，才能命中同一个桶、不重复扣额度。"""
        sub = os.path.join(self.w, '别的目录')
        os.makedirs(sub, exist_ok=True)
        other = os.path.join(sub, '改了个名.pdf')
        shutil.copyfile(self.pdf, other)
        self.assertEqual(self.api.fingerprint(self.pdf),
                         self.api.fingerprint(other))

    def test_提交参数变了指纹就变(self):
        r"""🔴 参数进指纹，所以改了 is_ocr 之类的东西**旧缓存自动失效**，
        不需要另写一套失效逻辑。"""
        before = self.api.fingerprint(self.pdf)
        old = self.api.IS_OCR
        try:
            self.api.IS_OCR = not old
            self.assertNotEqual(before, self.api.fingerprint(self.pdf))
        finally:
            self.api.IS_OCR = old

    # ── 命中 ──────────────────────────────────────────────────────────

    def test_命中就不联网(self):
        r"""🔴 这条是整个缓存的意义所在：**一个网络请求都不该发出去**。"""
        self._make_bucket()
        called = []
        old_post, old_get = self.api.requests.post, self.api.requests.get
        self.api.requests.post = lambda *a, **k: called.append('post')
        self.api.requests.get = lambda *a, **k: called.append('get')
        try:
            r = self.api.run(self.pdf, os.path.join(self.w, 'out'), 'sk-x')
        finally:
            self.api.requests.post, self.api.requests.get = old_post, old_get
        self.assertTrue(r['ok'], r['error'])
        self.assertTrue(r['cached'])
        self.assertEqual(called, [], '命中缓存却还发了网络请求')

    def test_命中时不算提交过所以不记账(self):
        r"""🔴 `submitted` 保持 False —— convert 那边靠它决定记不记账。
        没传给服务端，自然没扣额度，记了就是凭空多算。"""
        self._make_bucket()
        old_post = self.api.requests.post
        self.api.requests.post = lambda *a, **k: None
        try:
            r = self.api.run(self.pdf, os.path.join(self.w, 'out'), 'sk-x')
        finally:
            self.api.requests.post = old_post
        self.assertFalse(r['submitted'], '命中缓存却标成提交过了')

    def test_命中给出的路径能用(self):
        b = self._make_bucket()
        r = self.api.run(self.pdf, os.path.join(self.w, 'out'), 'sk-x')
        self.assertTrue(os.path.isfile(r['md']))
        self.assertEqual(os.path.abspath(r['auto_dir']), os.path.abspath(b))

    def test_只有指纹文件没有md不算命中(self):
        r"""桶建了一半（比如上次解压到中途崩了）不能当成有效缓存。"""
        fp = self.api.fingerprint(self.pdf)
        b = os.path.join(self.api.CACHE_DIR, fp)
        os.makedirs(b, exist_ok=True)
        self.api._cache_note(b, self.pdf, fp)
        self.assertEqual(self.api._cache_hit(b), '')

    def test_只有md没有指纹文件也不算命中(self):
        fp = self.api.fingerprint(self.pdf)
        b = os.path.join(self.api.CACHE_DIR, fp)
        os.makedirs(b, exist_ok=True)
        io.open(os.path.join(b, 'full.md'), 'w', encoding='utf-8').write('x')
        self.assertEqual(self.api._cache_hit(b), '')

    # ── 清理 ──────────────────────────────────────────────────────────

    def test_清掉太老的桶留下新的(self):
        old_b = self._make_bucket()
        os.utime(old_b, (time.time() - 40 * 86400,) * 2)
        other = os.path.join(self.w, 'b.pdf')
        io.open(other, 'wb').write(b'%PDF-1.4 fresh one')
        new_b = self._make_bucket(other)
        self.assertEqual(self.api.purge_cache(days=10), 1)
        self.assertFalse(os.path.isdir(old_b))
        self.assertTrue(os.path.isdir(new_b))

    def test_清理永不抛异常(self):
        self.api.CACHE_DIR = os.path.join(self.w, '根本不存在的目录')
        self.assertEqual(self.api.purge_cache(), 0)   # 不该抛
