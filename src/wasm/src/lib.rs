use wasm_bindgen::prelude::*;
use lindera::tokenizer::Tokenizer;
use lindera::mode::Mode;

#[wasm_bindgen]
pub struct WasmTokenizer {
    tokenizer: Tokenizer,
}

#[wasm_bindgen]
impl WasmTokenizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WasmTokenizer, JsValue> {
        let tokenizer = Tokenizer::new(Mode::Normal, "")
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WasmTokenizer { tokenizer })
    }

    pub fn tokenize(&self, text: &str) -> Result<Vec<u32>, JsValue> {
        let tokens = self.tokenizer.tokenize(text)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        
        let mut result = Vec::with_capacity(tokens.len() * 4);
        
        // バイトインデックスから UTF-16 インデックスへの変換マップ
        let mut byte_to_utf16 = vec![0; text.len() + 1];
        let mut utf16_idx = 0;
        for (byte_idx, ch) in text.char_indices() {
            byte_to_utf16[byte_idx] = utf16_idx;
            utf16_idx += ch.len_utf16() as u32;
        }
        byte_to_utf16[text.len()] = utf16_idx;

        for token in tokens {
            let byte_start = token.byte_start;
            let byte_end = token.byte_end;
            
            let start = byte_to_utf16[byte_start];
            let length = byte_to_utf16[byte_end] - start;
            
            let details = token.details.unwrap_or_default();
            let pos = details.get(0).copied().unwrap_or("");
            let pos1 = details.get(1).copied().unwrap_or("");
            
            let mut type_idx: u32 = 10; // "other"
            
            if pos == "名詞" { type_idx = 0; }
            else if pos == "動詞" { type_idx = 1; }
            else if pos == "形容詞" { type_idx = 2; }
            else if pos == "副詞" { type_idx = 3; }
            else if pos == "助詞" { type_idx = 4; }
            else if pos == "助動詞" { type_idx = 5; }
            else if pos == "連体詞" { type_idx = 6; }
            else if pos == "接続詞" { type_idx = 7; }
            else if pos == "感動詞" { type_idx = 8; }
            else if pos == "記号" { type_idx = 9; }
            
            let mut mods: u32 = 0;
            if pos1 == "固有名詞" { mods |= 1; }
            if pos1 == "接頭" { mods |= 2; }
            if pos1 == "接尾" { mods |= 4; }
            
            result.push(start);
            result.push(length);
            result.push(type_idx);
            result.push(mods);
        }
        
        Ok(result)
    }
}
