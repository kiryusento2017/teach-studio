# 接手这个项目，先看这里

PDF 转 Word 的**云端版**：识别走 MinerU 的云端 API，出 Word 的管线是从
本地版 `pdf_to_word` 原样搬过来的（那个项目在同一台机器上，路径问接手的人要）。

**这个项目存在的理由是：公式必须是 Word 原生公式**（能双击编辑、能被搜索）。
别的都可以让步，这条不行。

## 三步进入状态

```powershell
# 1. 看项目在说什么
type README.md

# 2. 跑测试（应该全绿：后端 115 条、前端 85 条）
.venv\Scripts\python.exe -m unittest discover -s tests -q
node tests\front_check.js

# 3. 看上次干到哪了
type _scratch\token_multi_progress.md
```

🔴 **进度档在 `_scratch\` 下，不在 git 里**（`_scratch/` 被 ignore）。
跨会话续接必须先读它，否则会从零摸索。

## 改代码之前必须知道的六条

**一、行尾是混的。** `pipeline/*.py`、`server/main.py`、`app/renderer/*.js`、
`tests/*` 是 LF；`pipeline/todocx.py`、`app/main.js`、`app/preload.js` 是 CRLF。
`sed -i` 会把 CRLF 全换成 LF，整个文件变成一片 diff。改文件用 Python
`io.open(..., newline='')` 读写，或者先数一下 `b'\r\n'` 再决定。

**二、token 原文不许离开 `store` 模块。** 显示、日志、历史、报错里一律用
`store.masked()`。账本 `logs/usage.json` 存的是 sha256 指纹，不是原文。
有测试盯着这两条。

**三、后端加了接口就必须有前端调用点。** `Test前后端契约` 会扫 `srv.app.routes`
和前端源码，对不上就红。这条是从本地版那五处「功能写好了没人调」学来的。
（它自己也被将过一军：原先对拼接型路径是硬编码假定，2026-09-08 改成真解析了。）

**四、`MML2OMML.XSL` 是微软的版权文件。** 内置在 `runtime/xsl/` 里，是作者
2026-09-08 拍板的，前提是这软件只发给几个熟人。要给外人用之前必须换掉
（texmath / fiduswriter-mathml2omml 那几个开源的），产物放同一位置即可。

**五、开发机上验不了「没装 Office 也能用」。** 开发机装着 Office，代码可能走
注册表那条路，测出来的「能用」是假的。要验就得像 `Test自带的XSL` 那样，
把 `registry_candidates` 和 `XSL_CANDIDATES` 全堵死。

**六、`pandoc.exe` 222 MB，别让它进 git。** 已经在 `.gitignore` 里。GitHub
单文件上限 100 MB，进了历史就 push 不上去。

## 结构

```
pipeline/mineru_api.py   云端四步：申请上传位 → PUT → 轮询 → 下载解压
pipeline/convert.py      编排：probe → 云端 → todocx，以及多 token 换号
pipeline/store.py        token（1~10 个槽）、每天页数记账、转换历史
pipeline/todocx.py       出 Word。**从本地版逐字节搬来，别乱动**
pipeline/tomath.py       LaTeX → MathML → OMML
pipeline/update.py       检查更新：GitHub Release + 多镜像并发赛跑
pipeline/sources.py      并发测速挑最快的源（从本地版裁来，只留测速那一半）
server/main.py           本地 HTTP，绑 127.0.0.1，端口随机
app/                     Electron 外壳 + 无框架前端（全局 state + 整页重绘）
```

## 几个容易踩空的设计决定

- **一份 PDF 拆不开。** 30 页的文件不能 3 页给 1 号 token、27 页给 2 号，
  拆了出来是两份 Word，跨页的表格和公式会断。所以调度只能整份挑号。
- **额度只用来挑号，不用来拦人。** 本地账只算得到经本软件用掉的量，天生偏小；
  官方措辞又是「超出部分优先级降低」，超额未必是硬拒绝。真到顶了以服务端
  返回的 `-60018` 为准。
- **`pick_order` 没有「够不够」的筛选层。** 剩得多的号必然先够，那层是冗余的
  （加过又拆了）。真正有用的是 `all_short()` 给的提醒。
- **worker 里「取下一份」和「标记收工」在同一把锁里。** 分开写的话，正好卡在
  中间 append 进来的文件会永远没人转，界面却显示已完成。
- **停止只停「等」，不停「算」。** 任务交出去就在云端跑，额度照扣。界面上
  不要承诺能取消。

## 待办 / 悬而未决

进度档在 `_scratch\` 下：`token_multi_progress.md`（多 token / 双队列那一轮）、
`ui_parity_progress.md`（2026-09-09 跟本地版对齐那一轮）。截至 2026-09-09：

1. **一次都没真机验证过对齐那一轮的界面。** 2026-09-09 改了 9 个屏
   （关于页、连不上后台屏、拦截屏、日志屏、更新整屏、待转清单、底栏、
   报告页、历史页），全部只过了测试，没开窗看。
2. **单次页数上限存疑** —— 代码 `MAX_PAGES=600`，官方文档写 200。没确认，没动。
3. **每日额度存疑** —— 文档写 1000 页且是「超了降优先级」，不是硬停。
4. **WPS 能不能双击编辑 OMML 公式** —— 三个用户都用 WPS，这条没实测过。
   `_scratch\cloud_out.docx` 打开就能验。
5. **文件数没记账** —— `store.py` 只记页数（`DAILY_PAGES=1000`），MinerU 还
   限每天 5000 个文件，那个数一个字都没记。实际碰不到，但账是不全的。
6. **每日用量按本机日期归零** —— `_today()` 用的是 `time.strftime('%Y-%m-%d')`，
   而 MinerU 按哪个时区重置查不到。跨零点那几小时账面可能偏乐观，
   真到顶了以服务端 `-60018` 为准。
7. **PyMuPDF 是 AGPL-3.0**，本项目声明 GPL-3.0-or-later。相不相容不是代码
   问题，得找懂的人看。见 `docs/UI_PARITY_DECISIONS.md` 的挂起清单。

## 界面一致性

跟本地版 `pdf_to_word` 的对照结论全在 `docs/UI_PARITY_DECISIONS.md`。
**改界面前先翻一眼**：记了「不改」的别再改回去，那是决定不是遗漏 ——
尤其 F 类那五条（httpGet 判 r.ok、404 停轮询、errBar 可关、按钮没接上会
报错、每行移除），云端做得比本地版对，照本地版改等于把 bug 抄回来。

## 发版

`docs/RELEASE.md` 是发版规矩，**每次从头照着走一遍**。三条最容易栽的：
打包前工作区必须干净（`version.json` 记的是 HEAD 的 sha，脏工作区等于那个
sha 在说谎）、手动改 `app/package.json` 的 `version`（打包脚本不碰它，
且不带 `v` 前缀）、转正是**两条**命令（`--prerelease=false` 之后还要
`--latest`，漏了会让所有用户的「检查更新」静默失灵，而 Release 页面上
看着一切正常）。
