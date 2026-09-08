# -*- coding: utf-8 -*-
r"""多源并发测速 + 选源。

**这是从本地版 `pdf_to_word` 裁过来的**：那边还管着模型源和断点续传下载，
云端版只用得上「并发测速挑最快的镜像」这一半。裁掉的部分在下面各自留了
一段说明，包括它们踩过的坑 —— 别再踩第二遍。

照搬终末诗篇工作台 BUILD_PLAN §12-26 / BACKLOG B35 的设计，一条不改：

  · 每类源内置多个候选
  · **点下载时并发对所有源各测 2-3 秒实速**，按预计耗时排序，最快的默认选中
  · 途中掉速自动切次优源 + 断点续传
  · **不存历史成绩** —— 下载是低频动作，现测成本可忽略，旧成绩反而过时误导
  · **不用 ping 判优** —— 很多 CDN 屏蔽 ICMP，且低延迟 != 高带宽
  · 界面显示「预计几分钟」而不是 MB/s，电脑盲直接点开始即可

B35 的立论依据是实测：Chromium 走 npmmirror 比 Google 官方快 22 倍
（15.04 vs 0.68 MB/s），torch 却是官方源更快 —— **没有哪个源普遍最优**，
写死必然坑一批人。
"""
import os
import threading
import time
import urllib.request

# 测速时长。太短测不出稳定带宽（TCP 还在慢启动），太长让人干等。
PROBE_SECONDS = 2.5
PROBE_TIMEOUT = 6
CHUNK = 64 * 1024

# 🔴 本地版这里有一份 MODEL_SOURCES（ModelScope / HF-Mirror / HuggingFace
#    三个模型下载源）。云端版不下模型，删了。
#
#    但它踩过的坑值得留着 —— 那份名单的探测文件曾经指向 API 的 JSON
#    元数据接口，只有几 KB：read 到空就 break，而计时从建连开始算
#    （含 DNS + TLS 握手），于是算出来的是「几 KB ÷ 建连时间」= 变相 ping。
#    界面显示「约 44 小时」，而且每轮排序都不一样，「最快的默认选中」
#    实际是掷骰子。**测速必须拿真实的大文件测，而且就是待会儿要下的那个。**
#    update.probe_mirrors 用的正是更新包自己。

def _probe_one(src, out, seconds=PROBE_SECONDS):
    r"""测一个源的实速（字节/秒）。测不通就是 0，不抛异常。

    计时**从第一个字节到手才开始**：建连、DNS、TLS 握手那段属于延迟，
    算进带宽里就变成了变相 ping —— 曾经就是这么错的。

    UA 用浏览器的：几个模型站对陌生 UA 会返回 403 或跳登录页，
    那样测出来是「连不上」，而实际下载时 modelscope 库用的是正常 UA。
    """
    got = 0
    t0 = None                        # 收到第一块数据才开始计时
    try:
        req = urllib.request.Request(
            src['probe'],
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as r:
            while True:
                b = r.read(CHUNK)
                if not b:
                    break            # 文件读完了（探测文件够大，通常轮不到）
                if t0 is None:
                    t0 = time.time()
                    continue         # 第一块不计入：它包含了服务端首字节延迟
                got += len(b)
                if time.time() - t0 >= seconds:
                    break
    except Exception as e:
        out[src['id']] = {'bps': 0, 'error': str(e)[:80]}
        return
    if t0 is None or got == 0:
        out[src['id']] = {'bps': 0, 'error': '连上了但没数据'}
        return
    dt = max(time.time() - t0, 0.001)
    out[src['id']] = {'bps': got / dt, 'error': ''}


def probe_all(sources=None, seconds=PROBE_SECONDS):
    r"""并发测所有源。返回 [{id, name, bps, error, ...}]，按快慢排序。

    **并发**：串行测三个源要 7 秒以上，人会以为卡住了。
    """
    sources = sources or MODEL_SOURCES
    out, threads = {}, []
    for s in sources:
        t = threading.Thread(target=_probe_one, args=(s, out, seconds), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout=PROBE_TIMEOUT + 2)

    rows = []
    for s in sources:
        r = out.get(s['id'], {'bps': 0, 'error': '测速没跑完'})
        rows.append(dict(s, bps=r['bps'], error=r['error']))
    # 快的在前；测不通的沉底
    rows.sort(key=lambda x: -x['bps'])
    return rows


# 🔴 本地版这里还有 `eta_words`（把剩余时间说成「约 3 分钟」）。
#    云端版删了 —— 更新包只有 0.4 MB，秒下，没有「预计还要多久」这回事。

def pick_best(rows):
    """选最快的那个。全都连不上时返回 None，由调用方决定怎么说。"""
    for r in rows:
        # .get 而不是 [] —— 这个函数收的 dict 来自好几个地方
        # （probe_all、update.probe_mirrors 的小包捷径、以后可能还有别的），
        # 少一个字段就整个更新功能崩掉，代价跟收益完全不成比例。
        # 2026-09-02 就是这么炸的：update 那边给的是 speed 不是 bps。
        if r.get('bps', 0) > 0:
            return r
    return None


# 🔴 本地版这里还有一个断点续传的 `download`，服务的是 4.6 GB 的模型。
#    云端版删了：更新包 0.4 MB，update.py 里的 `_fetch_one` 够用，
#    多留一个没人调的下载器只会让人分不清该用哪个。
