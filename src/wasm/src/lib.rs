use wasm_bindgen::prelude::*;
use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera::tokenizer::Tokenizer;

#[wasm_bindgen]
pub struct WasmTokenizer {
    tokenizer: Tokenizer,
}

#[wasm_bindgen]
impl WasmTokenizer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WasmTokenizer, JsValue> {
        let dictionary = load_dictionary("embedded://ipadic")
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let segmenter = Segmenter::new(Mode::Normal, dictionary, None);
        let tokenizer = Tokenizer::new(segmenter);
        Ok(WasmTokenizer { tokenizer })
    }

    pub fn tokenize(&self, text: &str) -> Result<Vec<u32>, JsValue> {
        let mut tokens = self.tokenizer.tokenize(text)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        
        let mut result = Vec::with_capacity(tokens.len() * 4);
        
        // バイトインデックスから UTF-16 インデックスへの変換マップ
        let text_bytes = text.as_bytes();
        let mut byte_to_utf16 = vec![0u32; text_bytes.len() + 1];
        let mut utf16_idx: u32 = 0;
        for (byte_idx, ch) in text.char_indices() {
            byte_to_utf16[byte_idx] = utf16_idx;
            utf16_idx += ch.len_utf16() as u32;
        }
        byte_to_utf16[text_bytes.len()] = utf16_idx;

        for token in tokens.iter_mut() {
            let surface = token.surface.as_ref();
            // token の表層形からバイト位置を算出
            let surface_ptr = surface.as_ptr() as usize;
            let text_ptr = text.as_ptr() as usize;
            
            // surface が text のスライスであることを利用してバイトオフセットを算出
            if surface_ptr < text_ptr || surface_ptr > text_ptr + text_bytes.len() {
                continue; // 安全チェック
            }
            let byte_start = surface_ptr - text_ptr;
            let byte_end = byte_start + surface.len();
            
            if byte_end > text_bytes.len() {
                continue; // 安全チェック
            }
            
            let start = byte_to_utf16[byte_start];
            let length = byte_to_utf16[byte_end] - start;
            
            let details = token.details();
            let pos = details.first().copied().unwrap_or("");
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
