# ext_server.py
# VSCode拡張プロジェクト用の簡易 MCP サーバー（拡張開発向けチューニング版）

from __future__ import annotations

from pathlib import Path
from typing import List
import json          # 追加：package.json の読み取り用
import subprocess    # 追加：npm スクリプト実行用
import locale        # 追加：コンソールの文字コード取得用

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("ext-server")

# このファイルがあるディレクトリをルートとする
WORKSPACE_ROOT = Path(__file__).resolve().parent

# 無視したいディレクトリ・拡張子を定義
IGNORED_DIRS = {".git", "node_modules", ".venv", ".mcp"}
IGNORED_FILE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".zip",
    ".tgz",
    ".gz",
    ".lock",
}
MAX_READ_BYTES = 200_000  # これ以上大きいファイルは読むのを拒否（約 200KB）

# コンソールのエンコーディング（Windows なら cp932、Linux/mac なら utf-8 が入ることが多い）
CONSOLE_ENCODING = locale.getpreferredencoding(False)


def _safe_path(rel_path: str) -> Path:
    """
    相対パスから絶対パスを作り、WORKSPACE_ROOTの外には出ないようにする
    """
    p = (WORKSPACE_ROOT / rel_path).resolve()
    if WORKSPACE_ROOT not in p.parents and p != WORKSPACE_ROOT:
        raise ValueError(f"ワークスペース外のパスは参照できません: {p}")
    return p


@mcp.tool()
async def list_workspace_files() -> List[str]:
    """
    拡張フォルダ配下のファイル一覧（相対パス）を返す。
    例: ["package.json", "src/extension.ts", ...]
    node_modules や .git など、明らかなノイズは除外する。
    """
    results: List[str] = []
    for path in WORKSPACE_ROOT.rglob("*"):
        if not path.is_file():
            continue

        # 無視したいディレクトリ配下はスキップ
        if any(part in IGNORED_DIRS for part in path.parts):
            continue

        # バイナリっぽい拡張子はスキップ
        if path.suffix in IGNORED_FILE_SUFFIXES:
            continue

        results.append(str(path.relative_to(WORKSPACE_ROOT)))
    return results


@mcp.tool()
async def read_file(rel_path: str) -> str:
    """
    相対パスで指定したファイルの中身を返す。
    例: rel_path="src/extension.ts"

    大きすぎるファイルやバイナリっぽい拡張子はエラーにする。
    文字コードは UTF-8 固定とし、UTF-8 として解釈できない場合はエラーを返す。
    """
    path = _safe_path(rel_path)

    # バイナリっぽい拡張子を拒否
    if path.suffix in IGNORED_FILE_SUFFIXES:
        raise ValueError(f"バイナリファイルは read_file では扱いません: {path}")

    # サイズ制限
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        raise FileNotFoundError(f"ファイルが存在しません: {path}")

    if size > MAX_READ_BYTES:
        raise ValueError(
            f"ファイルが大きすぎます ({size} bytes > {MAX_READ_BYTES} bytes): {path}"
        )

    # UTF-8 として読めない場合は明示的にエラーにする
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        raise ValueError(
            f"UTF-8 として読み取れませんでした: {path}\n"
            f"既存ファイルの文字コードが UTF-8 以外の可能性があります。"
        ) from e


@mcp.tool()
async def write_file(rel_path: str, content: str) -> str:
    """
    相対パスで指定したファイルを書き換える（全置換）。
    例: rel_path="src/extension.ts"

    文字コードは UTF-8 で固定して書き込む。
    ※ モデルには「diff を提示してから write_file を呼ぶ」ようにプロンプトで指示すると安全。
    """
    path = _safe_path(rel_path)

    # バイナリっぽい拡張子は念のため拒否
    if path.suffix in IGNORED_FILE_SUFFIXES:
        raise ValueError(f"バイナリファイルへの書き込みは許可されていません: {path}")

    path.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8 固定で書き込み。Python 内部の str は Unicode なので、ここでのエンコードは一貫して UTF-8 になる。
    path.write_text(content, encoding="utf-8")
    return f"書き込み完了: {path}"


# 追加：npm scripts を実行してエラー内容を取得するツール
@mcp.tool()
async def run_npm_script(script: str) -> str:
    """
    package.json の scripts から指定したスクリプトを実行し、
    終了コード・標準出力・標準エラーをまとめて返す。

    例:
        script="lint"
        script="compile"
        script="test"

    想定用途:
        - write_file で書き換えたあとに lint / build / test を走らせ、
          エラーがあればその内容をもとにモデル側で自動修正させる。
    """
    pkg_path = WORKSPACE_ROOT / "package.json"
    if not pkg_path.exists():
        raise FileNotFoundError(f"package.json が見つかりません: {pkg_path}")

    try:
        pkg_data = json.loads(pkg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"package.json が不正な JSON です: {e}") from e

    scripts = pkg_data.get("scripts") or {}
    if script not in scripts:
        raise ValueError(
            f"package.json に scripts.{script} が定義されていません。\n"
            f"定義されているスクリプト: {', '.join(sorted(scripts.keys()))}"
        )

    # npm run <script> を実行
    # Windows でも日本語が文字化けしないように、コンソールのエンコーディングでデコードする。
    proc = subprocess.run(
        ["npm", "run", script, "--", "--no-color"],
        cwd=WORKSPACE_ROOT,
        capture_output=True,
        text=True,
        encoding=CONSOLE_ENCODING,
        errors="replace",  # デコード不能な文字は置き換え（例外で落ちないように）
    )

    return (
        f"exit_code: {proc.returncode}\n"
        f"stdout:\n{proc.stdout}\n"
        f"stderr:\n{proc.stderr}"
    )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
