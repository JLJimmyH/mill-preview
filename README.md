# 銑床預演台

Fanuc 立式綜合加工機（VMC）的 G-code 預演與檢錯工具。丟一支 NC 程式進去，看到刀具路徑、材料被切成什麼樣子，以及這支程式裡可能出事的地方。

[![test](https://github.com/JLJimmyH/mill-preview/actions/workflows/test.yml/badge.svg)](https://github.com/JLJimmyH/mill-preview/actions/workflows/test.yml)
[![版本](https://img.shields.io/github/v/tag/JLJimmyH/mill-preview?label=%E7%89%88%E6%9C%AC&color=brightgreen)](https://github.com/JLJimmyH/mill-preview/tags)
[![授權](https://img.shields.io/badge/%E6%8E%88%E6%AC%8A-GPL--3.0-blue)](LICENSE)
[![相依套件](https://img.shields.io/badge/%E7%9B%B8%E4%BE%9D%E5%A5%97%E4%BB%B6-0-success)](#開發)

**▶ 線上使用：https://jljimmyh.github.io/mill-preview/** —— 開啟即用，不必安裝、不必註冊。

![主畫面：左邊編輯器，右邊 2D 俯視與 3D 成品並排](docs/screenshots/main.png)

## 能做什麼

- **看得到成品** —— 材料一格一格切給你看。俯視用色階表示切削深度，切穿的地方畫成棋盤，不會跟「切很深」搞混。
- **37 條檢查規則** —— 語法、模態衝突、刀徑補正、固定循環、剛性攻牙、撞刀風險、切削條件。每一則都說明「這代表什麼、會發生什麼、建議怎麼改」，有機台警報號的會標出來。
- **Block skip 兩種情境對照** —— 自動比較「跳過 `/` 節」前後的差異，抓出「某一節被跳過之後，下一刀變成在材料裡橫著切」這種事。
- **廢料判定** —— 切穿之後跟工件分開的料（整圈切穿的外框、鋸斷的尾料）會標出來，看成品時就不會被那圈其實已經掉下來的料騙到。判錯了在圖上點一下就能改。
- **第四軸（A）** —— 圓棒素材的成品、殘料、碰撞都算得出來，另外附一張把圓柱表面攤平的展開圖，分度角度對不對一眼看得出來。
- **純前端、不連外** —— 沒有 CDN、沒有分析工具、沒有後端。**你的加工程式不會離開這台電腦。**

## 快速開始

1. 開 [線上版](https://jljimmyh.github.io/mill-preview/)，或下載後用瀏覽器直接開 `nc-preview/index.html`（`file://` 也可以）。
2. 選內建範例，或把 NC 檔**拖進視窗**。編碼自動判斷（UTF-8 → Big5），沒有副檔名也可以。
3. 用到 G41／G42 的程式，到「刀具表」填 **D 值**；到「素材」填**真實尺寸**。這兩項直接決定成品圖與檢查結果準不準。
4. 右下「錯誤清單」看結果。點路徑或點錯誤，都會跳到對應的那一行。

<table>
<tr>
<td width="50%"><img src="docs/screenshots/section.png" alt="剖面 X 與 3D 剖切"><br><sub><b>剖面</b>　左邊的剖面圖與右邊 3D 剖切是同一刀，拉滑桿就看得到斷面形狀。</sub></td>
<td width="50%"><img src="docs/screenshots/diagnostics.png" alt="錯誤清單"><br><sub><b>錯誤清單</b>　依嚴重度篩選，同一原因發生在很多行會摺成一列，點行號直接跳過去。</sub></td>
</tr>
</table>

## 限制

**只吃銑床／加工中心的 G-code，車床不支援**（G 代碼體系不同）。臥式加工中心、龍門機沒有特別支援；第四軸只認位址 `A`（繞 X 軸的分度頭），`B`／`C` 只警告、不模擬。

**這是預演，不是機台模擬器。** 刀長補正（H）視為 0、G54–G59 當成同一原點、只支援 G17 平面、不模擬加減速與前瞻、M98／M99 副程式不展開。材料用高度圖表示，所以側凹和鑽穿之後的孔壁表現不出來。

**上機前的 dry run 照做。**

## 文件

| | |
|---|---|
| [使用說明](nc-preview/README.md) | 各面板在做什麼、Block skip、廢料判定、網址參數 |
| [完整細節](nc-preview/docs/USAGE.md) | 操作細節、第四軸、完整的已知限制清單 |
| [模組契約](nc-preview/docs/CONTRACT.md) | 架構與模組介面規範，改核心模組前先讀 |
| [參與專案](CONTRIBUTING.md) | 回報問題、開發、送 PR |
| [DWG 轉 NC](tools/dwg2nc/README.md) | 命令列工具：板件工程圖 → NC 程式＋刀具表＋素材，產出直接拖進預演台 |

## 開發

Node 22 以上。**沒有 `package.json`、沒有 npm 相依、沒有建置流程** —— clone 下來就能跑。

```bash
cd nc-preview
node --test "test/*.test.mjs"        # 全部測試
node tools/check-samples.mjs         # 示範程式不能有 error
```

## 授權

[GPL-3.0](LICENSE)。可以自由使用、修改、散布；把修改過的版本散布出去時，必須同樣以 GPL-3.0 公開原始碼。

Copyright (C) 2026 Jimmy

## 贊助

贊助一杯咖啡讓工程師可以繼續熬夜改 code 🥹：

<a href="https://buymeacoffee.com/chenggg0605"><img src="nc-preview/img/bmc-qr.png" alt="Buy Me a Coffee QR code" width="180"></a>

[buymeacoffee.com/chenggg0605](https://buymeacoffee.com/chenggg0605)

問題回報看工具裡的「關於」（點頂列標題），或是直接從 issue 給我 ~
