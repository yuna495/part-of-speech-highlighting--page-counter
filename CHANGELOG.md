# Change Log

All notable changes to this extension are documented here.

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
