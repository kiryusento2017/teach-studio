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
# 目录、安装包、更新包一律叫 teach-studio（作者 2026-09-09 定）——
# 这软件是「教学工作台」，PDF 转 Word 只是它第一个功能，产物名不该钉死
# 在单个功能上。双击的那个 exe 保留中文名，那是给人看的。
OUT = os.path.join(DIST, 'teach-studio')

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
# 🔴 **runtime/xsl 是唯一进更新包的 runtime 内容**（190 KB，可忽略）。
#    本地版 2026-09-09 才想明白这条：放在 runtime/ 下的修复，老用户点
#    「检查更新」拿不到 —— 那次改动对他们等于没做。XSL 哪天换成开源实现，
#    不带它老用户永远换不掉。python/pandoc/node 加进来会让包从 0.5 MB
#    涨到几百 MB，那条原则仍然成立。
UPDATE_PARTS = [
    ('runtime/xsl', 'runtime/xsl'),
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


def git_state():
    r"""HEAD 的 sha 和工作区脏不脏。

    🔴 这两样都是 `docs/RELEASE.md` 明文要求的，2026-09-09 发 v0.0.1 时
       发现**规矩写了、代码没做**：version.json 里的 sha 一直是空串，
       而那份文档写着「排查问题时以 version.json 里的 sha 为准，别信 tag」。
       一份说了谎的文档比没有更糟。
    """
    sha = dirty = ''
    try:
        p = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                           stdout=subprocess.PIPE, timeout=10)
        sha = p.stdout.decode('ascii', 'ignore').strip()
        q = subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT,
                           stdout=subprocess.PIPE, timeout=20)
        dirty = q.stdout.decode('utf-8', 'replace').strip()
    except Exception:
        pass
    return sha, dirty


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
       说明得联网才看得到，而且他们多半是直接拿到一个安装包）。所以两件事
       必须写在最前面：**放哪儿**、**要准备什么**。

    🔴 **每一段只占一行，不硬换行**（作者 2026-09-09 定）。

       第一版是按 40 多个字硬折行写的，在宽窗口里看就是左边一条，右边
       大片空白。现在的记事本默认开着自动换行，让它自己按窗口宽度折 ——
       用户把窗口拉多宽，文字就铺多宽。硬折行等于替用户决定了行宽，
       而那个宽度只在写的人的窗口里好看。

       段与段之间空一行，靠空行分段，不靠折行分段。
    """
    L = [
        'teach-studio · PDF 转 Word（云端版）  __VER__',
        '',
        '把 PDF 讲义转成 Word。文字、公式、表格、图片都是原生对象，不是截图；公式是 Word 原生公式，可以直接双击编辑、可以被搜索。',
        '',
        '',
        '=== 放哪儿（重要）===',
        '',
        '装到 D 盘之类的地方，比如 D:\\teach-studio。',
        '',
        '⚠ 不要装进 C:\\Program Files —— 那个位置写不了文件。软件要往自己文件夹里存 token、转换历史和临时文件，装进去会打不开。（真装进去了软件会告诉你，不会闷着出错。）',
        '',
        '路径里可以有中文、空格和括号，都实测过。',
        '',
        '',
        '=== 怎么用 ===',
        '',
        '1. 双击「PDF转Word.exe」',
        '',
        '2. 第一次打开会让你填一个 MinerU 的 API token。去 https://mineru.net/apiManage/token 注册，免费。用手机号注册一个账号，在那个页面创建 token，复制回来粘进去。（设置页里有「复制地址」，粘到浏览器就行。）',
        '',
        '3. 把 PDF 拖进窗口，点「开始转换」',
        '',
        '',
        '=== 不用装什么 ===',
        '',
        '不用装 Office（转公式要的那个文件已经打包进来了），不用装 Python 和 Node.js，不用独立显卡。转出来的 .docx 用 Word 或 WPS 都能打开。',
        '',
        '',
        '=== 关于额度 ===',
        '',
        '解析在 MinerU 的服务器上跑，每个账号每天有额度：1000 页优先解析（超了不是不给用，是排队慢一点）、5000 个文件。',
        '',
        '不够用的话可以多注册几个号 —— 一个手机号一个，微信还能再注册一个。在设置里点「+ 添加」把它们都填进去，软件会自动挑今天用得少的那个，某个号满了自动换下一个。',
        '',
        '同一份 PDF 转第二次不重复扣额度（按文件内容记的，换个名字、换个目录也认得出来）。',
        '',
        '',
        '=== 要注意的 ===',
        '',
        '⚠ 文件会上传到 MinerU 的服务器解析。不能外传的材料别用这个转。',
        '',
        '⚠ 「停止」只是不再等结果 —— 任务已经交出去了，那边照样跑完、额度照扣。',
        '',
        '',
        '=== 其他 ===',
        '',
        '所有东西都在这个文件夹里，不往系统盘塞。不想用了直接删掉整个文件夹就行，转好的 Word 不受影响。',
        '',
        '要更新的话：设置页最下面点「检查更新」，会自动下载安装。',
        '',
    ]
    txt = (chr(13) + chr(10)).join(L).replace('__VER__', version)
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


def make_update_zip(version, sha=''):
    """打业务代码更新包。用户下载后解压覆盖即可。"""
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, '%s-%s-update.zip' % (REPO_NAME, version))
    rm(out)

    tmp = os.path.join(DIST, '_update_tmp')
    rm(tmp)
    os.makedirs(tmp)
    write_version(os.path.join(ROOT, VERSION_NAME), version, sha)
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
        _zip_dir(OUT, zf, base='teach-studio')
    say('完整包：%s（%.0f MB）'
        % (os.path.basename(out), os.path.getsize(out) / 1024.0 / 1024))
    return out


# ── 自解压安装包 ───────────────────────────────────────────────────────
#
# 做 exe 安装包用 7-Zip 的 SFX 模块，整套照本地版 pdf_to_word 搬过来，
# 连它踩过的坑一起。

_7Z_CANDS = [
    r'C:\Program Files\7-Zip\7z.exe',
    r'C:\Program Files (x86)\7-Zip\7z.exe',
]


def find_7z():
    for p in _7Z_CANDS:
        if os.path.isfile(p):
            return p
    return shutil.which('7z') or ''


def make_sfx(version):
    r"""把发行版做成自解压 exe：双击 → 弹框问放哪 → 解压完成 → 打开文件夹。

    用 `7z.sfx`（带界面那个），**不是 `7zCon.sfx`**（控制台版，双击会弹
    黑框）。拼法是：sfx 模块 + 配置 + .7z 数据，三个文件按顺序拼成一个 exe。

    压缩用 `-mx=5`：`-mx=9` 对这堆东西（大量已压缩的 dll 和 wheel）只多省
    几十 MB，却要多花好几倍时间。
    """
    sz = find_7z()
    if not sz:
        raise SystemExit('找不到 7z.exe。装一个：winget install 7zip.7zip')
    sfx = os.path.join(os.path.dirname(sz), '7z.sfx')
    if not os.path.isfile(sfx):
        raise SystemExit('找不到 7z.sfx（7-Zip 的自解压模块）')

    archive = os.path.join(DIST, '_payload.7z')
    rm(archive)

    # 🔴 排除**运行时**产生的东西。组装完通常会在 dist/teach-studio 里真跑一次
    #    （那是验证发行版的必要动作），于是留下一堆本机痕迹：
    #
    #      appdata/     Electron 的 GPU 缓存、Code Cache
    #      _tmp/        转换中转、**还有内容指纹缓存**（别人的产物）
    #      logs/        🔴 里面有 token.json —— 打进包就是把凭据发出去
    #      __pycache__  里面嵌着开发机的源码路径
    #
    #    🔴 `-x!` 不递归，`-xr!` 递归 —— 这一个字母的差别在本地版毁掉过
    #       一整版：v0.0.3 用 `-xr!models` 想排掉根目录那个模型目录，
    #       结果把**所有**叫 models 的目录都剔了（37 个），
    #       pip/_internal/models 一没，用户点安装直接 ModuleNotFoundError。
    #
    #       前四个都是只在根目录出现的名字，用 `-x!` 就够；
    #       后两个必须递归 —— __pycache__ 和 .pyc 本来就散在各处。
    exclude = ['-x!_tmp', '-x!appdata', '-x!logs',
               '-xr!__pycache__', '-xr!*.pyc']
    say('压缩中（要几分钟）…')
    r = subprocess.run([sz, 'a', '-t7z', '-mx=5', '-mmt=on'] + exclude
                       + [archive, os.path.join(OUT, '*')],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        raise SystemExit('压缩失败：%s'
                         % r.stdout.decode('utf-8', 'replace')[-400:])
    say('压缩完 %.0f MB' % (os.path.getsize(archive) / 1024.0 ** 2))

    # SFX 配置。
    #
    # 🔴 **官方 7z.sfx 只认这几个字段**：Title / BeginPrompt / Progress /
    #    RunProgram / Directory / ExecuteFile / ExecuteParameters。
    #
    #    本地版原来还写着 InstallPath、GUIMode、OverwriteMode 等六个，
    #    **官方模块一个都不认，全部静默忽略** —— 那是第三方修改版
    #    7zSD.sfx 的扩展。后果：InstallPath 从 v0.0.1 起就没生效过，
    #    六个安装包的默认路径一直是**安装包自己所在的目录**。
    #    从浏览器下载后双击，默认填的就是「下载」文件夹 —— 那种目录
    #    很多人定期清理，一清就把整个软件删了。
    #
    #    配置里留着不生效的字段比不写更糟：它让人以为设过默认路径了。
    #    所以只写认得的那几个，把这件事直接在 BeginPrompt 里讲给用户。
    cfg = (
        ';!@Install@!UTF-8!\n'
        'Title="PDF 转 Word · 云端版 __VER__"\n'
        'BeginPrompt="要把「PDF 转 Word」装到哪里？\\n\\n'
        '⚠ 下面默认填的是「这个安装包所在的文件夹」。如果你是从浏览器'
        '下载的，那就是「下载」文件夹 —— 请改掉，否则哪天清理下载'
        '文件夹会把整个软件一起删了。\\n\\n'
        '建议填：D:\\\\teach-studio\\n\\n'
        '⚠ 不要选 C:\\\\Program Files —— 那个位置写不了文件，'
        '软件要往自己文件夹里存 token 和转换历史。\\n'
        '路径里可以有中文、空格和括号，都验过。\\n\\n'
        '装完双击里面的「PDF转Word.exe」就能用。不用装 Office，'
        '不用装 Python，不用独立显卡。\\n'
        '所有东西都留在这个文件夹里，不想用了直接删掉即可。"\n'
        'RunProgram="explorer.exe ."\n'
        ';!@InstallEnd@!\n'
    ).replace('__VER__', version)
    cfg_path = os.path.join(DIST, '_sfx_config.txt')
    io.open(cfg_path, 'w', encoding='utf-8').write(cfg)

    # 🔴 文件名用**英文**：GitHub 会把 Release 附件名里的中文吃掉
    #    （PDF转Word-v0.0.1.exe 传上去会显示成 PDF.Word-v0.0.1.exe）。
    exe = os.path.join(DIST, 'teach-studio-Setup-%s.exe' % version)
    rm(exe)
    say('拼装 exe…')
    with io.open(exe, 'wb') as out:
        for part in (sfx, cfg_path, archive):
            with io.open(part, 'rb') as fh:
                shutil.copyfileobj(fh, out, 1024 * 1024)
    rm(archive)
    rm(cfg_path)
    say('安装包：%s（%.0f MB）'
        % (os.path.basename(exe), os.path.getsize(exe) / 1024.0 ** 2))
    return exe


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
    ap.add_argument('--dirty', action='store_true',
                    help='工作区有未提交改动也照打。'
                         '⚠️ 这会让 version.json 里的 sha 变成空串')
    ap.add_argument('--sfx', action='store_true',
                    help='把已组装好的 dist/teach-studio 做成自解压 exe，'
                         '不重新组装（组装过一次之后用这个，省几分钟）')
    a = ap.parse_args()

    if os.name != 'nt':
        raise SystemExit('目前只支持在 Windows 上打包，理由见本文件开头')

    ver = a.version if a.version.startswith('v') else ('v' + a.version)
    os.makedirs(DIST, exist_ok=True)

    # 🔴 **工作区不干净就别打包。**
    #
    #    version.json 里记的是 HEAD 的 sha，而 docs/RELEASE.md 写着
    #    「排查问题时以 version.json 里的 sha 为准，别信 tag」——
    #    有未提交改动的话那个 sha 就是在说谎：包里的代码根本不是那个 commit。
    #    真出问题时，拿那个 sha checkout 出来的跟用户手里跑的不是一回事。
    sha, dirty = git_state()
    if dirty and not a.dirty:
        print('工作区有未提交的改动，打包会让 version.json 里的 sha 说谎：',
              flush=True)
        for line in dirty.splitlines()[:10]:
            print('    ' + line, flush=True)
        raise SystemExit('先提交（或 git stash），'
                         '或者明确加 --dirty 强行打包。')
    if dirty:
        say('⚠️ 带着未提交改动打包，version.json 里的 sha 不可信')
        sha = ''

    print('打包 %s' % ver, flush=True)
    if sha:
        print('  commit %s' % sha[:12], flush=True)
    print('=' * 56, flush=True)

    up = make_update_zip(ver, sha)
    req_path = os.path.join(DIST, REQUIRES_NAME)
    req = write_requires(req_path)
    say('依赖清单：%s' % ', '.join('%s %s' % kv for kv in req.items()))

    full = None
    setup = None

    if a.sfx:
        # 只做 exe，不重新组装 —— 前提是 dist/teach-studio 已经在了
        if not os.path.isdir(OUT):
            raise SystemExit('没有 %s，先跑一次不带 --sfx 的完整打包' % OUT)
        setup = make_sfx(ver)
    elif not a.update_only:
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
        setup = make_sfx(ver)

    print(flush=True)
    print('=' * 56, flush=True)
    print('产物在 dist/：', flush=True)
    for p in [up, req_path] + [x for x in (full, setup) if x]:
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
