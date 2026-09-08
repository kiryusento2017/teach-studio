# -*- coding: utf-8 -*-
r"""组装发行版。

跑法：

    .venv\Scripts\python.exe tools\build_release.py --version v0.0.1
    .venv\Scripts\python.exe tools\build_release.py --version v0.0.1 --update-only

产出两样，都落在 `dist/`：

    teach-studio-<版本>-update.zip   只有业务代码，约 1 MB —— 日常更新用
    teach-studio-<版本>-full.zip     完整发行版，几百 MB —— 首次安装用
    requires.json                    这一版要哪些 pip 包，跟 Release 一起传

## 为什么分成两个包

改动的永远只是业务代码那几百 KB。Electron 380 MB、pandoc 222 MB、
Python 运行时 50 MB 一年到头不动 —— 每次更新都推一遍是耍流氓。

检查更新只下 update.zip，解压覆盖即可（见 `pipeline/update.py`）。

## 🔴 打包必须带上 runtime/ 整个目录

    runtime/pandoc/pandoc.exe      出 docx 骨架，漏了一份都转不出来
    runtime/xsl/MML2OMML.XSL       转公式，漏了能出 Word 但公式全不是原生的
    runtime/node.exe               跑 KaTeX，漏了一个公式都转不成

前两样在 git 里（pandoc.exe 太大不在，从开发机拷），node.exe 从系统 PATH 找。

## 跨平台

**目前只支持在 Windows 上打 Windows 包。**

macOS / Linux 理论上可行（代码里可执行文件名、路径分隔都按平台走了，
见 `paths._exe_name`），但有两处得先解决，而且都要在真机上验：

  · Python 分发方式不同 —— Windows 有官方 embeddable zip，macOS 没有，
    得换 python-build-standalone 之类
  · macOS 的 .app 放进 /Applications 是只读的，而这软件要往自己目录写
    logs/token.json —— 要么让用户放可写位置，要么改走 ~/Library

**安卓 / iOS 打不了**，不是难是不成立：Electron 不支持移动端，pandoc 没有
移动端二进制，iOS 也不允许运行时执行下载的代码。而且产物是 .docx，
用户要在电脑上用 Word/WPS 编辑公式 —— 手机上转完然后呢。
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, 'dist')

# 产物目录用英文。中文路径要经过 Electron → Python 子进程 → pandoc 好几手。
OUT = os.path.join(DIST, 'PDF2Word')

REPO_NAME = 'teach-studio'

PY_VER = '3.12.10'
EMBED_URL = ('https://www.python.org/ftp/python/%s/python-%s-embed-amd64.zip'
             % (PY_VER, PY_VER))
GETPIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

# 双击的那个 exe 叫什么。这是用户唯一会点的东西，用中文名友好；
# 文件名不是路径的一部分，不影响「路径别用中文」那条规矩。
APP_EXE = 'PDF转Word.exe'

# 业务代码：拷这些，别的一概不拷（测试、文档、开发脚本都不该发给用户）。
# app 下那几样放进 resources/app —— Electron 改名后的 exe 会自动找那儿，
# 双击就能开，不用再弹 cmd 黑框。
CODE = [
    ('pipeline', 'pipeline'),
    ('server', 'server'),
    ('app/main.js', 'resources/app/main.js'),
    ('app/preload.js', 'resources/app/preload.js'),
    ('app/package.json', 'resources/app/package.json'),
    ('app/icon.ico', 'resources/app/icon.ico'),
    ('app/renderer', 'resources/app/renderer'),
    ('runtime/pandoc', 'runtime/pandoc'),
    ('runtime/xsl', 'runtime/xsl'),
    ('LICENSE', 'LICENSE'),
]

# 更新包里放什么。**刻意不含 runtime/** —— 那些不会变，加进来包就从
# 1 MB 变成 700 MB。
UPDATE_PARTS = [
    ('pipeline', 'pipeline'),
    ('server', 'server'),
    ('app/main.js', 'resources/app/main.js'),
    ('app/preload.js', 'resources/app/preload.js'),
    ('app/package.json', 'resources/app/package.json'),
    ('app/icon.ico', 'resources/app/icon.ico'),
    ('app/renderer', 'resources/app/renderer'),
    ('version.json', 'version.json'),
]

# 🔴 **从代码里真正 import 的东西倒推**，不是从本地版抄一份。
#
#    第一版直接抄了本地版的清单，里面有个 python-docx —— 这边根本没用
#    （出 Word 走的是 pandoc + lxml 改 XML，不经过 python-docx）。
#    发出去的话客户端比对 requires.json 会说「缺 python-docx」，
#    **拒绝掉所有更新**，检查更新功能当场废掉。
#
#    pydantic 反过来：它是 fastapi 的依赖，会被自动装上，但业务代码
#    直接 import 了它（server/main.py 的请求体模型），所以要显式列出。
DEPS = ['pymupdf', 'lxml', 'fastapi', 'uvicorn', 'pydantic', 'requests']

REQUIRES_NAME = 'requires.json'
VERSION_NAME = 'version.json'


def say(msg):
    print('  ' + msg, flush=True)


def rm(path):
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    elif os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass


def fetch(url, dest):
    say('下载 %s' % os.path.basename(dest))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as r, \
            io.open(dest, 'wb') as f:
        shutil.copyfileobj(r, f)


# ── 各层 ───────────────────────────────────────────────────────────────

def put_python(out):
    r"""放 Python embeddable 并让它能 import 第三方包。

    🔴 embeddable 默认 `sys.path` 只有 python312.zip 和自己那一层，而且
       `import site` 是注释掉的 —— 不改这两处，pip 装了也 import 不到。
    """
    py_dir = os.path.join(out, 'runtime', 'python')
    os.makedirs(py_dir, exist_ok=True)
    zp = os.path.join(DIST, os.path.basename(EMBED_URL))
    if not os.path.isfile(zp):
        fetch(EMBED_URL, zp)
    with zipfile.ZipFile(zp) as z:
        z.extractall(py_dir)

    pth = None
    for fn in os.listdir(py_dir):
        if fn.endswith('._pth'):
            pth = os.path.join(py_dir, fn)
    if not pth:
        raise SystemExit('embeddable 包里没有 ._pth，结构变了')
    s = io.open(pth, encoding='utf-8').read()
    s = s.replace('#import site', 'import site')
    if 'Lib\\site-packages' not in s:
        s = s.replace('python312.zip\n.', 'python312.zip\n.\nLib\\site-packages')
    io.open(pth, 'w', encoding='utf-8').write(s)
    say('Python embeddable %s 就位（含 stdlib，自包含）' % PY_VER)

    exe = os.path.join(py_dir, 'python.exe')
    gp = os.path.join(DIST, 'get-pip.py')
    if not os.path.isfile(gp):
        fetch(GETPIP_URL, gp)
    subprocess.run([exe, gp, '--no-warn-script-location', '-q'], check=True)
    say('pip 就位')
    return exe


def install_deps(py_exe):
    say('装依赖：%s' % ' '.join(DEPS))
    subprocess.run([py_exe, '-m', 'pip', 'install', '-q',
                    '--no-warn-script-location'] + DEPS, check=True)
    say('依赖就位')


def put_electron(out):
    r"""Electron 运行时**摊在根目录**，exe 改成中文名。

    这是 Electron 应用的标准形态：exe 旁边一堆 dll，代码在 resources/app。
    改名之后双击 exe 直接开窗 —— 不用再靠一个 .cmd 去调它，那会弹个黑框，
    既难看用户还不敢关。

    只拷 dist/，electron 包里其余是 TypeScript 定义、安装脚本这些开发用的。
    """
    src = os.path.join(ROOT, 'app', 'node_modules', 'electron', 'dist')
    if not os.path.isdir(src):
        raise SystemExit('找不到 electron/dist，先在 app/ 里跑一次 npm install')
    for name in os.listdir(src):
        s_path = os.path.join(src, name)
        d_path = os.path.join(out, name)
        if os.path.isdir(s_path):
            rm(d_path)
            shutil.copytree(s_path, d_path)
        else:
            shutil.copy2(s_path, d_path)
    old = os.path.join(out, 'electron.exe')
    new = os.path.join(out, APP_EXE)
    if os.path.isfile(old):
        rm(new)
        os.rename(old, new)
    say('Electron 运行时就位，主程序 %s' % APP_EXE)


def put_node(out):
    r"""node.exe。**必须打包** —— 用户电脑上不会有 Node.js，那是开发者
    工具，而 KaTeX 要靠它把 LaTeX 转成 MathML。不打包的话一个公式都转不成。
    """
    src = shutil.which('node')
    if not src:
        raise SystemExit('本机找不到 node，装一个再打包')
    dst = os.path.join(out, 'runtime', 'node.exe')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    say('node.exe 就位（%.0f MB）' % (os.path.getsize(dst) / 1024 / 1024))


def put_code(out, parts):
    for rel, to in parts:
        s = os.path.join(ROOT, rel.replace('/', os.sep))
        d = os.path.join(out, to.replace('/', os.sep))
        if not os.path.exists(s):
            say('跳过（不存在）：%s' % rel)
            continue
        os.makedirs(os.path.dirname(d), exist_ok=True)
        if os.path.isdir(s):
            rm(d)
            shutil.copytree(s, d, ignore=shutil.ignore_patterns(
                '__pycache__', '*.pyc', '_tmp', 'node_modules'))
        else:
            shutil.copy2(s, d)
    say('业务代码就位')


def put_readme(out, version):
    r"""发行版根目录那份给用户看的说明。

    ⚠️ 这段文字是**用户在软件之外唯一能看到的说明**（Release 页面的发布
       说明得联网才看得到，而且他们多半是直接拿到一个 zip）。所以两件事
       必须写在最前面：**放哪儿**、**要准备什么**。

    本地版这份的开头是「要有 N 卡」「要装 Office」，云端版这两条都没了 ——
    这正是云端版存在的理由。但「别放 C:\Program Files」那条照旧要写：
    软件运行时要往自己文件夹里写 token、历史、临时文件，放进那儿会写不了。
    """
    txt = (
        'PDF 转 Word · 云端版  __VER__\r\n'
        '\r\n'
        '把 PDF 讲义转成 Word。文字、公式、表格、图片都是原生对象，不是截图；\r\n'
        '公式是 Word 原生公式，可以直接双击编辑、可以被搜索。\r\n'
        '\r\n'
        '\r\n'
        '=== 放哪儿（重要）===\r\n'
        '\r\n'
        '把整个文件夹解压到 D 盘之类的地方，比如 D:\\软件\\PDF2Word。\r\n'
        '\r\n'
        '⚠ 不要放进 C:\\Program Files —— 那个位置写不了文件。软件要往自己\r\n'
        '  文件夹里存 token、转换历史和临时文件，放进去会打不开。\r\n'
        '  （真放进去了软件会告诉你，不会闷着出错。）\r\n'
        '\r\n'
        '路径里可以有中文、空格和括号，都验过。\r\n'
        '\r\n'
        '\r\n'
        '=== 怎么用 ===\r\n'
        '\r\n'
        '1. 双击「PDF转Word.exe」\r\n'
        '\r\n'
        '2. 第一次打开会让你填一个 MinerU 的 API token。去这里注册，免费：\r\n'
        '\r\n'
        '       https://mineru.net/apiManage/token\r\n'
        '\r\n'
        '   用手机号注册一个账号，在那个页面创建 token，复制回来粘进去。\r\n'
        '   （设置页里有「复制地址」，粘到浏览器就行。）\r\n'
        '\r\n'
        '3. 把 PDF 拖进窗口，点「开始转换」\r\n'
        '\r\n'
        '\r\n'
        '=== 不用装什么 ===\r\n'
        '\r\n'
        '  · 不用装 Office（转公式要的那个文件已经打包进来了）\r\n'
        '  · 不用装 Python、Node.js\r\n'
        '  · 不用独立显卡\r\n'
        '\r\n'
        '转出来的 .docx 用 Word 或 WPS 都能打开。\r\n'
        '\r\n'
        '\r\n'
        '=== 关于额度 ===\r\n'
        '\r\n'
        '解析在 MinerU 的服务器上跑，每个账号每天有额度：\r\n'
        '\r\n'
        '  · 1000 页优先解析（超了不是不给用，是排队慢一点）\r\n'
        '  · 5000 个文件\r\n'
        '\r\n'
        '不够用的话可以多注册几个号 —— 一个手机号一个，微信还能再注册一个。\r\n'
        '在设置里点「+ 添加」把它们都填进去，软件会自动挑今天用得少的那个，\r\n'
        '某个号满了自动换下一个。\r\n'
        '\r\n'
        '同一份 PDF 转第二次不重复扣额度（按文件内容记的，换个名字、换个\r\n'
        '目录也认得出来）。\r\n'
        '\r\n'
        '\r\n'
        '=== 要注意的 ===\r\n'
        '\r\n'
        '⚠ 文件会上传到 MinerU 的服务器解析。不能外传的材料别用这个转。\r\n'
        '\r\n'
        '⚠ 「停止」只是不再等结果 —— 任务已经交出去了，那边照样跑完、\r\n'
        '  额度照扣。\r\n'
        '\r\n'
        '\r\n'
        '=== 其他 ===\r\n'
        '\r\n'
        '所有东西都在这个文件夹里，不往系统盘塞。不想用了直接删掉整个\r\n'
        '文件夹就行，转好的 Word 不受影响。\r\n'
        '\r\n'
        '要更新的话：设置页最下面点「检查更新」，会自动下载安装。\r\n'
    ).replace('__VER__', version)
    io.open(os.path.join(out, '使用说明.txt'), 'w', encoding='utf-8',
            newline='').write(txt)


def write_version(path, tag, sha=''):
    r"""记下这个包是哪个 Release。

    `published_at` 打包时留空 —— 那时候还没发布，填不出来。检查更新
    读不到它就退回比版本号，那条路本来就是主判据。
    """
    io.open(path, 'w', encoding='utf-8').write(
        json.dumps({'tag': tag, 'published_at': '', 'sha': sha},
                   ensure_ascii=False, indent=2))


def write_requires(path):
    r"""这一版需要哪些 pip 包，从**实际装的**里读，不是手写的。

    🔴 客户端拿它跟本地比对：缺了或者大版本对不上就拒绝覆盖。
       为什么不能只靠版本号 —— 「次版本变了就是依赖变了」是个约定，
       靠发版的人不出错。哪天加了个包却只改修订号，用户就会拿到新代码
       配旧依赖，下次启动直接 ImportError，而他刚「更新成功」过。
    """
    try:
        import importlib.metadata as md
    except Exception:
        md = None
    req = {}
    for name in DEPS:
        key = name.split('[')[0]
        try:
            req[key] = md.version(key) if md else ''
        except Exception:
            req[key] = ''
    io.open(path, 'w', encoding='utf-8').write(
        json.dumps({'requires': req}, ensure_ascii=False, indent=2))
    return req


def _zip_dir(src, zf, base=''):
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in ('__pycache__', 'node_modules')]
        for fn in files:
            if fn.endswith('.pyc'):
                continue
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, src)
            zf.write(p, os.path.join(base, rel) if base else rel)


def make_update_zip(version):
    """打业务代码更新包。用户下载后解压覆盖即可。"""
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, '%s-%s-update.zip' % (REPO_NAME, version))
    rm(out)

    tmp = os.path.join(DIST, '_update_tmp')
    rm(tmp)
    os.makedirs(tmp)
    write_version(os.path.join(ROOT, VERSION_NAME), version)
    put_code(tmp, UPDATE_PARTS)
    # 依赖清单也进更新包 —— 客户端解压之后、覆盖之前再验一道
    write_requires(os.path.join(tmp, REQUIRES_NAME))

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        _zip_dir(tmp, zf)
    rm(tmp)
    say('更新包：%s（%.2f MB）'
        % (os.path.basename(out), os.path.getsize(out) / 1024.0 / 1024))
    return out


def make_full_zip(version):
    out = os.path.join(DIST, '%s-%s-full.zip' % (REPO_NAME, version))
    rm(out)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        _zip_dir(OUT, zf, base='PDF2Word')
    say('完整包：%s（%.0f MB）'
        % (os.path.basename(out), os.path.getsize(out) / 1024.0 / 1024))
    return out


def sha256(p):
    h = hashlib.sha256()
    with io.open(p, 'rb') as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', required=True, help='例如 v0.0.1')
    ap.add_argument('--update-only', action='store_true',
                    help='只打更新包，不组装完整发行版（快，几秒）')
    a = ap.parse_args()

    if os.name != 'nt':
        raise SystemExit('目前只支持在 Windows 上打包，理由见本文件开头')

    ver = a.version if a.version.startswith('v') else ('v' + a.version)
    os.makedirs(DIST, exist_ok=True)

    print('打包 %s' % ver, flush=True)
    print('=' * 56, flush=True)

    up = make_update_zip(ver)
    req_path = os.path.join(DIST, REQUIRES_NAME)
    req = write_requires(req_path)
    say('依赖清单：%s' % ', '.join('%s %s' % kv for kv in req.items()))

    full = None
    if not a.update_only:
        print(flush=True)
        say('组装完整发行版（几百 MB，要几分钟）…')
        rm(OUT)
        os.makedirs(OUT, exist_ok=True)
        py = put_python(OUT)
        install_deps(py)
        put_electron(OUT)
        put_node(OUT)
        put_code(OUT, CODE)
        put_readme(OUT, ver)
        say('使用说明.txt 就位')
        shutil.copy2(os.path.join(ROOT, VERSION_NAME),
                     os.path.join(OUT, VERSION_NAME))
        shutil.copy2(req_path, os.path.join(OUT, REQUIRES_NAME))
        full = make_full_zip(ver)

    print(flush=True)
    print('=' * 56, flush=True)
    print('产物在 dist/：', flush=True)
    for p in [up, req_path] + ([full] if full else []):
        print('  %-44s %8.2f MB  sha256=%s'
              % (os.path.basename(p), os.path.getsize(p) / 1024.0 / 1024,
                 sha256(p)[:16]), flush=True)
    print(flush=True)
    print('下一步：把它们传成 Release', flush=True)
    print('  gh release create %s dist\\%s dist\\%s%s --title "%s" --notes "..."'
          % (ver, os.path.basename(up), REQUIRES_NAME,
             (' dist\\' + os.path.basename(full)) if full else '', ver),
          flush=True)


main()
