# POS & Note (小説・論文執筆アシスト)

**小説・論文執筆向け**の VSCode 拡張です。（最新版: v2.2.2）

- [品詞ごとの色分け（semantic token）](#highlight)
  - 括弧・記号・全角スペースの強調表示
  - 括弧内ハイライトの ON/OFF 切り替え
  - [辞書登録による別途ハイライト](#dictionary)

- [ページカウンタ（原稿用紙風、行頭禁則あり）](#statusbar)
  - ステータスバーで文字数・コミット差分を表示

- [縦書きプレビュー機能](#preview)

- [フォルダ内、同一ファイル形式結合](#combine)

- [見出しビュー／ミニマップ強調／折りたたみ制御／コードフェンスによるコメント(.txt)](#headline)

- [全角括弧の入力支援（自動補完・Backspace連動）](#bracket)
  - 開き括弧変換確定時、閉じ括弧補完
  - 小説家になろう方式によるルビ・傍点入力支援（カクヨムにおいても適用されます）

- [setting.json設定例](#setting)

- `.txt` / `.md` / `Novel` に対応

## デモ

![Demo Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo.png)

例：ダークテーマによる実際の使用例

---

## 主な機能

### ハイライト {#highlight}

- **品詞カラー表示**  
  - `kuromoji` による形態素解析で、名詞 / 動詞 / 形容詞 / 副詞 / 助詞 / 助動詞 / 連体詞 / 接続詞 / 感動詞 / 接頭詞 / その他を色分け
- **括弧・記号ハイライト**  
  - 全角括弧とその中身を `bracket` として強調（改行またぎ・ネスト対応）
  - 「—」「、」「。」などの記号も専用色で表示
- **括弧内ハイライトのトグル（v1.3.5）**  
  - `posNote.semantic.bracketsOverride.enabled`  
  - ON（既定）: 括弧と括弧内を専用色で塗り、括弧内は品詞ハイライトを抑制  
  - OFF: 括弧内も通常どおり品詞ハイライトを適用
- **全角スペース表示**  
  - semantic token による下線表示（テーマと干渉しにくい）

### ユーザー辞書登録（v2.1.0） {#dictionary}

- **目的**  
作品ごとの固有名詞や用語を、品詞ハイライトよりも**最優先**で色付けします。  
**編集中ドキュメントと同じフォルダ**にある `characters.json` / `glossary.json` のみを読み込み、無い場合は一切適用しません。

- **配置例**

```txt
workspace/
├─ arc1/
│   ├─ chapter01.txt     ← 編集中
│   ├─ characters.json   ← これが適用
│   └─ glossary.json     ← これが適用
└─ arc2/
    ├─ chapter01.txt
    └─ characters.json   ← arc2 を編集中のときはこちらが適用
```

- characters.json / glossary.jsonの書き方

```json

// 文字列配列
[
  "奏音",
  "未澪"
]
// オブジェクト配列（人物）
[
  {
    "name": "奏音",
    "alias": ["かなで"],
    "note": "主人公"
  }
]
// オブジェクト配列（用語）
[
  {
    "term": "祠",
    "variants": ["社"]
  }
]

// 連想形式
{
  "奏音": { "alias": ["かなで"] },
  "未澪": "孤児院の子"
}

```

### ステータスバー {#statusbar}

![Statusbar Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo2.png)
表示例：現在ページ/総ページ -最終ページの行 （ページの行/列） 編集中ファイルの総文字数/フォルダ内同一ファイル総文字数 ±Git差分文字数

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
- 表示例;

```txt
`12 / 35 -10（20×20） 2,345字 / 12,345 +120字`  
= **現在ページ/総ページ -最終ページ行数（行×列） 選択または全体文字数/合算文字数 HEADとの差分**
```

### プレビュー（v2.0.0） {#preview}

- エディタ右上の 📖 アイコンで縦書きプレビューを開く
- エディタで選択した行がプレビュー側でハイライトされ、プレビューで行をクリックするとエディタが同期する
- プレビュー内にも品詞ハイライトを適用可能
- 反映タイミングはエディタ保存時
- 品詞ハイライトは「選択行 ±maxLines 行」（既定: 2000 行）を対象に動的に解析する

### ファイル結合機能（v2.2.0） {#combine}

- **用途**  
小説や章ごとに分割したテキストを、ワンクリックでまとめたいときに便利です。

- **使い方**  
  1. VS Code のエクスプローラーで任意のフォルダを右クリック  
  2. 以下のメニューから選択  
     - 「POS/Note: フォルダ内の .txt を結合」  
     - 「POS/Note: フォルダ内の .md を結合」  
  3. フォルダ直下にある対象拡張子ファイルをファイル名順に結合し、同フォルダ直下へ出力  

![Combine Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo1.png)
例：フォルダ右クリック時

- **仕様**  
  - 出力ファイル名は `combined.txt` / `combined.md`  
  - 既存ファイルがあれば `combined(1).txt`, `combined(2).txt` のように採番  
  - ファイル間には空行 1 行を挿入、改行コードは `\n` に統一  
  - 結合完了後、自動的に生成ファイルを開く

### 見出し機能 {#headline}

![Statusbar Screenshot](https://raw.githubusercontent.com/yuna495/part-of-speech-highlighting--page-counter/master/demo/demo3.png)

- **折りたたみ制御（v1.3.0）**  
  - 「#」で第一見出し、「##」で第二見出し  
  - `Ctrl + [` で展開／折りたたみをトグル  
  - 最小レベルを設定可能：`posNote.headings.foldMinLevel`（既定 2）
- **見出しビュー（v1.3.3）**  
  - サイドバーに見出しを一覧表示、クリックでジャンプ
- **ミニマップ強調（v1.3.4）**  
  - ミニマップ上に見出しレベルごとの色付きバーを表示
- **コードフェンスコメント（v2.2.1）**
  - ```改行```で囲まれた範囲を「コメント」として扱い、**手動で折りたたみ可能**。
  - 既定では文字色が `#f0f0c0` に設定され、他の品詞ハイライトから除外されます。
  - 文字数カウント／ページ行計算からは除外されます。  
- **各見出しの末尾に『- 〇字 / □字』を表示（v2.2.5）**
  - 〇字 … 自身の本文（次の見出し直前まで）の文字数。
  - □字 … 自身および配下（子・孫など）の見出し群の本文文字数を合算。
  - 〇・□がそれぞれ 0 の場合は非表示。
  - 〇＝□ の場合（下位見出しなし）は「/ □字」を省略。
  - `.txt` / `.md` / `Novel` に対応。
  - 設定 `posNote.headings.showBodyCounts` で ON/OFF 可能（既定値: ON）。
  - 表示例：

    ```txt
    # 見出しレベル一    - 2字 / 4字
    文字
    ## 見出しレベル二   - 2字
    文字
    ### 見出しレベル三
    ```

### 入力支援 {#bracket}

- **全角括弧の入力補完**  
  - 「『（［｛〈《【〔」などの開きを入力すると自動で閉じを補完
  - ネスト対応：`「『』」` のように正しく保持
  - IME 変換追従／Backspace 連動にも対応
- **小説家になろう方式によるルビ／傍点挿入（v2.2.2）**
  - カクヨムでも同じ書式で適用されます。
  - `Ctrl + Alt + R`: 選択文字にルビ → `|選択《》`（キャレットは《》内）
  - `Ctrl + Alt + B`: 選択文字に傍点 → `|字《・》|字《・》…`
  - 選択がない場合もカーソル位置に雛形を挿入

---

## 設定 {#setting}

- 主な設定項目：

| 設定キー | 説明 | 既定値 |
|----------|------|--------|
| `posNote.semantic.enabled` | `.txt` / `Novel` の品詞ハイライト有効化 | `true` |
| `posNote.semantic.enabledMd` | `.md` の品詞ハイライト有効化 | `true` |
| `posNote.semantic.bracketsOverride.enabled` | 括弧内を専用色にするか（ON: 専用色＋品詞抑制 / OFF: 品詞適用） | `true` |
| `posNote.kinsoku.bannedStart` | 行頭禁則文字リスト | デフォルトあり |
| `posNote.headings.foldMinLevel` | 折りたたみの最小レベル（2=##以上） | `2` |

- 設定例

```jsonc
{
  // エディタとプレビューどちらも共通色
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      // 品詞ごとの例（任意で色コードを変更可能）
      "noun": "#4dd0e1",        // 名詞
      "verb": "#11ff84",        // 動詞
      "adjective": "#ffd900",   // 形容詞
      "adverb": "#f94446",      // 副詞
      "particle": "#f6f7f8",    // 助詞
      "auxiliary": "#a1887f",   // 助動詞
      "prenoun": "#e0a000",     // 連体詞
      "conjunction": "#ff14e0", // 接続詞
      "interjection": "#ff7043",// 感動詞
      "symbol": "#fd9bcc",      // 記号
      "other": "#9e9e9e",       // その他

      // ユーザー辞書（最優先）
      "charcter": #ff14e0,      // characters.json指定項目
      "glossary": #ff0000,      // glossary.json指定項目

      // 特殊トークン
      "bracket": "#fd9bcc",     // 括弧と括弧内文書
      "fwspace": {                // 全角スペース
        "underline": true,
        "foreground": "#ff0000"
      },
      "heading": "#ff14e0" ,     // 見出しカラー
      "fencecomment": "#f0f0c0", // ```コードフェンスカラー
    }
  },
  "posNote.semantic.enabled": true,
  "posNote.semantic.enabledMd": true,
  "posNote.semantic.bracketsOverride.enabled": true,
  "posNote.headings.foldMinLevel": 2,
  "posNote.kinsoku.bannedStart": [
    "」","）","『","』","》","】","。","、",
    "’","”","！","？","…","—","―"
  ]
}
```

## 推奨ワークフロー

- `.txt` `.md` での小説や論文執筆。

## 既知の制約

- 大規模ファイルでは解析負荷が高くなる可能性あり
- 禁則処理は一部の組み合わせに限定

## ライセンス

MIT
