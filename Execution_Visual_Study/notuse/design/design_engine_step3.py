from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from design_engine_shared import (
    PHASES,
    PROJECT_ROOT,
    SCRIPT_DIR,
    AgentBackend,
    PipelineError,
    PromptEngine,
    Storage,
    extract_line_window,
    load_common_inputs_from_anime,
    normalize_step1_blocks,
    normalize_python_code_output,
    parse_json_output,
)


@dataclass
class Step3Config:
    model: str
    max_refine_rounds: int
    anime_json: Path
    frame_json: Path
    work_dir: Path
    run_dir: Path
    anime_info: Dict[str, Any]
    trace_info: Dict[str, Any]
    code_info: Dict[str, Any]
    frame_info: Dict[str, Any]
    bridge_info: Dict[str, Any]
    blocks_entire_info: Dict[str, Any]
    blocks_entire_path: Path
    preview_image_dir: Path


class Step3Runner:
    def __init__(self, config: Step3Config) -> None:
        self.config = config
        self.storage = Storage(config.run_dir)
        self.engine = PromptEngine(config.work_dir)
        self.agent = AgentBackend(config.model, config.work_dir)
        self.script_template = self._load_script_template()

    def run(self) -> None:
        self._write_manifest()

        step1 = self.storage.read_json("steps/step1/response.json")
        step1 = normalize_step1_blocks(step1)
        step2 = self.storage.read_json("steps/step2/response.json")
        blocks = step1.get("blocks", [])
        if not isinstance(blocks, list) or not blocks:
            raise PipelineError("Step 1 output missing valid blocks. Please run step1-2 first.")

        # Step3 starts from an empty per-block canvas state instead of inheriting global elements.
        current_elements: List[Any] = []
        code_functions_map: Dict[int, str] = {}
        script_before = self._render_script(
            blocks=blocks,
            code_functions_map=code_functions_map,
        )
        self.storage.write_text("state/script_before_block_0.py", script_before)

        block_results: Dict[str, Any] = {}
        code_functions: Dict[str, str] = {}

        for idx, block in enumerate(blocks, start=1):
            block_id = int(block.get("block_id", idx))
            print(f"\n=== Block {block_id} ===")
            block_result, current_elements, current_code, script_after = self._run_block(
                block_id=block_id,
                block_index=idx,
                block_meta=block,
                script_before=script_before,
                current_elements=current_elements,
            )
            block_results[str(block_id)] = block_result
            code_functions[str(block_id)] = current_code
            code_functions_map[block_id] = current_code
            script_before = self._render_script(blocks=blocks, code_functions_map=code_functions_map)
            self.storage.write_text(f"state/script_before_block_{idx}.py", script_before)
            self.storage.write_text(f"state/script_after_block_{idx}.py", script_after)

        self.storage.write_json(
            "state/final_state.json",
            {
                "step1": step1,
                "step2": step2,
                "current_elements": current_elements,
                "block_count": len(block_results),
            },
        )
        self.storage.write_json("result/blocks.json", block_results)
        keys = sorted(code_functions.keys(), key=lambda x: int(x))
        merged_code = "\n\n".join(code_functions[k].strip() for k in keys if code_functions[k].strip())
        self.storage.write_text("result/generated_blocks.py", merged_code)
        self.storage.write_text("result/generated_script.py", script_before)
        self.storage.write_json(
            "result/summary.json",
            {
                "run_dir": str(self.config.run_dir),
                "finished_at": dt.datetime.now().isoformat(timespec="seconds"),
                "stage": "step3",
            },
        )

    def _run_block(
        self,
        block_id: int,
        block_index: int,
        block_meta: Dict[str, Any],
        script_before: str,
        current_elements: List[Any],
    ) -> Tuple[Dict[str, Any], List[Any], str, str]:
        block_ctx = self._get_block_context(block_id, block_index)
        block_dir = f"blocks/block_{block_id}"
        snippet = str(block_ctx.get("snippet", "")).strip() or self._build_block_snippet(block_meta)

        design31 = self._run_step(
            step_id="3_1",
            step_tag=f"block{block_id}_3_1",
            mapping={
                "snippet": snippet,
                "trace": block_ctx.get("line", ""),
                "statebefore": block_ctx.get("state_before", ""),
                "stateafter": block_ctx.get("state_after", ""),
            },
            expect="json",
            output_prefix=block_dir,
        )

        elements32 = self._run_step(
            step_id="3_2",
            step_tag=f"block{block_id}_3_2",
            mapping={
                "prevelements": current_elements,
                "design": design31,
            },
            expect="json",
            output_prefix=block_dir,
        )

        timeline33 = self._run_step(
            step_id="3_3",
            step_tag=f"block{block_id}_3_3",
            mapping={
                "elements": {
                    "transitions": elements32.get("transitions", []),
                    "final_elements": elements32.get("final_elements", []),
                }
            },
            expect="json",
            output_prefix=block_dir,
        )

        code34 = self._run_step(
            step_id="3_4",
            step_tag=f"block{block_id}_3_4",
            mapping={
                "timeline": timeline33.get("timeline", []),
                "elements": {
                    "transitions": elements32.get("transitions", []),
                    "final_elements": elements32.get("final_elements", []),
                },
                "manimcode": script_before,
                "BLOCK_ID": block_id,
            },
            expect="code",
            output_prefix=block_dir,
        )

        current_elements = elements32.get("final_elements", current_elements)
        current_timeline = timeline33.get("timeline", [])
        current_code = code34

        repairs: Dict[str, Any] = {"3_5": {}, "3_6": {}, "3_7": {}}
        reflection_phases = [phase for phase in PHASES if phase in {"3_5", "3_6"}]
        # reflection_phases = [phase for phase in PHASES if phase in {"3_5", "3_6", "3_7"}]

        for phase in reflection_phases:
            for attempt in range(1, self.config.max_refine_rounds + 1):
                preview: Dict[str, Any] = {}
                if phase in {"3_6", "3_7"}:
                    preview = self._prepare_preview_run(
                        block_id=block_id,
                        phase=phase,
                        attempt=attempt,
                        script_before=script_before,
                        current_code=current_code,
                    )
                if phase == "3_6":
                    images = self._collect_preview_images(block_id)
                    if images:
                        block_ctx["final_frame_image"] = images
                if phase == "3_7":
                    block_ctx["user_feedback"] = self._get_user_feedback(block_id, attempt)

                phase_result = self._run_reflection_phase(
                    phase=phase,
                    attempt=attempt,
                    block_id=block_id,
                    block_dir=block_dir,
                    current_elements=current_elements,
                    current_timeline=current_timeline,
                    current_code=current_code,
                    block_ctx=block_ctx,
                )
                if preview:
                    phase_result["preview"] = preview
                repairs[phase] = phase_result

                merge38 = self._run_step(
                    step_id="3_8",
                    step_tag=f"block{block_id}_{phase}_attempt{attempt}_3_8",
                    mapping={
                        "elements": current_elements,
                        "timeline": current_timeline,
                        "func": current_code,
                        "repairCode": repairs.get("3_5", {}),
                        "repairAnime": repairs.get("3_6", {}),
                        "repairUser": repairs.get("3_7", {}),
                    },
                    expect="json",
                    output_prefix=f"{block_dir}/{phase}/attempt_{attempt}",
                )

                current_elements = merge38.get("fixed_elements", current_elements)
                current_timeline = merge38.get("fixed_timeline", current_timeline)
                current_code = merge38.get("fixed_code", current_code)

                self._write_current_state(current_elements, current_timeline, current_code)

                converged = bool(merge38.get("convergence", {}).get("is_converged", False))
                if converged or attempt >= self.config.max_refine_rounds:
                    break

        self.storage.write_json(f"{block_dir}/final_elements.json", current_elements)
        self.storage.write_json(f"{block_dir}/final_timeline.json", current_timeline)
        self.storage.write_text(f"{block_dir}/final_code.py", current_code)

        script_after = self._replace_code_functions(script_before, current_code)
        return {
            "block_meta": block_meta,
            "design_3_1": design31,
            "elements_3_2": elements32,
            "timeline_3_3": timeline33,
            "code_3_4": code34,
            "repairs": repairs,
            "final": {
                "elements": current_elements,
                "timeline": current_timeline,
                "code": current_code,
            },
        }, current_elements, current_code, script_after

    def _run_reflection_phase(
        self,
        phase: str,
        attempt: int,
        block_id: int,
        block_dir: str,
        current_elements: List[Any],
        current_timeline: List[Any],
        current_code: str,
        block_ctx: Dict[str, Any],
    ) -> Dict[str, Any]:
        mapping = {
            "elements": current_elements,
            "timeline": current_timeline,
            "func": current_code,
            "image": block_ctx.get("final_frame_image", ""),
            "feedback": block_ctx.get("user_feedback", ""),
        }

        if phase == "3_6":
            mapping["image"] = block_ctx.get("final_frame_image", "")
        if phase == "3_7":
            mapping["feedback"] = block_ctx.get("user_feedback", "")

        return self._run_step(
            step_id=phase,
            step_tag=f"block{block_id}_{phase}_attempt{attempt}",
            mapping=mapping,
            expect="json",
            output_prefix=f"{block_dir}/{phase}/attempt_{attempt}",
            image_paths=self._image_inputs_for_phase(phase, block_ctx),
        )

    def _run_step(
        self,
        step_id: str,
        step_tag: str,
        mapping: Dict[str, Any],
        expect: str,
        output_prefix: str,
        image_paths: Optional[List[str]] = None,
    ) -> Any:
        template = self.engine.load_prompt_template(step_id)
        prompt = self.engine.render_prompt(template, mapping)

        step_folder = f"{output_prefix}/{step_tag}"
        self.storage.write_text(f"{step_folder}/prompt.md", prompt)

        raw = self.agent.generate(prompt, image_paths=image_paths, step_tag=step_tag)
        self.storage.write_text(f"{step_folder}/response_raw.txt", raw)

        if expect == "json":
            parsed = parse_json_output(raw)
            self.storage.write_json(f"{step_folder}/response.json", parsed)
            return parsed

        if expect == "code":
            code = normalize_python_code_output(raw)
            self.storage.write_text(f"{step_folder}/response.py", code)
            return code

        raise PipelineError(f"Unsupported expect mode: {expect}")

    def _build_block_snippet(self, block_meta: Dict[str, Any]) -> str:
        function_code = self._get_function_code()
        start = block_meta.get("start_line")
        end = block_meta.get("end_line")
        if start is None or end is None:
            return function_code
        return extract_line_window(function_code, int(start), int(end))

    def _load_script_template(self) -> str:
        path = self.engine.resolve_prompt_file("prompts/slides.py")
        return path.read_text(encoding="utf-8")

    def _render_script(self, blocks: List[Any], code_functions_map: Dict[int, str]) -> str:
        blocks_definition = self._build_blocks_definition(blocks)
        function_calls = self._build_function_calls(blocks)
        code_functions = self._build_code_functions_text(code_functions_map)
        blocks_entire_path = self.config.blocks_entire_path.as_posix()
        blocks_root_path = (self.config.run_dir / "blocks").as_posix()

        text = self.script_template
        text = text.replace("{{blocks_definition}}", blocks_definition)
        text = self._replace_marker_block(text, "function_calls", function_calls)
        text = text.replace("{{code_functions}}", code_functions)
        text = text.replace("{{blocks_entire_path}}", blocks_entire_path)
        text = text.replace("{{blocks_root_path}}", blocks_root_path)
        return text

    def _replace_marker_block(self, template: str, marker_name: str, block_text: str) -> str:
        marker = "{{" + marker_name + "}}"
        pattern = re.compile(rf"^(?P<indent>[ \t]*){re.escape(marker)}\s*$", re.MULTILINE)
        match = pattern.search(template)
        if not match:
            return template.replace(marker, block_text)

        indent = match.group("indent")
        lines = block_text.splitlines()
        if not lines:
            rendered = ""
        else:
            rendered = "\n".join((indent + line) if line else "" for line in lines)

        return template[:match.start()] + rendered + template[match.end():]

    def _replace_code_functions(self, script_before: str, new_function_code: str) -> str:
        marker_start = "### BEGIN LLM BLOCK FUNCTIONS"
        marker_end = "### END LLM BLOCK FUNCTIONS"
        start = script_before.find(marker_start)
        end = script_before.find(marker_end)
        if start == -1 or end == -1 or end <= start:
            return script_before + "\n\n" + new_function_code

        insert_start = start + len(marker_start)
        middle = script_before[insert_start:end].strip()
        if middle:
            updated_middle = middle + "\n\n" + new_function_code.strip()
        else:
            updated_middle = "\n\n" + new_function_code.strip() + "\n"
        return script_before[:insert_start] + "\n" + updated_middle + "\n" + script_before[end:]

    def _build_blocks_definition(self, blocks: List[Any]) -> str:
        names: List[str] = []
        for idx, block in enumerate(blocks, start=1):
            if isinstance(block, dict):
                name = str(block.get("title_short") or block.get("title") or f"Block{idx}")
            else:
                name = f"Block{idx}"
            names.append(name)
        return f"blocks = {json.dumps(names, ensure_ascii=False)}"

    def _build_function_calls(self, blocks: List[Any]) -> str:
        lines: List[str] = []
        for idx, block in enumerate(blocks, start=1):
            block_id = idx
            if isinstance(block, dict):
                try:
                    block_id = int(block.get("block_id", idx))
                except (TypeError, ValueError):
                    block_id = idx

            lines.append(
                f"self.recorder.start_block({block_id}, blocks[{idx - 1}] if len(blocks) > {idx - 1} else \"block_{block_id}\")"
            )
            lines.append(f"animate_block_{block_id}(self, context)")
            lines.append("self.wait(1.0)")
            lines.append("self.next_slide()")
            lines.append("")
        return "\n".join(lines).rstrip()

    def _build_code_functions_text(self, code_functions_map: Dict[int, str]) -> str:
        if not code_functions_map:
            return ""
        keys = sorted(code_functions_map.keys())
        return "\n\n".join(code_functions_map[k].strip() for k in keys if code_functions_map[k].strip())

    def _get_function_code(self) -> str:
        fn_key = str(self.config.anime_info.get("visual_function", ""))
        fn_info = self.config.code_info.get(fn_key, {})
        return fn_info.get("whole", "") if isinstance(fn_info, dict) else ""

    def _get_block_context(self, block_id: int, block_index: int) -> Dict[str, Any]:
        block_entire = self._get_blocks_entire_entry(block_id, block_index)
        snippet = self._snippet_from_block_entire(block_entire)
        line = self._line_from_block_entire(block_entire)
        state_before, state_after = self._state_pair_from_frames(block_index)

        return {
            "snippet": snippet,
            "line": line,
            "state_before": state_before,
            "state_after": state_after,
        }

    def _get_blocks_entire_entry(self, block_id: int, block_index: int) -> Dict[str, Any]:
        blocks = self.config.blocks_entire_info.get("blocks", [])
        if not isinstance(blocks, list):
            return {}

        for item in blocks:
            if isinstance(item, dict) and int(item.get("id", -1)) == int(block_id):
                return item

        pos = block_index - 1
        if 0 <= pos < len(blocks) and isinstance(blocks[pos], dict):
            return blocks[pos]
        return {}

    def _snippet_from_block_entire(self, block_entire: Dict[str, Any]) -> str:
        method = str(block_entire.get("method") or self.config.anime_info.get("visual_function", ""))
        code_entry = self.config.code_info.get(method, {}) if method else {}
        whole = code_entry.get("whole", "") if isinstance(code_entry, dict) else ""
        cstart = self._to_int(block_entire.get("cstart"))
        cend = self._to_int(block_entire.get("cend"))
        if cstart is None or cend is None:
            return whole
        return extract_line_window(whole, cstart, cend)

    def _line_from_block_entire(self, block_entire: Dict[str, Any]) -> str:
        traces = self.config.trace_info.get("trace", [])
        if not isinstance(traces, list):
            return ""

        tstart = self._to_int(block_entire.get("tstart"))
        tend = self._to_int(block_entire.get("tend"))
        if tstart is None or tend is None:
            return ""
        low, high = (tstart, tend) if tstart <= tend else (tend, tstart)

        selected: List[Dict[str, Any]] = []
        for item in traces:
            if not isinstance(item, dict):
                continue
            pos = self._trace_pos(item)
            if pos is None or pos < low or pos > high:
                continue
            selected.append(item)

        if not selected:
            return ""

        base_depth = self._to_int(selected[0].get("depth"))
        flat = [x for x in selected if self._to_int(x.get("depth")) == base_depth]

        by_line: Dict[int, List[str]] = {}
        line_order: List[int] = []
        for item in flat:
            line_no = self._to_int(item.get("line"))
            event_type = str(item.get("event_type", "")).strip()
            if line_no is None or not event_type:
                continue
            if line_no not in by_line:
                by_line[line_no] = []
                line_order.append(line_no)
            if event_type not in by_line[line_no]:
                by_line[line_no].append(event_type)

        parts: List[str] = []
        for line_no in line_order:
            evs = by_line.get(line_no, [])
            if not evs:
                continue
            parts.append(", ".join(f"{line_no} {ev}" for ev in evs))

        return ";\n".join(parts)

    def _state_pair_from_frames(self, block_index: int) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        frames = self.config.frame_info.get("frames", [])
        if not isinstance(frames, list) or not frames:
            return {}, {}

        before_idx = block_index - 1
        after_idx = block_index
        if before_idx < 0 or after_idx >= len(frames):
            return {}, {}

        before = self._trim_frame(frames[before_idx])
        after = self._trim_frame(frames[after_idx])
        return before, after

    def _trim_frame(self, frame: Any) -> Dict[str, Any]:
        if not isinstance(frame, dict):
            return {}
        copied = json.loads(json.dumps(frame, ensure_ascii=False))
        variables = copied.get("variables")
        if isinstance(variables, dict) and "globals" in variables:
            variables.pop("globals", None)
        return copied

    def _image_inputs_for_phase(self, phase: str, block_ctx: Dict[str, Any]) -> Optional[List[str]]:
        if phase != "3_6":
            return None
        image = block_ctx.get("final_frame_image", "")
        if not image:
            state_after = block_ctx.get("state_after", {})
            if isinstance(state_after, dict):
                image = state_after.get("image", "")
        if isinstance(image, list):
            items = [str(i).strip() for i in image if str(i).strip()]
            return items or None
        if isinstance(image, str) and image.strip():
            return [image.strip()]
        return None

    def _prepare_preview_run(
        self,
        block_id: int,
        phase: str,
        attempt: int,
        script_before: str,
        current_code: str,
    ) -> Dict[str, Any]:
        preview_script = self._replace_code_functions(script_before, current_code)
        slides_path = self.config.work_dir / "slides.py"
        slides_path.write_text(preview_script, encoding="utf-8")

        cmd = ["manim-slides", "render", "slides.py", "VisualPilotScene"]
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(self.config.work_dir),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            returncode = proc.returncode
            stdout = proc.stdout
            stderr = proc.stderr
            exec_error = ""
        except OSError as exc:
            returncode = -1
            stdout = ""
            stderr = ""
            exec_error = str(exc)

        preview_info = {
            "phase": phase,
            "attempt": attempt,
            "block_id": block_id,
            "cwd": str(self.config.work_dir),
            "script": str(slides_path),
            "command": " ".join(cmd),
            "returncode": returncode,
            "stdout": stdout,
            "stderr": stderr,
            "exec_error": exec_error,
            "image_dir": str(self.config.preview_image_dir),
        }
        self.storage.write_json(
            f"blocks/block_{block_id}/preview/{phase}_attempt_{attempt}.json",
            preview_info,
        )
        return preview_info

    def _collect_preview_images(self, block_id: int) -> List[str]:
        target = self.config.preview_image_dir / f"block_{block_id}"
        if not target.exists() or not target.is_dir():
            return []

        files = sorted(
            [p for p in target.iterdir() if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        return [str(p) for p in files]

    def _get_user_feedback(self, block_id: int, attempt: int) -> str:
        # Reserved interface for external dialog integration.
        # The pipeline keeps this hook but does not implement the UI flow yet.
        _ = (block_id, attempt)
        return ""

    @staticmethod
    def _to_int(value: Any) -> Optional[int]:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _trace_pos(trace_item: Dict[str, Any]) -> Optional[int]:
        order = trace_item.get("order")
        if isinstance(order, int):
            return order
        trace_id = trace_item.get("id")
        if isinstance(trace_id, int):
            return trace_id
        return None

    def _write_current_state(
        self,
        current_elements: Optional[List[Any]] = None,
        current_timeline: Optional[List[Any]] = None,
        current_code: str = "",
    ) -> None:
        if current_elements is not None:
            self.storage.write_json("state/current_elements.json", current_elements)
        if current_timeline is not None:
            self.storage.write_json("state/current_timeline.json", current_timeline)
        if current_code:
            self.storage.write_text("state/current_code.py", current_code)

    def _write_manifest(self) -> None:
        manifest = {
            "started_at": dt.datetime.now().isoformat(timespec="seconds"),
            "stage": "step3",
            "max_refine_rounds": self.config.max_refine_rounds,
            "work_dir": str(self.config.work_dir),
            "run_dir": str(self.config.run_dir),
            "anime_json": str(self.config.anime_json),
            "frame_json": str(self.config.frame_json),
            "preview_image_dir": str(self.config.preview_image_dir),
        }
        self.storage.write_json("state/manifest_step3.json", manifest)


def make_config(args: argparse.Namespace) -> Step3Config:
    anime_json, anime_info, trace_info, code_info, _ = load_common_inputs_from_anime(Path(args.anime_json))

    if args.work_dir:
        work_dir = Path(args.work_dir)
        if not work_dir.is_absolute():
            work_dir = (PROJECT_ROOT / work_dir).resolve()
    else:
        work_dir = anime_json.parent / "design"

    frame_json = Path(args.frame_json)
    if not frame_json.is_absolute():
        frame_json = (PROJECT_ROOT / frame_json).resolve()
    if not frame_json.exists():
        raise PipelineError(f"frame json not found: {frame_json}")
    frame_info = json.loads(frame_json.read_text(encoding="utf-8"))

    if args.run_dir:
        run_dir = Path(args.run_dir)
        if not run_dir.is_absolute():
            run_dir = (work_dir / run_dir).resolve()
    else:
        latest = work_dir / "latest_run.txt"
        if not latest.exists():
            raise PipelineError("latest_run.txt not found. Please run step1-2 first or pass --run-dir")
        run_dir = Path(latest.read_text(encoding="utf-8").strip())

    if not run_dir.exists():
        raise PipelineError(f"run_dir not found: {run_dir}")

    bridge_path = run_dir / "state" / "bridge_step12_to_step3.json"
    if not bridge_path.exists():
        raise PipelineError(f"bridge file not found: {bridge_path}")
    bridge_info = json.loads(bridge_path.read_text(encoding="utf-8"))

    blocks_entire_rel = str(bridge_info.get("blocks_entire", "state/blocks_entire.json"))
    blocks_entire_path = run_dir / blocks_entire_rel
    if not blocks_entire_path.exists():
        raise PipelineError(f"blocks_entire file not found: {blocks_entire_path}")
    blocks_entire_info = json.loads(blocks_entire_path.read_text(encoding="utf-8"))

    if args.preview_image_dir:
        preview_image_dir = Path(args.preview_image_dir)
        if not preview_image_dir.is_absolute():
            preview_image_dir = (run_dir / preview_image_dir).resolve()
    else:
        preview_image_dir = run_dir / "blocks"

    return Step3Config(
        model=args.model,
        max_refine_rounds=max(0, args.max_refine_rounds),
        anime_json=anime_json,
        frame_json=frame_json,
        work_dir=work_dir,
        run_dir=run_dir,
        anime_info=anime_info,
        trace_info=trace_info,
        code_info=code_info,
        frame_info=frame_info,
        bridge_info=bridge_info,
        blocks_entire_info=blocks_entire_info,
        blocks_entire_path=blocks_entire_path,
        preview_image_dir=preview_image_dir,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run design engine step3 per-block only.")
    parser.add_argument("--model", default="gpt-4o-mini", help="Model name for OpenAI chat completions, or 'debug'")
    parser.add_argument("--max-refine-rounds", type=int, default=2)
    parser.add_argument(
        "--anime-json",
        default=str(PROJECT_ROOT / "__debug" / "anime" / "anime.json"),
        help="Path to __debug/anime/anime.json",
    )
    parser.add_argument(
        "--frame-json",
        default=str(PROJECT_ROOT / "__debug" / "trace" / "frame.json"),
        help="Path to __debug/trace/frame.json",
    )
    parser.add_argument("--run-dir", default="", help="Existing run dir produced by step1-2")
    parser.add_argument(
        "--preview-image-dir",
        default="",
        help="Directory for step3_6 preview screenshots (default: <run_dir>/blocks)",
    )
    parser.add_argument(
        "--work-dir",
        default="",
        help="Working directory for debug query/response and latest_run.txt (default: <anime_json_dir>/design)",
    )
    return parser.parse_args()


def run_stage3(args: argparse.Namespace) -> Path:
    config = make_config(args)
    Step3Runner(config).run()
    return config.run_dir


def main() -> int:
    args = parse_args()
    try:
        run_dir = run_stage3(args)
        print(f"\nStep3 completed. Output dir: {run_dir}")
        return 0
    except PipelineError as exc:
        print(f"\nStep3 failed: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
