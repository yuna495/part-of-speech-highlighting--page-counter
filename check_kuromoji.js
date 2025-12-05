const kuromoji = require("kuromoji");
const path = require("path");

const dictPath = path.join(__dirname, "dict");

kuromoji.builder({ dicPath: dictPath }).build((err, tokenizer) => {
    if (err) {
        console.error(err);
        return;
    }
    const text = "これはテストです。";
    const tokens = tokenizer.tokenize(text);
    console.log(JSON.stringify(tokens, null, 2));
});
