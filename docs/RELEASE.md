# 发行版规矩

发一个版本要做什么、不能做什么。**每次发版前从头照着走一遍**，别凭记忆
——这份文件存在的理由就是记忆会出错。

底子是本地版 `pdf_to_word/docs/RELEASE.md`（那边攒了三十多个版本的教训），
条目按云端版的实际情况改过：没有 N 卡要求、不用装 Office、不下模型，
但多了 token 和额度这两件用户要知道的事。

---

## 一、发之前必须做的事

按顺序，一步不能少。

### 1. 测试全绿

```
.venv\Scripts\python.exe -m unittest discover -s tests -q
node tests\front_check.js
```

**红一条都不许发。** 不存在「这条测试早就坏了不用管」——真不用管就该
删掉它，留着等于养一个会说谎的哨兵。

### 2. 界面自己看一遍

改动碰了界面的话，真开窗看。测试断言的是字符串，不是眼睛看到的东西。

```
启动.cmd
```

### 3. 版本号

`v主.次.修`，从 `v0.0.1` 起。

| | 什么情况 |
|---|---|
| 修订号 `v0.0.x` | 只改业务代码（bug 修复、界面调整、文案） |
| 次版本 `v0.x.0` | 依赖变了、或功能有明显变化 |
| 主版本 `vx.0.0` | 用户要重新学怎么用，或者不兼容旧的安装 |

⚠️ **跨多少个版本都不用一个一个更新**。更新包是全量替换（装的是当前
版本的全部业务代码，不是 diff），v0.0.1 直接下 v0.0.9 的包就变成 v0.0.9。

⚠️ 更新包**不会删文件**。哪个版本删掉了某个 `.py`，老用户更新后那个文件
还留在硬盘上。目前无害（没人 import 它）。

🔴 **手动把 `app/package.json` 的 `version` 改成同一个号。**

`build_release.py --version vX.Y.Z` 会写 `version.json` 和「使用说明.txt」，
**唯独不碰 `app/package.json`** —— 它只是被原样拷进发行包。不手动改的话，
每发一版它就更落后一版。写成 `0.0.1` 而不是 `v0.0.1`，不带 `v` 前缀。

### 4. 文档跟上

代码改了策略，README / CLAUDE.md / 这份文件都要同步。判断标准：
**一个没参与过开发的人照着文档做，会不会做错。**

⏳ 本地版有四个自动检查脚本（`check_docs` / `check_claims` /
`check_package` / `check_release`），云端版**还没搬**。在搬过来之前，
这一步全靠人看，本节末尾那份手工清单不能省。

---

## 二、打包

### 🔴 打包前工作区必须干净

`version.json` 里记着 HEAD 的 sha，而排查问题时**以 version.json 里的 sha
为准，别信 tag**。工作区有未提交改动的话，那个 sha 就是在说谎 ——
包里的代码根本不是那个 commit。

先提交，或者 `git stash`。

### 完整安装包（新用户装的）

```
.venv\Scripts\python.exe tools\build_release.py --version v0.0.1
```

组装 `dist\teach-studio\`、装依赖、打 zip、做自解压 exe，一条命令走完。
要下 Python embeddable、装六个依赖、拷 Electron，头一次要几分钟。

### 只做 exe（组装过一次之后）

```
.venv\Scripts\python.exe tools\build_release.py --version v0.0.1 --sfx
```

不重新组装，只把 `dist\teach-studio\` 里**当前**的内容打成 exe。改个 SFX
配置不该重跑一遍完整构建。

⚠️ 它打的是目录里当前的东西。代码改了要先同步，否则打出来的是旧代码：

```
robocopy pipeline dist\teach-studio\pipeline /MIR
robocopy server dist\teach-studio\server /MIR
robocopy app\renderer dist\teach-studio\resources\app\renderer /MIR
robocopy runtime\xsl dist\teach-studio\runtime\xsl /MIR
copy app\main.js app\preload.js app\package.json app\icon.ico ^
     dist\teach-studio\resources\app\
```

🔴 **前端的目标路径是 `resources\app\`，不是 `app\`。** 源码里前端在
`app/`，发行版里在 `resources/app/`（Electron 标准形态）。同步到 `app\`
的话软件根本读不到，而且**不会报错** —— 它会安静地跑着旧的前端代码。

同步完清 `__pycache__`，不然会被打进安装包（里面嵌着开发机的路径）：

```
for /d /r dist\teach-studio %d in (__pycache__) do @rd /s /q "%d" 2>nul
```

### 只做更新包

```
.venv\Scripts\python.exe tools\build_release.py --version v0.0.1 --update-only
```

出 `dist\teach-studio-v0.0.1-update.zip`，约 0.5 MB，几秒钟。

---

## 三、命名规矩

**一律英文。** GitHub 会把 Release 附件名里的中文吃掉——
`PDF转Word-v0.0.1.exe` 传上去会显示成 `PDF.Word-v0.0.1.exe`（「转」变成点）。

| | 名字 |
|---|---|
| 安装包 | `teach-studio-Setup-v0.0.1.exe` |
| 更新包 | `teach-studio-v0.0.1-update.zip` |
| 依赖清单 | `requires.json` |
| 解压出来的目录 | `teach-studio` |
| SFX 默认安装路径 | `D:\teach-studio` |
| 双击的那个 exe | `PDF转Word.exe` ← **这个是中文，故意的** |

产物一律叫 `teach-studio`，不叫 `PDF2Word` —— 这软件是「教学工作台」，
PDF 转 Word 只是它第一个功能，产物名不该钉死在单个功能上。

**界面上的中文全部保留**，那是给用户看的，跟文件系统无关。

---

## 四、发行版长什么样

```
teach-studio/
  PDF转Word.exe          ← 用户双击这个，直接开窗
  resources/app/         ← main.js / preload.js / package.json / renderer
  *.dll *.pak locales/   ← Electron 运行时，摊在根目录
  runtime/python/        ← Python embeddable + 六个依赖
  runtime/pandoc/        ← 出 docx 骨架
  runtime/node.exe       ← 跑 KaTeX
  runtime/xsl/           ← MML2OMML.XSL，转公式
  pipeline/ server/
  version.json  requires.json  使用说明.txt  LICENSE
```

### 🔴 不要用 .cmd 当启动器

早期是 `启动.cmd` 调 `electron.exe .`，会弹一个黑色命令行窗口。正经软件
都是双击一个 exe 直接开窗。改法是把代码放进 `resources/app`，Electron 的
exe 改个名就会自动找到它。`main.js` 里的 `ROOT` 要跟着算多一层：

```js
const ROOT = path.basename(path.dirname(__dirname)) === 'resources'
  ? path.join(__dirname, '..', '..')   // 发行版
  : path.join(__dirname, '..');        // 开发环境
```

（开发环境那个 `启动.cmd` 留着没问题——它只在源码目录用，不进发行包。）

---

## 五、Release 上传

### 🔴🔴 第一条：**一律先发预发行版**

```
gh release create v0.0.1 ^
  "dist\teach-studio-Setup-v0.0.1.exe" ^
  "dist\teach-studio-v0.0.1-update.zip" ^
  "dist\requires.json" ^
  --title "v0.0.1" --notes-file 发布说明.md --prerelease
```

**为什么这条能真正防住事故** —— 不是靠自觉，是靠机制。GitHub 对
`/releases/latest` 的定义是「最近的**非预发行版、非草稿**」，而
`update.py` 查版本走的正是这个端点。所以**只要还挂着预发行版标记，
任何用户的「检查更新」都拿不到它** —— 附件传错了、传到一半断了、
内容不对，全都砸不到用户身上。

### 🔴 转正**不是一条命令**

```
gh release edit v0.0.1 --prerelease=false
gh release edit v0.0.1 --latest          ← 这条不能漏
```

「谁是 latest」是 Release 自己的一个属性，**不是按定义实时算出来的**。
以 `--prerelease` 发布时它压根没被设过，摘掉预发行版标记也不会回头重算。

**漏了第二条的后果正好是最怕的那种**：Release 页面上看着一切正常
（标记没了、附件齐全、tag 也对），而 `update.py` 读的 `releases/latest`
还指着上一版 —— 所有用户的「检查更新」都拿不到新版本，**并且不报任何错**，
界面上显示的是「已是最新」。

**别用眼睛看 Release 页面**，那一页上这个错长得跟正常的一模一样。跑：

```
gh api repos/kiryusento2017/teach-studio/releases/latest --jq .tag_name
```

### 🔴 先 `git push`，再 `gh release create`

**分支名是 `main`。** `gh release create` 不管你推没推，它照发不误，
tag 会打在远端当时的最新 commit 上——也就是上一版的代码。

发完验一次，两个数要一样：

```
gh api repos/kiryusento2017/teach-studio/git/ref/tags/v0.0.1 --jq .object.sha
python -c "import json,io;print(json.load(io.open('dist/teach-studio/version.json',encoding='utf-8'))['sha'])"
```

### 转正之前必须自己走完这几步

1. 三个附件都在，字节数跟本地产物**逐个对得上**
2. 真下载下来，SHA256 跟本地那份**字节级相同**（别只看大小）
3. 解开安装包，`version.json` 里的 sha == 要发的那个 commit
4. tag 指向的 commit == `version.json` 里的 sha
5. **包里没有凭据**：`logs/`、`token.json`、`usage.json`、`runs.json`
   一个都不许有（7z 列一遍，注意它的输出是 GBK 编码）
6. 用**旧版本的身份**跑一次 `check()`：能查到、`need_full=False`、
   挑中的是 update 包不是安装包
   ⚠️ 这一步**转正前做不了** —— `check()` 走的就是 `releases/latest`，
   预发行版按定义不在里面。只能转正之后立刻补做：
   ```python
   sys.path.insert(0, 'pipeline'); import update
   update.local_version = lambda: {'tag': 'v0.0.0', 'sha': '', 'published_at': ''}
   update.check()
   ```

任何一步不过，就**留在预发行版状态**修，别转正。

### ⚠️ `--clobber` 和 `delete-asset` 非到万不得已不要用

它们改的是**已经发出去的东西**。`--clobber` 是先删后传，中断就少一个
附件；`delete-asset` 更是直接删。需要改内容时，正确做法是**发新的
修订号**，不是回头改旧的。

（例外：还没有真实用户的时候。版本号是排查问题的唯一坐标，覆盖它等于
把坐标系搞乱——发给别人之后就不能再这么干了。）

### 一个 Release 挂三个附件

```
teach-studio-Setup-vX.exe       ~180 MB   新用户下这个
teach-studio-vX-update.zip      ~0.5 MB   软件「检查更新」自动下这个
requires.json                   几百字节   依赖清单，下载前判断能不能装
```

依赖清单漏了的话，客户端只能等下完更新包才知道装不装得了——它存在的
意义就是「下载前就知道」。

---

## 六、发布说明写什么

给用户看的，不是给开发者看的。

### 🔴 正文必须以摘要开头，用一条 `---` 隔开

**软件里那个「检查更新」面板只显示分隔线之前那段。**

```markdown
- 新增 转换中还能继续拖文件进来，排在待办里
- 修改 公式识别开了 OCR，比之前多认出三成
- 修复 点开始之后文件在下面又列了一遍

---

## 详细说明

（长篇随便写，用户点「完整说明」才看得到）
```

**摘要每条一行，以「新增 / 修改 / 修复」开头**，三到五条为宜。

⚠️ 分隔线要**独占一行**。Markdown 表格的分隔行（`|---|---|`）不算，
`split_notes()` 只认整行都是连字符的那种。

不写分隔线不会崩——那样全文会被当成摘要，只是用户在 620x440 的窗口里
对着一个残缺的开头发呆。

### 🔴 基准是「用户手里实际是哪一版」，不是「上一个 tag」

有了预发行版机制之后这两个不是一回事：没转正过的版本对用户不存在，
它们带来的变化必须一并写进这一版的说明里。写之前先查：

```
gh api repos/kiryusento2017/teach-studio/releases/latest --jq .tag_name
```

### 🔴 每行铺满，不要硬换行

作者 2026-09-09 定的，**发行版里所有给用户看的文案都适用**（「使用说明.txt」、
安装时弹的那个框、Release 的发布说明）。

第一版的「使用说明.txt」是按 40 多个字硬折行写的，在宽窗口里看就是左边
一条、右边大片空白。**硬折行等于替用户决定了行宽，而那个宽度只在写的人的
窗口里好看。**

正确做法：**一段就是一行**，靠空行分段，不靠折行分段。现在的记事本默认
开着自动换行，用户把窗口拉多宽，文字就铺多宽。

```
差：把整个文件夹解压到 D 盘之类的地方，比如
    D:\软件\teach-studio。
    ⚠ 不要放进 C:\Program Files —— 那个位置写不了
    文件。软件要往自己文件夹里存 token、转换历史

好：装到 D 盘之类的地方，比如 D:\teach-studio。

    ⚠ 不要装进 C:\Program Files —— 那个位置写不了文件。软件要往自己文件夹里存 token、转换历史和临时文件，装进去会打不开。
```

安装包那个 SFX 对话框同理：它会按对话框宽度自己折行，文案里只在**段落
之间**放 `\\n`，段内不放。

### 详细说明里该有的四段

1. **怎么装**——下哪个文件、双击之后干什么、别装 `C:\Program Files`
2. **用之前要知道的**——要一个免费的 MinerU token；**文件会上传**到
   人家服务器解析
3. **不想用了怎么办**——删文件夹即可，干净
4. **以后怎么更新**——软件里点「检查更新」，不用再来 GitHub

改了什么用人话写，一条一句：

```
好： · 公式比之前多认出三成
差： · 修复 _submit 中 is_ocr 参数缺失导致的识别退化
```

---

## 七、这个软件的硬约束（改动时不能破坏的）

### 所有文件留在安装文件夹内

运行中产生的一切都在安装目录里，只有导出的 Word 例外——**删掉文件夹
= 卸载干净**。Electron 的四个路径（`userData`/`sessionData`/`logs`/
`crashDumps`）都重定向到了 `appdata/`。

唯二会碰系统临时目录的是转换和更新时的 `tempfile.mkdtemp`，都有
`finally: rmtree`，实测无残留。

### 凭据只出现在一个地方

token 存 `logs/token.json`，用量账本存指纹不存原文。显示一律打码
（`store.masked`），日志、历史、报错里一个字符都不许有。

🔴 **打包时必须排除 `logs/`** —— 打进包就是把自己的 API 凭据发给所有人。

### 公式必须走 XSL，不降级

Pandoc 那条路会把空集 ∅ 转成直径符号 ⌀、括号不随内容伸缩。宁可报错
也不给次品。

### 额度只用来挑号，不用来拦人

本地账只算得到经本软件用掉的量，天生偏小；页数那条上限又是软的
（超了只是降优先级）。真到顶了以服务端返回的错误码为准。

### 任何耗时操作都不给黑盒

体检、上传、云端解析、下载更新——每一步都要有字在动。

---

## 八、发完之后

1. **自己装一遍**。下载 Release 里的 exe，找一个干净目录真装一次。
   开发机上「能跑」证明不了别人机器上能跑。
2. **验证检查更新**。把 `version.json` 的 tag 改成上一个版本，
   点「检查更新」，确认能查到、挑对包（是 update 不是安装包）、能装上。
3. **在一台不是开发机的电脑上装一次**。这条比什么都重要。
4. **进度档更新**（`_scratch\` 下那份）。

---

## 九、已知的坑

| | 说明 |
|---|---|
| **SmartScreen** | exe 没有代码签名，Windows 会弹「未知发布者」，要点「更多信息 → 仍要运行」。**7z 自解压格式触发率更高**，Edge 可能直接「已阻止此不安全下载」。真发给人时考虑改发 zip，或者微信 / U 盘传 |
| 发行版的 Python 跟开发环境不是一回事 | 发行版用 embeddable 版，目录里有 `python312._pth`；**只要这个文件存在，`sys.path` 就完全由它决定，`PYTHONPATH` 被直接忽略**。凡是靠环境变量或 site 机制生效的东西，必须拿发行版的 `python.exe` 亲自验一遍 |
| 更新包碰不到 `runtime/` 的大件 | python / pandoc / node 不进更新包，放在那儿的修复老用户拿不到。**`runtime/xsl` 是唯一例外**（190 KB） |
| 更新包路径两边不一样 | 前端在源码里是 `app/`，发行版里是 `resources/app/`。`UPDATE_PARTS` 写的是「源路径 → 发行版路径」的映射，写错不会报错，只会安静地只更新一半 |
| 7z 的输出是 GBK | 用 Python 检查安装包内容时按 UTF-8 解码会匹配不到中文文件名，误以为文件没进包。用 `raw.decode('gbk')` |
| GitHub 吃掉附件名里的中文 | `PDF转Word-v0.0.1.exe` 上传后显示成 `PDF.Word-v0.0.1.exe`。附件名一律英文 |
| GitHub 单文件 2 GiB | 安装包 ~180 MB，离上限还远 |
| 「装了但坏了」 | 任何「装完就宣布成功」的地方都要问一句：装上了 ≠ 能用 |

---

## 十、还没搬过来的

本地版有、这边还没有的东西，按该做的顺序：

| | 干什么 | 为什么值得搬 |
|---|---|---|
| `tools/check_package.py` | 查安装包里有没有不该有的东西 | 云端版更需要——`logs/token.json` 是用户的 API 凭据 |
| `tools/check_release.py` | 发完之后查 GitHub 上的状态对不对 | 「latest 还指着上一版」这类错**不报错**，肉眼看 Release 页面看不出来 |
| `tools/check_docs.py` | 文档里的数字、文件名对不对 | 「README 写 37 条，实际 115 条」 |
| `tools/check_claims.py` | 文档说的行为跟代码一不一致 | 这项目栽过两次「注释写下的原则，实现正好相反」 |

在它们搬过来之前，第五节那份手工清单**一步都不能省**。
