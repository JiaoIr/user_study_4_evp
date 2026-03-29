from __future__ import annotations

import base64
import ast
import importlib
import json
import mimetypes
import re
import textwrap
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[2]
PROMPT_FILES = {
    "1": "prompts/prompt1.md",
    "2": "prompts/prompt2.md",
    "3_1": "prompts/prompt3_1.md",
    "3_2": "prompts/prompt3_2.md",
    "3_3": "prompts/prompt3_3.md",
    "3_4": "prompts/prompt3_4.md",
    "3_5": "prompts/prompt3_5.md",
    "3_6": "prompts/prompt3_6.md",
    "3_7": "prompts/prompt3_7.md",
    "3_8": "prompts/prompt3_8.md",
}
PHASES = ["3_5", "3_6", "3_7"]

BASE_URL = "https://api.key77qiqi.com/v1"
API_KEY = "sk-TiKvU1tRVmWKZx76cV5JLbaDwJ5bZEvIee2MJAJ2Drghi55R"

class PipelineError(RuntimeError):
    pass


class PromptEngine:
    def __init__(self, work_dir: Optional[Path] = None) -> None:
        self.search_roots: List[Path] = []
        if work_dir:
            self.search_roots.append(Path(work_dir))
        self.search_roots.append(SCRIPT_DIR)

    def resolve_prompt_file(self, relative_path: str) -> Path:
        tried: List[Path] = []
        for root in self.search_roots:
            candidate = root / relative_path
            tried.append(candidate)
            if candidate.exists():
                return candidate

        tried_text = "\n".join(f"- {p}" for p in tried)
        raise PipelineError(f"Prompt file not found for {relative_path}. Tried:\n{tried_text}")

    def load_prompt_template(self, step_id: str) -> str:
        rel = PROMPT_FILES.get(step_id)
        if not rel:
            raise PipelineError(f"Unknown step id: {step_id}")
        path = self.resolve_prompt_file(rel)
        return path.read_text(encoding="utf-8")

    def render_prompt(self, template: str, mapping: Dict[str, Any]) -> str:
        text = template
        for key, value in mapping.items():
            marker = "{{" + key + "}}"
            text = text.replace(marker, self._to_text(value))
        return text

    @staticmethod
    def _to_text(value: Any) -> str:
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, indent=2)


class Storage:
    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)

    def write_text(self, rel_path: str, text: str) -> Path:
        path = self.run_dir / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def write_json(self, rel_path: str, data: Any) -> Path:
        return self.write_text(rel_path, json.dumps(data, ensure_ascii=False, indent=2))

    def read_json(self, rel_path: str) -> Any:
        path = self.run_dir / rel_path
        if not path.exists():
            raise PipelineError(f"Missing file: {path}")
        return json.loads(path.read_text(encoding="utf-8"))


class AgentBackend:
    def __init__(self, model: str, work_dir: Path) -> None:
        self.model = model
        self.work_dir = work_dir
        self._client: Optional[Any] = None

    def generate(
        self,
        prompt_text: str,
        image_paths: Optional[List[str]] = None,
        step_tag: str = "",
    ) -> str:
        if self.model == "debug":
            return self._debug_generate(prompt_text, image_paths=image_paths, step_tag=step_tag)
        return self._openai_generate(prompt_text, image_paths=image_paths)

    def _debug_generate(
        self,
        prompt_text: str,
        image_paths: Optional[List[str]] = None,
        step_tag: str = "",
    ) -> str:
        query_path = self.work_dir / "query.txt"
        response_path = self.work_dir / "response.txt"

        image_part = ""
        if image_paths:
            lines = [f"- {p}" for p in image_paths if str(p).strip()]
            if lines:
                image_part = "\n\n[images]\n" + "\n".join(lines)

        query_text = prompt_text + image_part
        query_path.write_text(query_text, encoding="utf-8")
        if not response_path.exists():
            response_path.write_text("", encoding="utf-8")

        print(
            "\n[DEBUG] Please read the following files and provide a response before continuing:"
            f"\n  step: {step_tag or '-'}"
            f"\n  query: {query_path}"
            f"\n  response: {response_path}\n"
        )
        input("Press Enter to load response.txt ... ")

        out = response_path.read_text(encoding="utf-8").strip()
        if not out:
            raise PipelineError(f"Debug response is empty: {response_path}")
        return out

    def _openai_generate(self, prompt_text: str, image_paths: Optional[List[str]] = None) -> str:
        if not self.model.strip():
            raise PipelineError("自动模式需要提供 --model")
        client = self._get_client()

        content: List[Dict[str, Any]] = [{"type": "text", "text": prompt_text}]
        for image_path in image_paths or []:
            resolved = self._resolve_image_path(image_path)
            if not resolved:
                continue
            encoded = self._encode_image_base64(resolved)
            mime_type = mimetypes.guess_type(str(resolved))[0] or "image/jpeg"
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{encoded}"
                    },
                }
            )

        resp = client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "user",
                    "content": content,
                }
            ],
        )

        message = resp.choices[0].message.content if resp.choices else ""
        if isinstance(message, str):
            out = message.strip()
        elif isinstance(message, list):
            # Some providers return structured content parts.
            texts = [str(item.get("text", "")) for item in message if isinstance(item, dict)]
            out = "\n".join(t for t in texts if t).strip()
        else:
            out = str(message).strip()

        if not out:
            raise PipelineError("OpenAI response is empty.")
        return out

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        if not API_KEY.strip():
            raise PipelineError("API_KEY 为空，请在 design_engine_shared.py 中配置常量。")
        try:
            openai_mod = importlib.import_module("openai")
        except ImportError as exc:
            raise PipelineError("缺少 openai 依赖，请先安装: pip install openai") from exc
        self._client = openai_mod.OpenAI(api_key=API_KEY, base_url=BASE_URL)
        return self._client

    def _resolve_image_path(self, image_path: str) -> Optional[Path]:
        p = Path(str(image_path).strip())
        if not str(p):
            return None
        if p.is_absolute() and p.exists():
            return p

        candidates = [
            self.work_dir / p,
            PROJECT_ROOT / p,
            (self.work_dir / ".." / p).resolve(),
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return None

    @staticmethod
    def _encode_image_base64(image_path: Path) -> str:
        with image_path.open("rb") as image_file:
            return base64.b64encode(image_file.read()).decode("utf-8")


def parse_json_output(text: str) -> Any:
    cleaned = strip_code_fence(text).strip()
    if not cleaned:
        raise PipelineError("Empty output, cannot parse JSON.")

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", cleaned)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise PipelineError(f"JSON parse failed: {exc}") from exc

    raise PipelineError("No JSON object found in response.")


def strip_code_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        lines = t.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return t


def normalize_python_code_output(text: str) -> str:
    # Remove markdown fence lines anywhere in the response body.
    raw_lines = text.strip().splitlines()
    lines = [line for line in raw_lines if not line.strip().startswith("```")]
    cleaned = "\n".join(lines).strip()
    if not cleaned:
        return ""

    cleaned = _drop_non_code_preamble(cleaned)
    cleaned = textwrap.dedent(cleaned).strip()
    repaired = _repair_function_body_indentation(cleaned)
    repaired = _repair_parenthesized_block_indentation(repaired)

    # Keep repaired result when it parses; otherwise return best-effort cleaned text.
    if _is_valid_python(repaired):
        return repaired
    return cleaned


def _drop_non_code_preamble(text: str) -> str:
    lines = text.splitlines()
    code_start = None
    for i, line in enumerate(lines):
        s = line.strip()
        if not s:
            continue
        if re.match(r"^(def|class)\s+", s):
            code_start = i
            break
        if re.match(r"^(from\s+\S+\s+import|import\s+\S+|@)", s):
            code_start = i
            break

    if code_start is None:
        return text

    for line in lines[:code_start]:
        s = line.strip()
        if s and not s.startswith("#"):
            return "\n".join(lines[code_start:]).strip()
    return text


def _indent_len(line: str) -> int:
    expanded = line.replace("\t", "    ")
    return len(expanded) - len(expanded.lstrip(" "))


def _repair_function_body_indentation(text: str) -> str:
    lines = text.splitlines()
    if not lines:
        return text

    out = list(lines)
    i = 0
    while i < len(out):
        current = out[i]
        m = re.match(r"^(\s*)def\s+\w+\s*\(.*\)\s*:\s*$", current)
        if not m:
            i += 1
            continue

        base_indent = _indent_len(current)
        j = i + 1
        while j < len(out):
            line = out[j]
            stripped = line.strip()
            if not stripped:
                j += 1
                continue

            indent = _indent_len(line)
            if indent <= base_indent and re.match(r"^\s*(def|class)\s+\w+", line):
                break

            if indent <= base_indent:
                out[j] = " " * (base_indent + 4) + stripped
            j += 1

        i = j

    return "\n".join(out).strip()


def _repair_parenthesized_block_indentation(text: str) -> str:
    lines = text.splitlines()
    if not lines:
        return text

    out = list(lines)
    stack: List[int] = []

    for i, line in enumerate(out):
        stripped = line.strip()
        indent = _indent_len(line)

        if stack:
            base = stack[-1]
            if stripped.startswith(")"):
                out[i] = " " * base + stripped
                stack.pop()
            elif stripped and indent <= base:
                out[i] = " " * (base + 4) + stripped

        current = out[i].rstrip()
        if current.endswith("("):
            stack.append(_indent_len(out[i]))

    return "\n".join(out).strip()


def _is_valid_python(text: str) -> bool:
    if not text.strip():
        return False
    try:
        ast.parse(text)
        return True
    except SyntaxError:
        return False


def extract_line_window(numbered_text: str, start_line: int, end_line: int) -> str:
    lines = numbered_text.splitlines()
    selected: List[str] = []

    for line in lines:
        line_no, _ = split_leading_line_number(line)
        if line_no is None:
            continue
        if start_line <= line_no <= end_line:
            selected.append(line)

    if selected:
        return "\n".join(selected)

    start_idx = max(start_line - 1, 0)
    end_idx = min(end_line, len(lines))
    return "\n".join(lines[start_idx:end_idx])


def split_leading_line_number(line: str) -> Tuple[Optional[int], str]:
    m = re.match(r"^\s*(\d+)\s+(.*)$", line)
    if not m:
        return None, line
    return int(m.group(1)), m.group(2)


def guess_test_key(code_map: Dict[str, Any]) -> str:
    for key in code_map.keys():
        if "test" in key.lower():
            return key
    return ""


def resolve_from_project(path_value: str, anime_json: Path, anime_info: Optional[Dict[str, Any]] = None) -> Path:
    p = Path(path_value)
    if p.is_absolute():
        return p

    # Resolve paths like "__debug/trace/code.json" against workspace root,
    # not against anime folder (__debug/anime).
    candidates: List[Path] = []

    def _push(candidate: Path) -> None:
        if candidate not in candidates:
            candidates.append(candidate)

    # 1) workspace_root from anime.json, if provided.
    workspace_root = ""
    if isinstance(anime_info, dict):
        workspace_root = str(anime_info.get("workspace_root", "")).strip()
    if workspace_root:
        _push(Path(workspace_root) / p)

    # 2) infer workspace root from anime_json location:
    #    <workspace>/__debug/anime/anime.json -> <workspace>
    inferred_root: Optional[Path] = None
    try:
        if anime_json.parent.name == "anime" and anime_json.parent.parent.name == "__debug":
            inferred_root = anime_json.parent.parent.parent
    except IndexError:
        inferred_root = None

    if inferred_root is not None:
        _push(inferred_root / p)

    # 3) extension project root (legacy behavior).
    _push(PROJECT_ROOT / p)

    # 4) anime folder relative path (legacy fallback).
    _push(anime_json.parent / p)

    for candidate in candidates:
        if candidate.exists():
            return candidate

    # Keep a deterministic return path for error messages.
    return candidates[0] if candidates else (anime_json.parent / p)


def extract_visual_function_name(visual_function: str) -> str:
    base = str(visual_function).split("#", 1)[0].strip()
    if not base:
        return "run"
    last_word = base.split(".")[-1].strip() or "run"
    safe_name = re.sub(r"[^0-9A-Za-z_-]+", "_", last_word)
    return safe_name or "run"


def load_common_inputs_from_anime(
    anime_json: Path,
) -> Tuple[Path, Dict[str, Any], Dict[str, Any], Dict[str, Any], str]:
    if not anime_json.is_absolute():
        anime_json = (PROJECT_ROOT / anime_json).resolve()
    if not anime_json.exists():
        raise PipelineError(f"anime json not found: {anime_json}")

    anime_info = json.loads(anime_json.read_text(encoding="utf-8"))
    code_path_value = anime_info.get("code", "")
    trace_path_value = anime_info.get("trace", "")
    visual_function = anime_info.get("visual_function", "")

    if not code_path_value:
        raise PipelineError("anime.json 缺少字段: code")
    if not trace_path_value:
        raise PipelineError("anime.json 缺少字段: trace")
    if not visual_function:
        raise PipelineError("anime.json 缺少字段: visual_function")

    code_json = resolve_from_project(str(code_path_value), anime_json, anime_info)
    trace_json = resolve_from_project(str(trace_path_value), anime_json, anime_info)
    if not code_json.exists():
        raise PipelineError(f"code json not found: {code_json}")
    if not trace_json.exists():
        raise PipelineError(f"trace json not found: {trace_json}")

    code_info = json.loads(code_json.read_text(encoding="utf-8"))
    trace_info = json.loads(trace_json.read_text(encoding="utf-8"))

    fn_key = str(visual_function)
    test_key = guess_test_key(code_info)
    if fn_key not in code_info:
        raise PipelineError(f"visual_function 未在 code.json 中找到: {fn_key}")
    if not test_key or test_key not in code_info:
        raise PipelineError("无法自动定位 test_case，请检查 code.json 的测试函数键。")

    return anime_json, anime_info, trace_info, code_info, extract_visual_function_name(fn_key)


def build_function_summary(step1: Dict[str, Any]) -> str:
    summary = str(step1.get("summary", "")).strip()
    bug_hint = str(step1.get("bug_hint", "")).strip()
    return "\n".join(part for part in [summary, bug_hint] if part)


def normalize_step1_blocks(step1: Dict[str, Any]) -> Dict[str, Any]:
    blocks = step1.get("blocks", [])
    if not isinstance(blocks, list):
        return step1

    normalized: List[Any] = []
    for block in blocks:
        if not isinstance(block, dict):
            normalized.append(block)
            continue

        title = str(block.get("title", "")).strip()
        description = str(block.get("description", "")).strip()
        title_short = str(block.get("title_short", "")).strip()

        if not title:
            title = " ".join(_split_words(description)[:3]) or "Block"
        title = _limit_words(title, 3) or "Block"

        if not title_short:
            title_short = _limit_words(title, 1) or "Block"
        title_short = _limit_words(title_short, 1) or "Block"

        block["title"] = title
        block["title_short"] = title_short
        normalized.append(block)

    step1["blocks"] = normalized
    return step1


def _split_words(text: str) -> List[str]:
    return [w for w in re.split(r"\s+", text.strip()) if w]


def _limit_words(text: str, max_words: int) -> str:
    return " ".join(_split_words(text)[:max_words])
