// minimap_highlight.js
const vscode = require("vscode");
const { getHeadingLevel, getHeadingsCached } = require("./utils");

/** 見出しレベルごとに別デコレーション（ミニマップ前景色） */
// レベルごとに異なる色を割り当てて可視化するための設定を生成する
function makeDecorationTypes() {
  // テーマに馴染みやすい無彩色寄りのコントラスト配色（必要なら自由に差し替え）
  const colors = [
    "#ff14e0aa", // H1
    "#fd9bcccc", // H2
    "#4dd0e1cc", // H3
    "#11ff84aa", // H4
    "#ffe955aa", // H5
    "#f94446cc", // H6
  ];
  return colors.map((c) =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      // ミニマップに強調を出す（foreground に塗る）
      // @ts-ignore minimap is available on DecorationRenderOptions at VS Code >= 1.103
      minimap: { color: c, position: "foreground" },
      // ついでに overviewRuler にも痕跡を出す（お好みで）
      overviewRulerColor: c,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    })
  );
}

/** 現在のエディタから見出し行の Range を抽出（レベル別） */
// H1〜H6 で配列を分け、デコレーションにそのまま渡せる形にする
// H1〜H6 で配列を分け、デコレーションにそのまま渡せる形にする
function collectHeadingRanges(editor) {
  const doc = editor.document;
  const headings = getHeadingsCached(doc);
  const byLevel = [[], [], [], [], [], []]; // H1..H6

  for (const h of headings) {
    // isWholeLine:true なので 0〜0 でも行全体に効く
    const pos = new vscode.Position(h.line, 0);
    // h.level は 1〜6 が保証されているはずだが念のため clamp
    const lvIdx = Math.min(Math.max(h.level, 1), 6) - 1;
    byLevel[lvIdx].push(new vscode.Range(pos, pos));
  }
  return byLevel;
}

/** ミニマップ反映 */
// 収集した行範囲をそれぞれのデコレーションに適用してハイライトする
function applyMinimapDecorations(editor, decoTypes) {
  const byLevel = collectHeadingRanges(editor);
  for (let i = 0; i < decoTypes.length; i++) {
    editor.setDecorations(decoTypes[i], byLevel[i]);
  }
}

/**
 * エントリポイント
 * @param {vscode.ExtensionContext} context
 * @param {{cfg:()=>any, isTargetDoc:(doc:any,c:any)=>boolean}} helpers
 */
function initMinimapHighlight(context, helpers) {
  const deco = makeDecorationTypes();

  function refreshIfTarget(ed) {
    // 適用対象ファイルのみミニマップを更新する
    if (!ed) return;
    const c = helpers.cfg();
    if (!helpers.isTargetDoc(ed.document, c)) return;
    applyMinimapDecorations(ed, deco);
  }

  // 起動直後＆エディタ切替で反映
  refreshIfTarget(vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => refreshIfTarget(ed))
  );

  //  保存時だけ更新
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) refreshIfTarget(ed);
    })
  );

  // 手動更新用コマンド（任意）
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.headings.minimapRefresh", () => {
      refreshIfTarget(vscode.window.activeTextEditor);
    })
  );

  // 破棄
  context.subscriptions.push({
    dispose: () => deco.forEach((d) => d.dispose()),
  });
}

module.exports = { initMinimapHighlight };
