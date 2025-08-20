# Change Log

All notable changes to this extension are documented here.

## [1.2.0]

- ステータスバー表示を強化
  - `現在ページ/総ページ-行（行×列）字（編集中のファイルと同一フォルダ内、同一拡張子の総文字数）` の形式に変更
  - 合算文字数は同一フォルダ内の `.txt` または `.md` を対象とし、ファイル保存時に再計算
  - 設定 `posPage.aggregate.showCombinedChars` で ON/OFF を切り替え可能
- README の機能を更新


## [1.1.0]

- `.md` ファイルを新たに解析対象に追加
- 他拡張「NOVEL-WRITER」による言語モード `Novel` に対応
  - 「NOVEL-WRITER」かこちらのどちらかの品詞ハイライトをOFFにして下さい。
- 品詞ハイライトの有効/無効を `posPage.semantic.enabled` に統合
  - 旧オプション `posPage.enabledPos` とコマンド `posPage.togglePos` を削除
- 既定値を `rowsPerPage=20` / `colsPerRow=20` に統一
- `.md` ファイルの品詞ハイライトを独立して ON/OFF できる設定項目を追加
  - `posPage.semantic.enabledMd`（デフォルト: true）
  - `.txt` / `Novel` 用の `posPage.semantic.enabled` とは別に制御可能
- README の設定例を拡充（全品詞トークンのサンプルを記載）
- README を更新し、新オプションの説明を追加

## [1.0.1]

- デコレーション方式を semantic token に統一
  - 括弧と中身、記号（—、、。）を `bracket` / `symbol` としてハイライト可能に
  - 全角スペースは下線方式の semantic token で表示
- ステータスバー更新処理を改善（入力時のカクつきを軽減）
- 不要な旧デコ関数や設定を削除し、コードを整理

## [1.0.0]

- 初期リリース
  - 品詞カラー表示（kuromoji）
  - ページカウンタ（行×列・禁則処理対応）
  - ステータスバーで選択文字数表示
