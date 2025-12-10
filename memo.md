# ハイライト辞書、置換辞書マージ

- `.vscode/notesetting.json`

  ```json
  {
    "characters":[
      "a",
      "b"
    ],
    "glossary":[
      "A",
      "B"
    ],
    "conversion":{
      "alt + .": "ctrl + .",
      "れい": "例",
      "僅か": "わずか"
    }
  }
  ```

- `.vscode/conversion.json`

```json
{ "きぞん": "きぞん" }
```

- `.各フォルダ/notesetting.json`

  ```json
  {
    "limit":"XXXX-XX-XX",
    "headings_folding_level":0,
    "characters":[
      "c",
      "d"
    ],
    "glossary":[
      "C",
      "D"
    ],
    "conversion":{
      "もじ": "文字",
      "てすと": "テスト"
    }
  }
  ```

- 実際に各フォルダ内の .txt と .md に適用される`notesetting.json`

  ```json
  {
    "limit":"XXXX-XX-XX",
    "headings_folding_level":0,
    "characters":[
      "a",
      "b",
      "c",
      "d",
    ],
    "glossary":[
      "A",
      "B",
      "C",
      "D",
    ],
    "conversion":{
      "alt + .": "ctrl + .",
      "れい": "例",
      "僅か": "わずか",
      "きぞん": "既存",
      "もじ": "文字",
      "てすと": "テスト"
    }
  }
  ```
