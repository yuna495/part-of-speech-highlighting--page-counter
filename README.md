# POS & Note (小説・論文執筆アシスト)

**小説・論文執筆向け**の VSCode 拡張です。（最新版：v2.4.1）

## [**重要変更**](#辞書マージの例ユーザー辞書一括置換辞書v241)

## 目次

- [POS \& Note (小説・論文執筆アシスト)](#pos--note-小説論文執筆アシスト)
  - [**重要変更**](#重要変更)
  - [目次](#目次)
  - [デモ](#デモ)
  - [主な機能](#主な機能)
    - [ハイライト](#ハイライト)
      - [ユーザー辞書登録（v2.1.0）](#ユーザー辞書登録v210)
    - [見出し機能](#見出し機能)
    - [サイドバー機能（v2.3.0）](#サイドバー機能v230)
      - [標準エクスプローラー](#標準エクスプローラー)
        - [ファイル結合機能（v2.2.0）](#ファイル結合機能v220)
      - [POS \& Note専用](#pos--note専用)
        - [ストーリープロットボード（v2.4.0）](#ストーリープロットボードv240)
    - [ステータスバー](#ステータスバー)
    - [縦書きプレビュー（v2.4.1）](#縦書きプレビューv241)
      - [PDF出力機能（v2.4.1）](#pdf出力機能v241)
    - [入力支援](#入力支援)
      - [文字列一括変換機能（v2.3.0）](#文字列一括変換機能v230)
      - [品詞ごとのカーソル移動](#品詞ごとのカーソル移動)
      - [Weblio検索（v2.4.1）](#weblio検索v241)
    - [リント機能](#リント機能)
  - [**辞書マージの例（ユーザー辞書、一括置換辞書）**（v2.4.1）](#辞書マージの例ユーザー辞書一括置換辞書v241)
  - [設定例](#設定例)
    - [設定項目一覧](#設定項目一覧)
  - [推奨ワーク](#推奨ワーク)
  - [チェンジログ](#チェンジログ)
  - [既知の制約](#既知の制約)
  - [ライセンス](#ライセンス)

## デモ

![Demo Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo_main.png)

例：ダークテーマによる実際の使用例

## 主な機能

### ハイライト

- 全角スペースのハイライト設定について
v2.4.0 より、全角スペースのハイライト設定が **fwspace** から **space** に変更されました。
`editor.semanticTokenColorCustomizations` 内で以下のように設定します。

  ```json
  "space"：{
    "highlight"：true,  // true で有効、false で無効
    "color"："#ff000044" // ハイライトの色（RGBAなど）
  }
  ```

- **品詞カラー表示**
  - `kuromoji` による形態素解析で、名詞 / 動詞 / 形容詞 / 副詞 / 助詞 / 助動詞 / 連体詞 / 接続詞 / 感動詞 / 接頭詞 / その他を色分け
- **括弧・記号ハイライト**
  - 全角括弧とその中身を `bracket` として強調（改行またぎ・ネスト対応）
  - **【— 、 。】**などの記号も専用色で表示
- **括弧内ハイライトのトグル（v1.3.5）**
  - `posNote.semantic.bracketsOverride.enabled`
  - ON（既定）:括弧と括弧内を専用色で塗り、括弧内は品詞ハイライトを抑制
  - OFF:括弧内も通常どおり品詞ハイライトを適用
- **全角スペース表示**
  - semantic token による下線表示（テーマと干渉しにくい）

#### ユーザー辞書登録（v2.1.0）

- **目的**
作品ごとの固有名詞や用語を、品詞ハイライトよりも**最優先**で色付けします。
**編集中ドキュメントと同じフォルダ**にある `characters.json` / `glossary.json` のみを読み込み、無い場合は一切適用しません。

- **配置例**

```txt
workspace/
├─ .vscode/
│   └─ conversion.json    ← ワークスペース全体に適用
├─ arc1/
│   ├─ chapter01.txt      ← 編集中
│   └─ notesetting.json   ← これが適用
└─ arc2/
    ├─ chapter01.txt
    └─ notesetting.json   ← arc2 を編集中のときはこちらが適用
```

- notesetting.jsonの書き方

```json
{
  "limit":"XXXX-XX-XX",
  "headings_folding_level":0,
  "characters":[
    "a",
    "b"
  ],
  "glossary":[
    "A",
    "B"
  ],
  "conversion":{
    "alt + .":"ctrl + .",
    "れい":"例",
    "僅か":"わずか"
  }
}
```

- **注意**
  - 過去のcharacter.json/glossary.jsonは廃止。

### 見出し機能

![Statusbar Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo_headline.png)

- **折りたたみ制御（v1.3.0）**
  - 「#」で第一見出し、「##」で第二見出し
  - `Ctrl + [` で展開／折りたたみをトグル
  - 最小レベルを設定可能：`posNote.headings.foldMinLevel`（既定 2）
  - notesetting.json に `"headings_folding_level"` を追加し、ファイル単位で見出し折りたたみレベルを上書きできるようにしました（0 のときは設定の posNote.headings.foldMinLevel を使用）。
- **見出しジャンプ (v2.3.4)**
  - `Ctrl+Alt+W` で現在位置から直前の見出し行へカーソル移動
  - `Ctrl+Alt+I` で現在位置から直後の見出し行へカーソル移動
  - `.txt` / `.md` / `Novel` の # 見出しに対応
- **ミニマップ強調（v1.3.4）**
  - ミニマップ上に見出しレベルごとの色付きバーを表示
- **コードフェンスコメント（v2.2.1）**
  - ```改行```で囲まれた範囲を「コメント」として扱い、**手動で折りたたみ可能**。
  - 既定では文字色が `#f0f0c0` に設定され、他の品詞ハイライトから除外されます。
  - 文字数カウント／ページ行計算からは除外されます。
- **各見出しの末尾に『- 〇字 / □字』を表示（v2.2.5）**
  - 保存時に更新（表示位置計算のため、少し時間がかかります）
  - 〇字 … 自身の本文（次の見出し直前まで）の文字数。
  - □字 … 自身および配下（子・孫など）の見出し群の本文文字数を合算。
  - 〇・□がそれぞれ 0 の場合は非表示。
  - 〇＝□ の場合（下位見出しなし）は「/ □字」を省略。
  - `.txt` / `.md` / `Novel` に対応。
  - 設定 `posNote.headings.showBodyCounts` で ON/OFF 可能（既定値：ON）。
  - 表示例：

    ```txt
    # 見出しレベル一    - 2字 / 4字
    文字
    ## 見出しレベル二   - 2字
    文字
    ### 見出しレベル三
    ```

### サイドバー機能（v2.3.0）

#### 標準エクスプローラー

- 標準エクスプローラーでのフォルダ右クリックメニューに、**「新しい小説を作成」**項目を追加
  クリックすると、雛形フォルダ **NewNovel** を作成。
  `plot/` サブフォルダ、`notesetting.js` などを自動生成ます。
- 「POS/Note:フォルダ内の .txt を結合」
- 「POS/Note:フォルダ内の .md を結合」

##### ファイル結合機能（v2.2.0）

- **用途**
小説や章ごとに分割したテキストを、ワンクリックでまとめたいときに便利です。

- **使い方**
  1. VS Code のエクスプローラーで任意のフォルダを右クリック
  2. 以下のメニューから選択
     - 「POS/Note:フォルダ内の .txt を結合」
     - 「POS/Note:フォルダ内の .md を結合」
  3. フォルダ直下にある対象拡張子ファイルをファイル名順に結合し、同フォルダ直下へ出力

![Combine Screen shot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo_combine.png)
例：フォルダ右クリック時

- **仕様**
  - 出力ファイル名は `combined.txt` / `combined.md`
  - 既存ファイルがあれば `combined(1).txt`, `combined(2).txt` のように採番
  - ファイル間には空行 1 行を挿入、改行コードは `\n` に統一
  - 結合完了後、自動的に生成ファイルを開く

#### POS & Note専用

![Sidebar Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo_sidebar.png)

- **概要**
  サイドバーに「POS/Note」専用のツリービューを追加。
  ワークスペース内で作業中のフォルダを一覧・操作できます。

- **主な機能**
  - **見出しビュー（v1.3.3）**
    - サイドバーに見出しを一覧表示、クリックでジャンプ

  - **簡易エクスプローラ**
    現在開いているファイルと同じフォルダ内容を一覧。
    - 優先度は、フォルダ→.txt → .md → .json → その他。
    ファイルをクリックで開くほか、右クリックメニュー内の 「新規ファイル」「新規フォルダ」「コピー／切り取り／貼り付け／削除」 等の操作も可能
  - **「現在のフォルダに雛形を作成」ボタン**
    クリックすると、編集中ファイルの親フォルダに`plot/` サブフォルダ、`notesettin.js`を自動生成。
    - 同名ファイルが存在する場合はスキップ。
  - **結合ボタン（.txt / .md）**
    ビュー上部の「親フォルダの .txt を結合」「親フォルダの .md を結合」ボタンをクリックすると、アクティブファイルのあるフォルダ直下のファイルを結合します。
  - **新規ファイル作成ボタン**、**外部エクスプローラーで表示ボタン**

  - **プロットボードを表示ボタン** (#plotboard)
  - **フォルダ右クリックメニュー**
    サイドバー上の任意のフォルダを右クリックすると以下が表示されます。
    - 「このフォルダの .txt を結合」
    - 「このフォルダの .md を結合」
    選択フォルダ内の `.txt` / `.md` をファイル名順に結合し、同フォルダ直下に出力します。
  - **外部エクスプローラーで開く**
    任意のファイル／フォルダを右クリック → 「OSエクスプローラー で開く」。

- **結合仕様**
  - 出力ファイル名は `combined.txt` / `combined.md`
  - 同名ファイルがあれば `(1)` `(2)` と自動採番
  - ファイル間には空行 1 行を挿入
  - 改行コードは `\n` に統一
  - 結合後、自動的に生成ファイルを開く

- **コマンド一覧**

  | コマンド ID              | 内容                                                       |
  | ------------------------ | ---------------------------------------------------------- |
  | `posNote.combineTxtHere` | サイドバー上部のボタンで、アクティブフォルダの .txt を結合 |
  | `posNote.combineMdHere`  | 同上（.md）                                                |
  | `posNote.combineTxtAt`   | サイドバーで右クリックしたフォルダの .txt を結合           |
  | `posNote.combineMdAt`    | 同上（.md）                                                |

---

- **補足:**
  - このサイドバーは VS Code 左側の「POS/Note」アイコンから開けます。
  - 通常のエクスプローラに加え、作品単位での管理・結合作業を簡略化する目的で追加。

##### ストーリープロットボード（v2.4.0）

![story_plot_board](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo_plot_board.png)

- 起動：サイドバー下部の「プロットボードを表示」ボタン（内部コマンド `posNote.kanbn.openBoard`）で開きます。表示ルートは、サイドバーの固定フォルダ → アクティブファイルの親 → `plot` フォルダの1つ上 → ワークスペースの順で自動判定。初回起動時は `plot/board.md` と `plot/card/` を生成し、`TBD / Act1 / Act2 / Act3 / Act4` を用意します。
- 保存形式：構成は `plot/board.md` の `## 列名` と `- カードID` で管理し、各カード本文は `plot/card/<カードID>.json`（title/description/characters/time/tags）に保存。テキストエディタで直接編集してもボードに反映されます。
- 列の操作：上部「列を追加」で新規列。ヘッダーをドラッグで並び替え、ダブルクリックで名前変更。TBD 列は固定（移動・削除不可）。列をゴミ箱へドロップすると列と所属カードをまとめて削除（確認ダイアログあり）。
- カードの操作：列ヘッダー右上の「＋」でカード作成（タイトル必須、説明・タグ任意）。カードはドラッグ＆ドロップで列間移動・並べ替え、ダブルクリックで JSON を開いて詳細編集、右クリックで削除／開くのクイックメニュー。ゴミ箱へドロップするとファイルごと削除されます。
- タグ：画面上部のタグパレットからカードへドラッグして付与。カード上のタグを盤面外へドラッグすると削除。タグ色・並びは `posNote.kanbn.tagsColors` に従い、未設定時はデフォルト（出会い／イベント／トラブル／解決）。`"none"` を指定したタグはストライプ非表示。
- 色設定：列の背景色は `posNote.kanbn.columnColors` で左から順に適用（未設定は暗色系デフォルト）。タグのチップ・ストライプ色は `posNote.kanbn.tagsColors` で指定可能。

  ```json
  "posNote.kanbn.columnColors"：[
    "#0c2f24",
    "#3a3109",
    "#300c10",
    "#0c1f38"
  ],
  "posNote.kanbn.tagsColors"：{
    "出会い"："#8dc63f",
    "イベント"："#f5a623",
    "トラブル"："#c45dd8",
    "解決"："#2fa8c9"
  }
  ```

- 更新と書き出し：`plot/board.md` と `plot/card/**` を監視して自動反映。「再読み込み」ボタンで手動更新。ツールバーの「plot.md に出力」で `plot/plot.md` に現在の構成をマーカー付きで上書き（その他の記述は保持）。初期テンプレートは `sidebar_util.defaultPlotMd()` を使用。

### ステータスバー

![Statusbar Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo_statusbar.png)
表示例：現在ページ/総ページ —終ページの行 （ページの行/列） 編集中ファイルの総文字数/フォルダ内同一ファイル総文字数 ±Git差分文字数

- **期限表示（v2.3.2）**
  - notesetting.jsonに記載された日付までの残り日数表示。
    - 値を"null"にすると期限表示は非表示。
    - limit のフォーマットは YYYY-M-D（例："2026-1-1"、"2026/1/1"）で記述します。
    - notesetting.json記入例

    ```json
    {
      "limit":"XXXX-XX-XX",
      "headings_folding_level":0,
      "characters":[
        "a",
        "b"
      ],
      "glossary":[
        "A",
        "B"
      ],
      "conversion":{
        "alt + .":"ctrl + .",
        "れい":"例",
        "僅か":"わずか"
      }
    }
    ```

- **ページカウンタ**
  - 原稿用紙風（行×列）で折り返し、行頭禁則処理に対応
- **文字数表示**
  - 選択範囲があればその文字数、なければ全体文字数
  - 見出し行（# / ##）はカウントから除外
  - スペースを含めるかどうか設定可能
- **差分表示**
  - HEAD（直近コミット）との差分を ± で表示
- **合算文字数（v2.2.2）**
  - 編集中文書を含む、同じフォルダ・同じ拡張子ファイルの総文字数を表示
  - 設定 `posNote.aggregate.showFolderSum` で ON/OFF 可能
- 表示例：

```txt
`12 / 35 -10（20×20） 2,345字 / 12,345 +120字`
= **現在ページ/総ページ -最終ページ行数（ページの 行×列） 選択または全体文字数/合算文字数 HEADとの差分**
```

- **純作業量表示（v2.3.0）**
![Statusbar Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo_workgraph.png)
表示例：【左：円環グラフ、右：棒グラフ】
  - 実際に入力・削除された文字数を合計して「純作業量」として表示。
  - ステータスバー上では当日の合計作業量をリアルタイム更新。
  - マウスオーバーで過去1週間の合計をポップアップ表示。
  - ステータスバー項目をクリックすると「純作業量グラフ」を開く。

- **グラフビュー機能**
  - 日別の合計作業量＋入力/削除折れ線を同時表示。
  - マーカー（●:入力 / ■:削除）で各日の実績を明示。
  - 最大作業日および目標ラインを描画。

- 入力ディレイ設定
setting.jsonにて、変更可能。数値はデフォルト値。

```json
{
  "posNote.workload.dailyTarget":5000, // 一日の作業量目標
  "posNote.workload.imeGuardMsNormal":50,      // 通常入力ディレイ
  "posNote.workload.imeGuardMsCandidate":800,   // 変換遅延（2文字以上増減する場合）
  "posNote.workload.graphStyle":"radial" // グラフスタイル（"bar"|"radial"）
}
```

- コマンドにて、作業量履歴消去可能
  - "posNote.workload.deleteOldest" :作業量ログの最も古い日付を削除。
  - "posNote.workload.clearAll" :作業量ログの全てを削除。

### 縦書きプレビュー（v2.4.1）

- エディタ右上の 📖 アイコンで縦書きページプレビューを開きます。
- ステータスバーに表示されているユーザー指定のページ設定（デフォルト：20行 × 20字）での表示と、文庫本風（デフォルト：18行 × 40字）の表示を切り替えられます。
- エディタのカーソル位置とプレビューの表示位置が同期します。
- プレビュー内の文字をクリックすると、エディタの該当箇所へジャンプします。
- 編集内容は入力中にリアルタイムで反映されます。
- フォント設定（デフォルト）

```json
"posNote.Preview.fontFamily": "\"HiraMinProN-W3\", \"Hiragino Mincho ProN\", \"Yu Mincho\", \"YuMincho\", \"MS Mincho\", \"TakaoMincho\", serif"
```

#### PDF出力機能（v2.4.1）

- プレビュー下部右側に**文庫サイズでPDF出力**ボタン
- クリックすることで、"posNote.Page.defaultRows" × "posNote.Page.defaultCols"（デフォルト：18行 × 40字）で、カレントディレクトリにPDFファイルで出力
- フォント設定（デフォルト）

```json
"posNote.Preview.PDFoutputfontFamily": "\"HiraMinProN-W3\", \"Hiragino Mincho ProN\", \"Yu Mincho\", \"YuMincho\", \"MS Mincho\", \"TakaoMincho\", serif"
```

### 入力支援

- **全角括弧の入力補完**
  - `『（［｛〈《【〔`などの開きを入力すると自動で閉じを補完
  - ネスト対応：`「『』」` のように正しく保持
  - IME 変換追従／Backspace 連動にも対応
- **小説家になろう方式によるルビ／傍点挿入（v2.2.2）**
  - カクヨムでも同じ書式で適用されます。
  - `Ctrl + Alt + R`:文書中の全ての選択文字列にルビ → `|選択《》`
  - `Alt + R`:選択文字列のみにルビ → `|選択《》`
  - `Ctrl + Alt + B`:選択文字に傍点 → `|字《・》|字《・》…`
  - 選択がない場合もカーソル位置に雛形を挿入
  - `Ctrl + '`:選択文字に引用符 → `“選択”`

#### 文字列一括変換機能（v2.3.0）

- **概要**
  執筆中のテキスト内で、「かな」表記と「漢字」表記をワンタッチで切り替えられます。
  - 範囲選択中は、その範囲内のみを置換対象とします。（v2.4.1）

- **ショートカット**
  - `Ctrl + .` :「かすか／わずか」→「微か／僅か」など、かな → 漢字
  - `Alt + .` :「微か／僅か」→「かすか／わずか」など、漢字 → かな

- **ユーザー辞書（notesetting.json）対応**
- **読み込み場所**
  - ワークスペースの `.vscode/conversion.json`
  - **編集中ファイルと同じフォルダ**の `notesetting.json`
  - **マージ規則**
  - 両方ある場合は**後勝ちマージ**で統合し、**同階層の `notesetting.json` を優先**
  - 監視は`**/notesetting.json`に保存・作成・削除を自動検知し即時反映
  - **書式**はシンプルな片方向マッピングでOK 逆方向は自動生成

  ```json
  {
    "limit":"YYYY-MM-DD",
    "headings_folding_level":0,
    "characters":[
      "a",
      "b"
    ],
    "glossary":[
      "A",
      "B"
    ],
    "conversion":{
      "alt + .":"ctrl + .",
      "れい":"例",
      "ひらがな":"漢字"
    }
  }
  ```

#### 品詞ごとのカーソル移動

- `ctrl + ← / →`：日本語の文節区切りに合わせてカーソル移動。（「私は」「猫が」などをひとまとまりとして扱います）

#### Weblio検索（v2.4.1）

- 選択中の文字列を、外部ブラウザによって**Weblio類語辞典**検索。（ショートカットキー：`ctrl + t`）

### リント機能

- **注意**：リント作業中はステータスバー左下に作業中マークが回転します。その間はファイルの移動などを避けるようにしてください。

- 保存時にテキストリント（文章校正）を実施します。
  - **適用されるルールとチェック項目**
    - **カスタム診断**:
      - 句読点の連続
      - 感嘆符・疑問符（！？）直後のスペース有無
    - **TextLint ルール**:
      - **textlint-rule-preset-jtf-style**（JTF日本語標準スタイル試案）：一部の整形ルール（算用数字の使い分け等）を適用
      - **no-doubled-conjunction**：同じ接続詞の連続使用
      - **no-doubled-joshi**：一文中の同じ助詞の連続使用（「の」の連続など）
      - **ja-no-abusage**：誤用されやすい日本語の指摘
      - **ja-no-redundant-expression**：冗長な表現の指摘
      - **max-ten**：一文中の読点（、）の多用（4つ以上で警告）
      - **no-mixed-zenkaku-and-hankaku-alphabet**：全角・半角アルファベットの混在
      - **ja-unnatural-alphabet**：不自然なアルファベットの指摘

  - 機能をONにする場合、設定で以下を有効にしてください（要再起動）。

    ```json
    "posNote.linter.enabled":true
    ```

## **辞書マージの例（ユーザー辞書、一括置換辞書）**（v2.4.1）

- これまでの一括置換辞書に加え、ユーザー辞書もマージできるようにしました。
それにともない、`.vscode/notesetting.json`が有効になります。
  - 記入法

    ```json
    {
      "characters":[
        "a", "b"
      ],
      "glossary":[
        "A", "B"
      ],
      "conversion":{
        "アルファ": "ベータ",
        "x": "Y"
      }
    }
    ```

- `.vscode/conversion.json`は近いうちに非対応とする予定ですので、修正お願いします。

- 実際のマージ例
  - `.vscode/conversion.json`

    ```json
    { "alt + .": "ctrl + ." }
    ```

  - `.vscode/notesetting.json`

    ```json
    {
      "characters":[
        "a", "b"
      ],
      "glossary":[
        "A", "B"
      ],
      "conversion":{
        "アルファ": "ベータ",
        "x": "Y"
      }
    }
    ```

  - `.各フォルダ/notesetting.json`

    ```json
    {
      "limit":"XXXX-XX-XX",
      "headings_folding_level":0,
      "characters":[
        "c", "d"
      ],
      "glossary":[
        "C", "D"
      ],
      "conversion":{
        "Y": "x"
      }
    }
    ```

  - 実際に各フォルダ内の .txt と .md に適用される`notesetting.json`

    ```json
    {
      "limit":"XXXX-XX-XX",
      "headings_folding_level":0,
      "characters":[
        "a","b",
        "c","d"
      ],
      "glossary":[
        "A","B",
        "C","D"
      ],
      "conversion":{
        "alt + .": "ctrl + .",
        "アルファ": "ベータ",
        "Y": "x"
      }
    }
    ```

## 設定例

- 主な設定項：：

| 設定キー                                    | 説明                                                       | 既定値       |
| ------------------------------------------- | ---------------------------------------------------------- | ------------ |
| **ハイライト**                              |                                                            |              |
| `posNote.semantic.enabled`                  | `.txt` / `Novel` の品詞ハイライト有効化                    | `true`       |
| `posNote.semantic.enabledMd`                | `.md` の品詞ハイライト有効化                               | `true`       |
| `posNote.semantic.bracketsOverride.enabled` | 括弧内を専用色にする（ON:専用色＋品詞抑制 / OFF:品詞適用） | `true`       |
| **見出し**                                  |                                                            |              |
| `posNote.headings.semantic.enabled`         | `.txt` / `Novel` で `#` 見出し行をハイライト               | `true`       |
| `posNote.headings.folding.enabled`          | 見出しの折りたたみ機能を有効化                             | `true`       |
| `posNote.headings.showBodyCounts`           | 各見出しの末尾に直下の文字数を表示                         | `true`       |
| `posNote.headings.foldMinLevel`             | 全折りたたみコマンドで対象とする最小レベル（2=##以上）     | `2`          |
| **作業量計測**                              |                                                            |              |
| `posNote.workload.enabled`                  | 純作業量（入力/削除/貼付）の計測・表示                     | `true`       |
| `posNote.workload.dailyTarget`              | 1日の目標作業文字数（グラフの赤線）                        | `2000`       |
| `posNote.workload.graphStyle`               | グラフの表示スタイル（"bar" または "radial"）              | `"radial"`   |
| `posNote.workload.timeZone`                 | 集計基準とするタイムゾーン（"system" または IANA ID）      | `"system"`   |
| **ステータスバー・入力制御**                |                                                            |              |
| `posNote.enabledNote`                       | ページカウンタ（行×列）表示の有効化                        | `true`       |
| `posNote.Note.rowsPerNote`                  | 1ページの行数                                              | `20`         |
| `posNote.Note.colsPerRow`                   | 1行の文字数                                                | `20`         |
| `posNote.status.showSelectedChars`          | 文字数（選択時/全体）を表示                                | `true`       |
| `posNote.status.countSpaces`                | 文字数カウントに空白を含める                               | `false`      |
| `posNote.aggregate.showDeltaFromHEAD`       | Git HEAD（直近コミット）との差分を表示                     | `true`       |
| `posNote.aggregate.showFolderSum`           | 同フォルダ内の同種ファイル合算文字数を表示                 | `true`       |
| `posNote.kinsoku.enabled`                   | ページ計算時の行頭禁則処理を有効化                         | `true`       |
| `posNote.kinsoku.bannedStart`               | 行頭禁則対象の文字リスト（手動設定用）                     | デフォルト   |
| `posNote.linter.enabled`                    | textlint による文章校正を有効化（要再起動）                | `false`      |
| **プレビュー**                              |                                                            |              |
| `posNote.Preview.backgroundColor`           | プレビュー背景色                                           | `#111111`    |
| `posNote.Preview.textColor`                 | プレビュー文字色                                           | `#4dd0e1`    |
| **プロットボード**                          |                                                            |              |
| `posNote.kanbn.columnColors`                | 列の背景色リスト                                           | 配列         |
| `posNote.kanbn.tagsColors`                  | タグの色定義マップ                                         | オブジェクト |

### 設定項目一覧

```json
{
  // エディタとプレビューどちらも共通色
  "editor.semanticTokenColorCustomizations":{
    "rules":{
      "verb":{ "italic":false, "foreground":"#11ff84" }, // 動詞
      "adjective":"#ffe955",   // 形容詞
      "adverb":"#f94446",      // 副詞
      "particle":"#f7f7f7",    // 助詞
      "prenoun":"#e0a000",     // 連体詞
      "conjunction":"#ff14e0", // 接続詞
      "symbol":"#fd9bcc",      // 記号
      "bracket":"#fd9bcc",     // 括弧
      "character":"#ff0000",   // ユーザー辞書(characters)
      "glossary":"#ffff00",    // ユーザー辞書(glossary)
      "fencecomment":"#f0f0c0",// コメントフェンス
      "heading":"#ff14e0",     // 見出し
      "space":{                // 全角スペース
        "highlight":true,
        "color":"#ff000044"
      }
    }
  },

  // プロットボード設定
  "posNote.kanbn.columnColors":[
    "#0c2f24",
    "#101006",
    "#300c10",
    "#0b0e27"
  ],
  "posNote.kanbn.tagsColors":{
    "出会い":"#8dc63f",
    "イベント":"#f5a623",
    "トラブル":"#c45dd8",
    "解決":"#2fa8c9"
  },

  // 基本設定
  "posNote.semantic.enabled":true,
  "posNote.semantic.enabledMd":true,
  "posNote.semantic.bracketsOverride.enabled":true,
  "posNote.headings.foldMinLevel":2,

  // 禁則処理（デフォルト値）
  "posNote.kinsoku.bannedStart":[
    "、", "。", "，", "．", "？", "！", "」", "』", "】", "〉", "》", "’", "”", "…", "‥",
    "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゃ", "ゅ", "ょ", "っ", "ー",
    "ァ", "ィ", "ゥ", "ェ", "ォ", "ャ", "ュ", "ョ", "ッ"
  ],

  // 作業量計測
  "posNote.workload.dailyTarget":2000,
  "posNote.workload.imeGuardMsNormal":50,
  "posNote.workload.imeGuardMsCandidate":800,
  "posNote.workload.graphStyle":"radial"
}
```

## 推奨ワーク

- `.txt` `.md` での小説や論文執筆
- 適度な長さで文書の分割を検討してください

## チェンジログ

[changelog](https://github.com/yuna495/part-of-speech-highlighting--page-counter/blob/master/CHANGELOG.md)

## 既知の制約

- 大規模ファイルでは解析負荷が高くなる可能性あり
- 禁則処理は一部の組み合わせに限定

## ライセンス

[MIT](https://github.com/yuna495/part-of-speech-highlighting--page-counter/blob/master/LICENSE.txt)
