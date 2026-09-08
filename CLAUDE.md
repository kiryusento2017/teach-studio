# 接手这个项目，先看这里

PDF 转 Word 的**云端版**：识别走 MinerU 的云端 API，出 Word 的管线是从
本地版 `pdf_to_word` 原样搬过来的（那个项目在同一台机器上，路径问接手的人要）。

**这个项目存在的理由是：公式必须是 Word 原生公式**（能双击编辑、能被搜索）。
别的都可以让步，这条不行。

## 三步进入状态

```powershell
# 1. 看项目在说什么
type README.md

# 2. 跑测试（应该全绿：后端 84 条、前端 43 条）
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

见 `_scratch\token_multi_progress.md` 末尾。截至 2026-09-08 主要是：

1. **打包脚本还没写** —— 检查更新已经能用了，但它依赖 `version.json`
   （打包时写进去，记下这个包是哪个 Release）和 Release 里的
   `requires.json`（依赖清单）。这两样都得由打包脚本产出，现在还没有。
   在那之前 `local_version()` 一直返回 `(未知)`。
2. **单次页数上限存疑** —— 代码 `MAX_PAGES=600`，官方文档写 200。没确认，没动。
3. **每日额度存疑** —— 文档写 1000 页且是「超了降优先级」，不是硬停。
4. **WPS 能不能双击编辑 OMML 公式** —— 三个用户都用 WPS，这条没实测过。
   `_scratch\cloud_out.docx` 打开就能验。
5. **还没打包过** —— `tools/` 是空的，没有 requirements.txt。
   打包时**必须带上 `runtime/` 整个目录**：漏了 `pandoc.exe` 一份都转不出来，
   漏了 `xsl/MML2OMML.XSL` 能出 Word 但公式全不是原生的。
