from __future__ import annotations

import argparse
import datetime as dt
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from design_engine_shared import (
    PROJECT_ROOT,
    SCRIPT_DIR,
    AgentBackend,
    PipelineError,
    PromptEngine,
    Storage,
    build_function_summary,
    load_common_inputs_from_anime,
    normalize_step1_blocks,
    parse_json_output,
)


@dataclass
class Step12Config:
    model: str
    max_refine_rounds: int
    anime_json: Path
    work_dir: Path
    run_dir: Path
    anime_info: Dict[str, Any]
    trace_info: Dict[str, Any]
    code_info: Dict[str, Any]


class Step12Runner:
    def __init__(self, config: Step12Config) -> None:
        self.config = config
        self.storage = Storage(config.run_dir)
        self.engine = PromptEngine(config.work_dir)
        self.agent = AgentBackend(config.model, config.work_dir)

    def run(self) -> None:
        self._write_manifest()

        step1 = self._run_step(
            step_id="1",
            step_tag="step1",
            mapping={
                "FUNCTION_CODE": self._get_function_code(),
                "TEST_CASE": self._get_test_case(),
                "TEST_FAILURE": self._get_test_failure(),
            },
            expect="json",
        )
        step1 = normalize_step1_blocks(step1)

        step2 = self._run_step(
            step_id="2",
            step_tag="step2",
            mapping={
                "FUNCTION_SUMMARY": build_function_summary(step1),
                "BLOCK_JSON": step1.get("blocks", []),
            },
            expect="json",
        )

        blocks = step1.get("blocks", [])
        if not isinstance(blocks, list) or not blocks:
            raise PipelineError("Step 1 did not return valid blocks.")

        blocks_entire = self._build_blocks_entire(blocks)

        self.storage.write_json("state/step1.json", step1)
        self.storage.write_json("state/step2.json", step2)
        self.storage.write_json("state/current_elements.json", step2.get("visual_elements", []))
        self.storage.write_json("state/blocks_entire.json", blocks_entire)
        self.storage.write_json(
            "state/bridge_step12_to_step3.json",
            {
                "anime_json": str(self.config.anime_json),
                "run_dir": str(self.config.run_dir),
                "block_count": len(blocks),
                "blocks_entire": "state/blocks_entire.json",
                "note": "Run external instrumentation to produce frame.json before step3.",
            },
        )

    def _run_step(self, step_id: str, step_tag: str, mapping: Dict[str, Any], expect: str) -> Any:
        template = self.engine.load_prompt_template(step_id)
        prompt = self.engine.render_prompt(template, mapping)
        step_folder = f"steps/{step_tag}"

        self.storage.write_text(f"{step_folder}/prompt.md", prompt)
        raw = self.agent.generate(prompt, step_tag=step_tag)
        self.storage.write_text(f"{step_folder}/response_raw.txt", raw)

        if expect == "json":
            parsed = parse_json_output(raw)
            self.storage.write_json(f"{step_folder}/response.json", parsed)
            return parsed

        raise PipelineError(f"Unsupported expect mode in step12: {expect}")

    def _get_function_code(self) -> str:
        fn_key = str(self.config.anime_info.get("visual_function", ""))
        fn_info = self.config.code_info.get(fn_key, {})
        return fn_info.get("whole", "") if isinstance(fn_info, dict) else ""

    def _get_test_case(self) -> str:
        return str(self.config.anime_info.get("test_description", ""))

    def _get_test_failure(self) -> str:
        return str(self.config.anime_info.get("test_failure", ""))

    def _build_blocks_entire(self, blocks: List[Any]) -> Dict[str, Any]:
        method = str(self.config.anime_info.get("visual_function", "")).strip()
        fn_info = self.config.code_info.get(method, {}) if method else {}
        src_file = fn_info.get("src_path", "") if isinstance(fn_info, dict) else ""

        block_items: List[Dict[str, Any]] = []
        for idx, block in enumerate(blocks):
            if not isinstance(block, dict):
                continue
            cstart = self._to_int(block.get("start_line"))
            cend = self._to_int(block.get("end_line"))
            if cstart is None or cend is None:
                continue

            trace_start, trace_end = self._find_trace_range(method, cstart, cend)
            block_items.append(
                {
                    "id": self._to_int(block.get("block_id"), default=idx + 1),
                    "name": str(block.get("title_short") or block.get("title") or f"Block{idx + 1}"),
                    "method": method,
                    "start": block.get("start"),
                    "end": block.get("end"),
                    "cstart": cstart,
                    "cend": cend,
                    "tstart": self._trace_pos(trace_start),
                    "tend": self._trace_pos(trace_end),
                    "trace_start": trace_start,
                    "trace_end": trace_end,
                }
            )

        return {
            "file": src_file,
            "method": method,
            "blocks": block_items,
        }

    def _find_trace_range(self, method: str, cstart: int, cend: int) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        traces = self.config.trace_info.get("trace", [])
        if not isinstance(traces, list):
            return None, None

        first: Optional[Dict[str, Any]] = None
        last: Optional[Dict[str, Any]] = None
        low, high = (cstart, cend) if cstart <= cend else (cend, cstart)

        for item in traces:
            if not isinstance(item, dict):
                continue
            item_method = str(item.get("method_name") or item.get("code_key") or "")
            if item_method != method:
                continue
            line_no = self._to_int(item.get("line"))
            if line_no is None or line_no < low or line_no > high:
                continue

            if first is None:
                first = item
            last = item

        return first, last

    @staticmethod
    def _trace_pos(trace_item: Optional[Dict[str, Any]]) -> Optional[int]:
        if not isinstance(trace_item, dict):
            return None
        if isinstance(trace_item.get("order"), int):
            return trace_item.get("order")
        if isinstance(trace_item.get("id"), int):
            return trace_item.get("id")
        return None

    @staticmethod
    def _to_int(value: Any, default: Optional[int] = None) -> Optional[int]:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _write_manifest(self) -> None:
        manifest = {
            "started_at": dt.datetime.now().isoformat(timespec="seconds"),
            "stage": "step1_2",
            "max_refine_rounds": self.config.max_refine_rounds,
            "work_dir": str(self.config.work_dir),
            "run_dir": str(self.config.run_dir),
            "anime_json": str(self.config.anime_json),
        }
        self.storage.write_json("state/manifest_step12.json", manifest)
        (self.config.work_dir / "latest_run.txt").write_text(str(self.config.run_dir), encoding="utf-8")


def make_config(args: argparse.Namespace) -> Step12Config:
    anime_json, anime_info, trace_info, code_info, visual_function_extraction = load_common_inputs_from_anime(
        Path(args.anime_json)
    )

    if args.work_dir:
        work_dir = Path(args.work_dir)
        if not work_dir.is_absolute():
            work_dir = (PROJECT_ROOT / work_dir).resolve()
    else:
        work_dir = anime_json.parent / "design"

    if args.run_dir:
        run_dir = Path(args.run_dir)
        if not run_dir.is_absolute():
            run_dir = (work_dir / run_dir).resolve()
    else:
        run_dir = work_dir / "engine_runs" / f"{visual_function_extraction}_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}"

    return Step12Config(
        model=args.model,
        max_refine_rounds=max(0, args.max_refine_rounds),
        anime_json=anime_json,
        work_dir=work_dir,
        run_dir=run_dir,
        anime_info=anime_info,
        trace_info=trace_info,
        code_info=code_info,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run design engine step1-2 only.")
    parser.add_argument("--model", default="gpt-4o-mini", help="Model name for OpenAI chat completions, or 'debug'")
    parser.add_argument("--max-refine-rounds", type=int, default=2)
    parser.add_argument(
        "--anime-json",
        default=str(PROJECT_ROOT / "__debug" / "anime" / "anime.json"),
        help="Path to __debug/anime/anime.json",
    )
    parser.add_argument(
        "--work-dir",
        default="",
        help="Working directory for debug query/response and latest_run.txt (default: <anime_json_dir>/design)",
    )
    parser.add_argument(
        "--run-dir",
        default="",
        help="Output run directory (default: <work_dir>/engine_runs/<name>_<timestamp>)",
    )
    return parser.parse_args()


def run_stage12(args: argparse.Namespace) -> Path:
    config = make_config(args)
    Step12Runner(config).run()
    return config.run_dir


def main() -> int:
    args = parse_args()
    try:
        run_dir = run_stage12(args)
        print(f"\nStep1-2 completed. Output dir: {run_dir}")
        return 0
    except PipelineError as exc:
        print(f"\nStep1-2 failed: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
