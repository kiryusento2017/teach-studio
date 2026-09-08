# -*- coding: utf-8 -*-
r"""路径与外部程序定位。

**这是 `pdf_to_word` 那份 340 行的精简版，砍到只剩云端版真正用得上的。**

砍掉的（云端版不存在这些东西）：

    MODELS / CONFIG            4.6 GB 识别模型、mineru.json —— 云端跑，本地没有
    TMP_EXTRACT                MinerU 子进程的缓存桶 —— 不起子进程
    child_env()                MINERU_DEVICE_MODE=cuda 那一整套环境变量
    models_size / models_ready 同上
    python_exe()               不再起 Python 子进程

留下的只有四样：装在哪、往哪写、怎么找 node.exe、怎么建目录。
"""
import os
import sys

# 安装目录 = 这个文件的上上级。发行版里 pipeline/ 就在根目录下，
# 开发环境同构，所以两边算出来一样。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TMP = os.path.join(ROOT, '_tmp')          # 下载解压的中转站，用完即删
LOGS = os.path.join(ROOT, 'logs')         # 日志 + 转换历史 + token
RUNTIME = os.path.join(ROOT, 'runtime')   # 打包进来的 pandoc / node


def ensure(path):
    """建目录，已存在也不报错。返回它本身，方便串着写。"""
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass
    return path


IS_WINDOWS = os.name == 'nt'


def _exe_name(name):
    """把「node」变成这台机器上该有的文件名。

    Windows 要 `.exe`，macOS/Linux 不要。**只此一处判断** —— 散在各处
    写 `if os.name == 'nt'` 早晚漏一个。
    """
    if not IS_WINDOWS:
        return name[:-4] if name.lower().endswith('.exe') else name
    return name if name.lower().endswith('.exe') else name + '.exe'


def find_exe(name, subdirs=()):
    r"""找一个可执行文件。**发行版和开发环境用同一套查找顺序。**

    顺序（先找到先用）：

      1. `<安装目录>/runtime/<name>`            发行版直接打包的（node）
      2. `<安装目录>/runtime/<子目录>/<name>`    pandoc 走这条
      3. 系统 PATH                              最后的退路

    Windows 上自动补 `.exe`，别的平台不补 —— macOS/Linux 的可执行文件
    没有扩展名。

    🔴 **为什么要有这个函数**：`tomath._NODE` 和 `todocx.PANDOC` 各写各的
       路径的话，发行版要改两处，改漏一处就是「在我这儿好好的」。
       老项目的原话是同一条教训，这里照搬。

    ⚠️ 老项目那份还有「`runtime/python/Scripts/`」和「`.venv/Scripts/`」
       两条候选，是为了找 `mineru.exe` —— 云端版不装 MinerU，删掉。
    """
    exe = _exe_name(name)
    cand = [os.path.join(RUNTIME, exe)]
    for d in subdirs:
        cand.append(os.path.join(RUNTIME, d, exe))
    for p in cand:
        if os.path.isfile(p):
            return p
    # 系统 PATH —— 开发机上通常有 node，发行版里靠上面两条
    for d in (os.environ.get('PATH') or '').split(os.pathsep):
        if not d:
            continue
        p = os.path.join(d.strip('"'), exe)
        if os.path.isfile(p):
            return p
    return ''


def utf8_env(base=None):
    r"""给子进程用的环境：强制 UTF-8。

    只剩 pandoc 和 node 两个子进程要它。不设的话 Windows 上中文路径
    和中文内容会按 GBK 解码，pandoc 直接报错。
    """
    env = dict(base or os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    return env
